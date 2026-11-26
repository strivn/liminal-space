// The page's data files: which page this is, where its files are, data/index.json and the month files.

import { FIELD_CAPS, hasText, isDay } from "../../shared/entry-checks.ts";
import { isJsonObject } from "../../shared/narrow.ts";
import { OPENALEX_CAPS } from "../../shared/openalex.ts";
import {
	INDEX_PATH,
	type IndexDay,
	type IndexEntry,
	type SearchEntry,
	type SearchFile,
	type SiteIndex,
	STUDY_WORDS_PATH,
} from "../../shared/site-data-shape.ts";

// The owner's page is the same page in the owner's folder, behind Cloudflare Access: it reads and saves read
// marks, tags and comments on the site. Anywhere else the page is the public page: entries
// only, and it never calls the site's API. The page knows which it is from where it was opened.
export function isOwnerPage() {
	if (typeof location === "undefined") return false;
	return (
		location.pathname.endsWith("/owner/") ||
		location.pathname.endsWith("/owner/index.html")
	);
}

// The address of one of the page's own files (data, images), relative to the page: the owner's page sits one folder
// below them.
export function siteFile(path: string) {
	if (isOwnerPage()) return `../${path}`;
	return path;
}

// Loads a month's lines (as its file holds them) the first time it is asked, and gives the same promise after that.
// A load that failed is forgotten, so the next ask tries again.
export type MonthLoader = (month: string) => Promise<unknown[]>;

// A file's answer: its status (0 when no answer came) and its JSON, or null when it isn't JSON.
type JsonAnswer = { status: number; json: unknown };

// Fetch a data file at an address relative to the page, so the page works under /liminal-space/.
export async function fetchJson(path: string): Promise<JsonAnswer> {
	let response: Response;
	try {
		response = await fetch(path);
	} catch {
		return { status: 0, json: null };
	}
	let json: unknown = null;
	try {
		json = await response.json();
	} catch {
		json = null;
	}
	return { status: response.status, json: json };
}

// data/index.json as the page can use it, or null when it isn't an index. A day is kept only with a date, a month
// with a file name, and a list of entries; within it, only entries with a text id and type.
export function readIndex(json: unknown): SiteIndex | null {
	if (
		!isJsonObject(json) ||
		!Array.isArray(json.days) ||
		!isJsonObject(json.months)
	) {
		return null;
	}
	// No prototype, so a month named "__proto__" or "constructor" is only ever one the index lists.
	const months: Record<string, string> = Object.create(null);
	for (const month of Object.keys(json.months)) {
		const name = json.months[month];
		if (typeof name === "string") {
			months[month] = name;
		}
	}
	const days: IndexDay[] = [];
	const listedDays: unknown[] = json.days;
	for (const day of listedDays) {
		if (!isJsonObject(day) || typeof day.date !== "string") continue;
		if (typeof day.month !== "string" || !Array.isArray(day.entries)) continue;
		if (months[day.month] === undefined) continue;
		const entries: IndexEntry[] = [];
		const listed: unknown[] = day.entries;
		for (const entry of listed) {
			if (!isJsonObject(entry) || typeof entry.id !== "string") continue;
			if (typeof entry.type !== "string") continue;
			const listed: IndexEntry = { id: entry.id, type: entry.type };
			if (typeof entry.study === "string" && STUDY_WORDS_PATH.test(entry.study))
				listed.study = entry.study;
			entries.push(listed);
		}
		days.push({ date: day.date, month: day.month, entries: entries });
	}
	return { days: days, months: months };
}

// The month loader for an index. A month file that answers 404 was replaced by a newer deploy: the page reads
// data/index.json once more and tries the month's new name.
export function createMonthLoader(index: SiteIndex): MonthLoader {
	let months = index.months;
	const loads = new Map<string, Promise<unknown[]>>();

	// One month's lines; throws when its file can't be read or isn't a month file.
	async function fetchMonth(month: string): Promise<unknown[]> {
		const name = months[month];
		if (name === undefined)
			throw new Error(`The index names no file for ${month}`);
		let answer = await fetchJson(siteFile(`data/${name}`));
		if (answer.status === 404) {
			const fresh = await fetchJson(siteFile(INDEX_PATH));
			const freshIndex = readIndex(fresh.json);
			if (fresh.status === 200 && freshIndex !== null) {
				months = freshIndex.months;
			}
			const newName = months[month];
			if (newName !== undefined && newName !== name) {
				answer = await fetchJson(siteFile(`data/${newName}`));
			}
		}
		const json = answer.json;
		if (
			answer.status !== 200 ||
			!isJsonObject(json) ||
			!Array.isArray(json.lines)
		) {
			throw new Error(`The file for ${month} couldn't be loaded`);
		}
		const lines: unknown[] = json.lines;
		return lines;
	}

	return (month: string) => {
		let pending = loads.get(month);
		if (pending === undefined) {
			pending = fetchMonth(month);
			loads.set(month, pending);
			// Forget a failed load, so the next ask fetches again; the caller still gets the failure.
			pending.catch(() => loads.delete(month));
		}
		return pending;
	};
}

// The search file as the page reads it; null when it is not the search shape.
export function readSearchFile(json: unknown): SearchFile | null {
	if (!isJsonObject(json) || !Array.isArray(json.entries)) return null;
	const entries: SearchEntry[] = [];
	const listed: unknown[] = json.entries;
	for (const entry of listed) {
		const kept = readSearchEntry(entry);
		if (kept !== null) entries.push(kept);
	}
	return { entries: entries };
}

// The index as search entries, bare.
export function searchEntriesOf(index: SiteIndex): SearchEntry[] {
	return index.days.flatMap((day) =>
		day.entries.map((entry) => ({
			id: entry.id,
			date: day.date,
			type: entry.type,
			topic: null,
			keywords: [],
			venue: null,
		})),
	);
}

function readSearchEntry(entry: unknown): SearchEntry | null {
	if (
		!isJsonObject(entry) ||
		!isCapped(entry.id, FIELD_CAPS.id) ||
		!isDay(entry.date) ||
		typeof entry.type !== "string" ||
		!Array.isArray(entry.keywords) ||
		entry.keywords.length > OPENALEX_CAPS.keywords
	) {
		return null;
	}
	const keywords: unknown[] = entry.keywords;
	if (!keywords.every((keyword) => isCapped(keyword, OPENALEX_CAPS.text))) {
		return null;
	}
	let topic: SearchEntry["topic"] = null;
	if (entry.topic !== null) {
		if (
			!isJsonObject(entry.topic) ||
			!isCapped(entry.topic.name, OPENALEX_CAPS.text) ||
			!isCapped(entry.topic.field, OPENALEX_CAPS.text)
		) {
			return null;
		}
		topic = { name: entry.topic.name, field: entry.topic.field };
	}
	if (entry.venue !== null && !isCapped(entry.venue, FIELD_CAPS.source)) {
		return null;
	}
	return {
		id: entry.id,
		date: entry.date,
		type: entry.type,
		topic: topic,
		keywords: keywords.filter((keyword) => typeof keyword === "string"),
		venue: entry.venue,
	};
}

export function isCapped(value: unknown, cap: number): value is string {
	return hasText(value) && value.length <= cap;
}
