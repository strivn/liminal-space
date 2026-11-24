// Link papers to published versions.
// Usage: node scripts/scout/proceedings/camera-ready.ts <digests file>         today's papers with a venue
//        node scripts/scout/proceedings/camera-ready.ts <digests file> --all   every paper with a venue and none yet
// Tests set INTERESTS_FILE, PROCEEDINGS_BASE.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { decodeHTML } from "entities";
import { isJsonObject, type JsonObject } from "../../../shared/narrow.ts";
import {
	type DigestsFile,
	readDigests,
	writeChangedLines,
} from "../../digests/digests-file.ts";
import { type Fail, failer, REPO } from "../../lib/cli.ts";
import { htmlToText } from "../../lib/html.ts";
import { request } from "../../lib/http.ts";
import { jakartaToday } from "../../lib/run-date.ts";
import { type ProceedingsLine, proceedingsLines } from "../plan/interests.ts";
import { normaliseTitle, titlesMatch } from "../plan/title-match.ts";

const fail: Fail = failer("camera-ready.ts");
const USAGE =
	"usage: node scripts/scout/proceedings/camera-ready.ts <digests file> [--all]";
const INTERESTS_FILE = process.env.INTERESTS_FILE || join(REPO, "interests.md");
// PMLR's file is 14 MB.
const FETCH_TIMEOUT_MS = 90_000;
// Crossref's anonymous limit: 1/s.
const CROSSREF_GAP_MS = Number(process.env.CROSSREF_GAP_MS ?? 1100);

export type ProceedingsFormat =
	| "pmlr-bib"
	| "anthology-bib"
	| "proceedings-listing"
	| "popets-index"
	| "oai-pmh"
	| "crossref";

// One listed proceedings paper.
export type PublishedPaper = { title: string; authors: string[]; url: string };

export function formatOf(fileUrl: string): ProceedingsFormat | null {
	const address = URL.parse(fileUrl);
	if (address === null) return null;
	const host = address.host;
	if (host === "proceedings.mlr.press") return "pmlr-bib";
	if (host === "aclanthology.org") return "anthology-bib";
	if (/^proceedings\.(neurips|iclr|colm)\.cc$/.test(host))
		return "proceedings-listing";
	if (host === "petsymposium.org") return "popets-index";
	if (host === "ojs.aaai.org") return "oai-pmh";
	if (host === "api.crossref.org") return "crossref";
	return null;
}

// Braces balanced, accents dropped.
function bibField(entry: string, name: string) {
	const start = entry.match(new RegExp(`\\n\\s*${name}\\s*=\\s*([{"])`, "i"));
	if (start === null || start.index === undefined) return "";
	const close = start[1] === "{" ? "}" : '"';
	let depth = 1;
	let value = "";
	for (const char of entry.slice(start.index + start[0].length)) {
		if (close === "}" && char === "{") depth += 1;
		if (char === close && (close === '"' || --depth === 0)) break;
		value += char;
	}
	return value
		.replace(/\\[`'"^~=.uvHckb]\s*\{?([A-Za-z])\}?/g, "$1")
		.replace(/[{}]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

// "Surname, Given and ..." as names.
function bibAuthors(field: string) {
	return field
		.split(/\s+and\s+/)
		.map((name) => {
			const [surname, given] = name.split(",").map((part) => part.trim());
			return given ? `${given} ${surname}` : (surname ?? "");
		})
		.filter((name) => name !== "");
}

function readBib(body: string) {
	const papers: PublishedPaper[] = [];
	for (const entry of body.split(/(?:^|\n)@/).slice(1)) {
		if (!/^inproceedings\s*\{/i.test(entry)) continue;
		const url = bibField(entry, "url");
		const title = bibField(entry, "title");
		if (!title || !url) continue;
		papers.push({
			title: title,
			authors: bibAuthors(bibField(entry, "author")),
			url: url,
		});
	}
	return papers;
}

// Proceedings sites' paper lists.
function readListing(body: string, fileUrl: string) {
	const papers: PublishedPaper[] = [];
	const item =
		/<a title="paper title" href="([^"]+)">([\s\S]*?)<\/a>\s*<span class="paper-authors">([\s\S]*?)<\/span>/g;
	for (const match of body.matchAll(item)) {
		papers.push({
			title: htmlToText(match[2] ?? "").trim(),
			authors: htmlToText(match[3] ?? "")
				.split(",")
				.map((name) => name.trim())
				.filter((name) => name !== ""),
			url: new URL(decodeHTML(match[1] ?? ""), fileUrl).href,
		});
	}
	return papers;
}

// PoPETs: title link, then italic authors.
function readPopets(body: string, fileUrl: string) {
	const papers: PublishedPaper[] = [];
	const item =
		/<b><a href="([^"]+\.php)">([\s\S]*?)<\/a><\/b>[\s\S]*?<i>([\s\S]*?)<\/i>/g;
	for (const match of body.matchAll(item)) {
		papers.push({
			title: htmlToText(match[2] ?? "").trim(),
			authors: htmlToText(match[3] ?? "")
				.replace(/\([^)]*\)/g, "")
				.split(",")
				.map((name) => name.trim())
				.filter((name) => name !== ""),
			url: new URL(match[1] ?? "", fileUrl).href,
		});
	}
	return papers;
}

// Dublin Core records over OAI-PMH.
function readOai(body: string) {
	const papers: PublishedPaper[] = [];
	for (const record of body.split("<record>").slice(1)) {
		const title = record.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/)?.[1];
		const page = [
			...record.matchAll(/<dc:identifier>(https:[^<]+)<\/dc:identifier>/g),
		]
			.map((match) => decodeHTML(match[1] ?? ""))
			.find((url) => /\/article\/view\/\d+$/.test(url));
		if (!title || !page) continue;
		const authors = [...record.matchAll(/<dc:creator>([^<]*)<\/dc:creator>/g)]
			.map((match) => decodeHTML(match[1] ?? "").trim())
			.map((name) => {
				const [surname, given] = name.split(",").map((part) => part.trim());
				return given ? `${given} ${surname}` : (surname ?? "");
			});
		papers.push({
			title: decodeHTML(title).trim(),
			authors: authors,
			url: page,
		});
	}
	return papers;
}

// Crossref works, as doi.org links.
function readCrossref(body: string) {
	const answer: unknown = JSON.parse(body);
	if (!isJsonObject(answer) || !isJsonObject(answer.message)) return [];
	const items = Array.isArray(answer.message.items)
		? answer.message.items
		: [answer.message];
	const papers: PublishedPaper[] = [];
	for (const item of items) {
		if (!isJsonObject(item) || typeof item.DOI !== "string") continue;
		const title = Array.isArray(item.title) ? item.title[0] : null;
		if (typeof title !== "string") continue;
		const authors = Array.isArray(item.author) ? item.author : [];
		papers.push({
			title: htmlToText(title).trim(),
			authors: authors
				.filter(isJsonObject)
				.map((author) => `${author.given ?? ""} ${author.family ?? ""}`.trim()),
			url: `https://doi.org/${item.DOI}`,
		});
	}
	return papers;
}

export function readProceedings(
	format: ProceedingsFormat,
	body: string,
	fileUrl: string,
): PublishedPaper[] {
	if (format === "pmlr-bib" || format === "anthology-bib") return readBib(body);
	if (format === "proceedings-listing") return readListing(body, fileUrl);
	if (format === "popets-index") return readPopets(body, fileUrl);
	if (format === "oai-pmh") return readOai(body);
	return readCrossref(body);
}

function nameWords(name: string) {
	return name
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.split(/[^\p{L}]+/u)
		.filter((word) => word !== "");
}

// Surnames may hold several words.
function hasAuthors(listed: string[], authors: string[], count: number) {
	const words = new Set(listed.flatMap(nameWords));
	const wanted = authors.slice(0, count).map((name) => nameWords(name).at(-1));
	return (
		wanted.length > 0 &&
		wanted.every((surname) => surname !== undefined && words.has(surname))
	);
}

// Exact title first, then close.
export function matchPublished(
	paper: { title: string; authors: string[] },
	published: PublishedPaper[],
): PublishedPaper | null {
	const title = normaliseTitle(paper.title);
	const exact = published.find(
		(listed) =>
			normaliseTitle(listed.title) === title &&
			hasAuthors(listed.authors, paper.authors, 1),
	);
	if (exact !== undefined) return exact;
	const twoAuthors = Math.min(2, paper.authors.length);
	return (
		published.find(
			(listed) =>
				titlesMatch(paper.title, listed.title) &&
				hasAuthors(listed.authors, paper.authors, twoAuthors),
		) ?? null
	);
}

// "ACL 2026 Findings" -> "ACL Findings 2026".
function editionOf(venue: string) {
	const year = venue.match(/\b(?:19|20)\d\d\b/)?.[0];
	if (year === undefined) return null;
	const name = venue.replace(year, "").replace(/\s+/g, " ").trim();
	return `${name} ${year}`;
}

// Its proceedings' site, or doi.org.
function isPublishedAddress(url: string, fileUrl: string) {
	const page = URL.parse(url);
	const file = URL.parse(fileUrl);
	if (page === null || file === null || page.protocol !== "https:")
		return false;
	if (page.username || page.password) return false;
	if (formatOf(fileUrl) === "crossref") return page.host === "doi.org";
	return page.host === file.host;
}

// Crossref works in one container.
function inContainer(body: string, container: string) {
	const answer: unknown = JSON.parse(body);
	if (!isJsonObject(answer) || !isJsonObject(answer.message)) return body;
	const items = Array.isArray(answer.message.items) ? answer.message.items : [];
	answer.message.items = items.filter(
		(item) =>
			isJsonObject(item) &&
			Array.isArray(item["container-title"]) &&
			item["container-title"][0] === container,
	);
	return JSON.stringify(answer);
}

type Target = { entry: JsonObject; index: number; edition: string };

// Papers with a venue and none yet.
function targetsIn(read: DigestsFile, all: boolean) {
	const today = jakartaToday();
	const targets: Target[] = [];
	for (const { index, digest } of read.digests) {
		if (!isJsonObject(digest) || !Array.isArray(digest.entries)) continue;
		if (!all && digest.date !== today) continue;
		for (const entry of digest.entries) {
			if (!isJsonObject(entry) || entry.type !== "paper") continue;
			if (typeof entry.venue !== "string" || entry.camera_ready !== undefined)
				continue;
			const edition = editionOf(entry.venue);
			if (edition !== null) targets.push({ entry, index, edition });
		}
	}
	return targets;
}

async function fetchText(url: string) {
	const base = process.env.PROCEEDINGS_BASE;
	const address = new URL(url);
	const from = base
		? new URL(address.pathname + address.search, base)
		: address;
	const answer = await request(from.href, { timeoutMs: FETCH_TIMEOUT_MS });
	if ("problem" in answer) return { problem: answer.problem };
	if (!answer.ok) return { problem: `answered HTTP ${answer.status}` };
	return { text: answer.text() };
}

async function main(args: string[]) {
	const [file, flag] = args;
	if (!file || (flag !== undefined && flag !== "--all") || args.length > 2) {
		fail(USAGE);
	}
	if (!existsSync(file)) fail(`${file} doesn't exist`);
	const lines = proceedingsLines(readFileSync(INTERESTS_FILE, "utf8"));
	const read = readDigests(file, (line, problem) =>
		fail(`line ${line} of ${file} ${problem}`),
	);
	const targets = targetsIn(read, flag === "--all");
	const unnamed = new Set<string>();
	const unread = new Set<string>();
	const changed = new Set<number>();
	// One fetch and parse per file.
	const listed = new Map<string, Promise<PublishedPaper[] | null>>();
	let crossrefTurn: Promise<unknown> = Promise.resolve();
	const fetchInTurn = (url: string, line: ProceedingsLine) => {
		if (formatOf(line.url) !== "crossref") return fetchText(url);
		const answer = crossrefTurn.then(() => fetchText(url));
		crossrefTurn = answer.then(() => pause(CROSSREF_GAP_MS));
		return answer;
	};
	const papersAt = (line: ProceedingsLine, url: string) => {
		const known =
			listed.get(url) ??
			fetchInTurn(url, line).then((body) => {
				const format = formatOf(line.url);
				if (body.text === undefined || format === null) {
					unread.add(`${line.url} not read: ${body.problem}`);
					return null;
				}
				const text = line.container
					? inContainer(body.text, line.container)
					: body.text;
				return readProceedings(format, text, line.url);
			});
		listed.set(url, known);
		return known;
	};
	const matches = await Promise.all(
		targets.map(async (target) => {
			const own = lines.filter((line) => line.venue === target.edition);
			if (own.length === 0) {
				unnamed.add(target.edition);
				return null;
			}
			const title = String(target.entry.title);
			const authors = Array.isArray(target.entry.authors)
				? target.entry.authors.map(String)
				: [];
			const lists = await Promise.all(
				own.map((line) =>
					papersAt(
						line,
						formatOf(line.url) === "crossref"
							? `${line.url}&query.bibliographic=${encodeURIComponent(title)}&rows=5`
							: line.url,
					),
				),
			);
			for (const [i, papers] of lists.entries()) {
				const line = own[i];
				if (papers === null || line === undefined) continue;
				const found = matchPublished({ title, authors }, papers);
				if (found !== null && isPublishedAddress(found.url, line.url)) {
					return { target, found, from: line.url };
				}
			}
			return null;
		}),
	);
	let filled = 0;
	for (const match of matches) {
		if (match === null) continue;
		match.target.entry.camera_ready = {
			url: match.found.url,
			venue: match.target.edition,
			from: match.from,
		};
		changed.add(match.target.index);
		filled += 1;
		console.log(`${match.target.entry.id} ${match.found.url}`);
	}
	if (changed.size > 0) {
		writeChangedLines(file, read, changed, (path, code) =>
			fail(`${path} not written: ${code ?? "unknown error"}`),
		);
	}
	for (const edition of unnamed) {
		console.error(`no proceedings line in interests.md for ${edition}`);
	}
	for (const problem of unread) {
		console.error(`${problem}; its papers wait for the next check`);
	}
	console.log(`published versions: ${filled} of ${targets.length} papers`);
}

if (import.meta.main) {
	await main(process.argv.slice(2));
}
