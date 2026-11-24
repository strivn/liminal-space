// What the newsfeed's readers share: a source, the item it publishes, the problem that stops a read, and the text helpers.
import { decodeHTML } from "entities";
import { isUsableDescription } from "../../../shared/entry-checks.ts";
import { isJsonObject } from "../../../shared/narrow.ts";
import { request } from "../../lib/http.ts";

// A new source's first run, and any run, takes items from this far back; older ones were a past run's to take.
export const WINDOW_MS = 48 * 3600 * 1000;

export type Source = {
	name: string;
	kind: "feed" | "lesswrong" | "page" | "openrouter";
	type: string;
	url: string;
	// Page only: a regular expression the absolute URL of each post's link matches.
	links?: string;
	// OpenRouter only: the providers whose models are kept, each the start of a model id before its "/".
	providers?: string[];
	view?: "frontpage" | "offFrontpage";
	categories?: string[];
	// Items in any of these categories are left out, even when another of their categories is kept.
	excludeCategories?: string[];
	tags?: string[];
	// LessWrong only: posts with less karma are left out.
	minKarma?: number;
	// At most this many new items a run for the outlet (every source with this name): LessWrong's with the most
	// karma, any other outlet's picked at random. Without it, every new item.
	max?: number;
	// How long its requests may take; without it, constants.json's requestTimeoutMs.
	timeoutMs?: number;
};

// One item as a source published it, before the window and repeat checks.
export type Item = {
	title: string;
	url: string;
	at: Date;
	authors: string[];
	description: string;
	categories: string[];
	// LessWrong only: the post's karma when it was read.
	karma?: number;
};

export class ReadProblem extends Error {}

export function list(value: unknown): unknown[] {
	if (Array.isArray(value)) {
		return value;
	}
	if (value === undefined) {
		return [];
	}
	return [value];
}

// The text of a parsed XML value as the feed wrote it, markup and all.
export function rawText(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	if (isJsonObject(value) && typeof value["#text"] === "string") {
		return value["#text"];
	}
	if (Array.isArray(value)) {
		return rawText(value[0]);
	}
	return "";
}

// Markup removed, entities decoded, whitespace collapsed.
export function markupToText(text: string): string {
	const withoutMarkup = text.replace(/<[^>]*>/g, " ");
	return decodeHTML(decodeHTML(withoutMarkup)).replace(/\s+/g, " ").trim();
}

// The plain text of a parsed XML value: markup removed, entities decoded, whitespace collapsed.
export function plainText(value: unknown): string {
	return markupToText(rawText(value));
}

// The text of a field that may hold a post's HTML: its <p> elements when it has any, so headings are skipped; else
// all of it.
function bodyText(value: unknown): string {
	const html = rawText(value);
	const paragraphs = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)];
	if (paragraphs.length === 0) {
		return markupToText(html);
	}
	return paragraphs
		.map((match) => markupToText(match[1] || ""))
		.filter((text) => text !== "")
		.join(" ");
}

// The first of an item's description fields that says something; "" when none does.
export function usableDescription(fields: unknown[]): string {
	for (const field of fields) {
		const text = bodyText(field);
		if (isUsableDescription(text)) {
			return text;
		}
	}
	return "";
}

// The names in an author field: "A and B" and "A, B" as two names.
export function authorNames(values: unknown[]): string[] {
	const names: string[] = [];
	for (const value of values) {
		let text = plainText(value);
		if (isJsonObject(value) && value.name !== undefined) {
			text = plainText(value.name);
		}
		for (const name of text.split(/\s*,\s*|\s+and\s+/)) {
			if (name !== "") {
				names.push(name);
			}
		}
	}
	return names;
}

// One GET with this project's user agent and the given or default time limit; the body, or a ReadProblem saying
// what went wrong.
export async function download(
	url: string,
	timeoutMs?: number,
): Promise<string> {
	let options = {};
	if (timeoutMs !== undefined) {
		options = { timeoutMs: timeoutMs };
	}
	const answer = await request(url, options);
	if ("problem" in answer) {
		throw new ReadProblem(answer.problem);
	}
	if (!answer.ok) {
		throw new ReadProblem(`answered HTTP ${answer.status}`);
	}
	return answer.text();
}
