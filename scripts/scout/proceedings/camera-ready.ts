// Link papers to published versions.
// Usage: node scripts/scout/proceedings/camera-ready.ts <digests file>         today's papers with a venue
//        node scripts/scout/proceedings/camera-ready.ts <digests file> --all   every paper with a venue and none yet
import { decodeHTML } from "entities";
import { isJsonObject } from "../../../shared/narrow.ts";
import { htmlToText } from "../../lib/html.ts";
import { normaliseTitle, titlesMatch } from "../plan/title-match.ts";

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
	for (const entry of body.split(/\n@/).slice(1)) {
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

if (import.meta.main) {
	throw new Error("not implemented");
}
