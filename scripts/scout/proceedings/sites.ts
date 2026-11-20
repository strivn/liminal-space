// The proceedings sites' pages and Crossref's records, read into the papers and entries the digests take.
import { decodeHTML } from "entities";
import { isHttpUrl } from "../../../shared/entry-checks.ts";
import { isJsonObject } from "../../../shared/narrow.ts";
import CONSTANTS from "../../lib/constants.json" with { type: "json" };
import { attribute, tagsNamed } from "../../lib/html.ts";
import { request } from "../../lib/http.ts";

// The proceedings' sites, each overridable for tests.
const POPETS_BASE = process.env.POPETS_BASE || "https://petsymposium.org";
const ACL_ANTHOLOGY_BASE =
	process.env.ACL_ANTHOLOGY_BASE || "https://aclanthology.org";
const AAAI_OJS_BASE = process.env.AAAI_OJS_BASE || "https://ojs.aaai.org";
// Crossref's works API, which holds the record each publisher registered for a DOI.
const CROSSREF_API = process.env.CROSSREF_API || "https://api.crossref.org";

// How a proceedings site lists its papers: PoPETs' volume page, the Anthology's volume pages, or AAAI's journal
// (Open Journal Systems), whose issue archive leads to each issue's page.
export type IndexFormat = "popets" | "anthology" | "ojs";

// The proceedings of one accepted-paper list: the publisher's name for an entry's source, the venue note
// ("PETS 2026"), the pages that list its papers, how they are written, and for an OJS archive the label its
// issues of that year carry ("AIES-26").
export type ProceedingsSite = {
	source: string;
	note: string;
	format: IndexFormat;
	indexUrls: string[];
	issueLabel: string | null;
};

// One paper of a proceedings index: its title and the address of its own page.
export type IndexPaper = { title: string; url: string };

// What a paper's own page says about it: title, authors, the date as precise as the page gives it ("2026",
// "2026-07" or "2026-10-11"), abstract, the PDF's address and the DOI, each null when the page has none.
export type PagePaper = {
	title: string;
	authors: string[];
	published: string;
	abstract: string;
	pdf: string | null;
	doi: string | null;
};

// A proceedings paper as proceedings.json keeps it and the digests receive it: its id, what its page says, the page's
// address, the publisher, the venue note and the list that names it accepted.
export type ProceedingsPaper = {
	id: string;
	title: string;
	authors: string[];
	published: string;
	abstract: string;
	url: string;
	pdf: string | null;
	source: string;
	note: string;
	venueSource: string;
};

// The proceedings of a list in interests.md's "Conferences" section, by its venue and the year in its address; null
// for a venue whose proceedings this script doesn't read.
export function proceedingsOf(
	venue: string,
	listUrl: string,
): ProceedingsSite | null {
	const found = listUrl.match(/20\d\d/);
	if (found === null) {
		return null;
	}
	const year = found[0];
	if (venue === "PETS") {
		return {
			source: "PoPETs",
			note: `PETS ${year}`,
			format: "popets",
			indexUrls: [`${POPETS_BASE}/popets/${year}/`],
			issueLabel: null,
		};
	}
	if (venue === "ACL") {
		return {
			source: "ACL Anthology",
			note: `ACL ${year}`,
			format: "anthology",
			indexUrls: [
				`${ACL_ANTHOLOGY_BASE}/volumes/${year}.acl-long/`,
				`${ACL_ANTHOLOGY_BASE}/volumes/${year}.acl-short/`,
			],
			issueLabel: null,
		};
	}
	if (venue === "ACL Findings") {
		return {
			source: "ACL Anthology",
			note: `ACL Findings ${year}`,
			format: "anthology",
			indexUrls: [`${ACL_ANTHOLOGY_BASE}/volumes/${year}.findings-acl/`],
			issueLabel: null,
		};
	}
	if (venue === "AIES") {
		return {
			source: "AAAI",
			note: `AIES ${year}`,
			format: "ojs",
			indexUrls: [`${AAAI_OJS_BASE}/index.php/AIES/issue/archive`],
			issueLabel: `AIES-${year.slice(2)}`,
		};
	}
	return null;
}

// HTML as plain text: tags removed, then entities decoded once, runs of whitespace collapsed.
function htmlText(html: string) {
	return decodeHTML(html.replace(/<[^>]*>/g, ""))
		.replace(/\s+/g, " ")
		.trim();
}

// An address on a page, made whole against the page's own address; null when it doesn't parse.
function absolute(href: string, pageUrl: string) {
	const parsed = URL.parse(decodeHTML(href), pageUrl);
	if (parsed === null) {
		return null;
	}
	return parsed.href;
}

// The papers a pattern finds on a page, the link in its first group and the title in its second. Only links to the
// page's own origin (scheme, host and port) are kept: search.ts fetches each one.
function linkedPapers(html: string, pattern: RegExp, pageUrl: string) {
	const origin = new URL(pageUrl).origin;
	const papers: IndexPaper[] = [];
	for (const match of html.matchAll(pattern)) {
		const url = absolute(match[1] || "", pageUrl);
		const title = htmlText(match[2] || "");
		if (url !== null && title !== "" && new URL(url).origin === origin) {
			papers.push({ title: title, url: url });
		}
	}
	return papers;
}

// The papers of one index page, in page order, read in the site's format; [] when the page holds none.
// PoPETs: <li><b><a href="../2026/popets-2026-0038.php">Title</a></b>; an item linking only a PDF (the editors'
// introduction) is left out. The Anthology: <strong><a class=align-middle href=/2026.acl-long.99/>Title</a></strong>,
// the title holding tags around some letters. OJS: <h3 class="title"><a id="article-43234" href="...">Title</a>.
export function indexPapers(
	format: IndexFormat,
	html: string,
	pageUrl: string,
): IndexPaper[] {
	if (format === "popets") {
		return linkedPapers(
			html,
			/<li><b><a href="([^"]+\.php)">([\s\S]*?)<\/a><\/b>/g,
			pageUrl,
		);
	}
	if (format === "anthology") {
		return linkedPapers(
			html,
			/<strong><a class=["']?align-middle["']? href=["']?([^"' >]+)["']?>([\s\S]*?)<\/a><\/strong>/g,
			pageUrl,
		);
	}
	return linkedPapers(
		html,
		/<h3 class="title">\s*<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g,
		pageUrl,
	);
}

// The issue pages of an OJS archive whose title holds `label` ("AIES-26"), in archive order.
export function ojsIssues(
	html: string,
	pageUrl: string,
	label: string,
): string[] {
	return linkedPapers(
		html,
		/<a class="title" href="([^"]+)">([\s\S]*?)<\/a>/g,
		pageUrl,
	)
		.filter((issue) => issue.title.includes(`(${label})`))
		.map((issue) => issue.url);
}

// Every <meta> tag of a page as [name, content], in page order, its attributes quoted or not and in any order.
// Read with html.ts's one-pass reader, so a page of tags that never close costs time in proportion to its size.
function metaTags(html: string) {
	const tags: [string, string][] = [];
	for (const tag of tagsNamed(html, ["meta"])) {
		const name = attribute(tag.text, "name");
		const content = attribute(tag.text, "content");
		if (name !== null && content !== null) {
			tags.push([name, htmlText(content)]);
		}
	}
	return tags;
}

// The contents of the meta tags named `name`, in page order.
function metaValues(tags: [string, string][], name: string) {
	return tags
		.filter((tag) => tag[0] === name && tag[1] !== "")
		.map((tag) => tag[1]);
}

// The first content among the meta tags of these names, in the order the names are given; null for none.
function firstMeta(tags: [string, string][], names: string[]) {
	for (const name of names) {
		const value = metaValues(tags, name)[0];
		if (value !== undefined) {
			return value;
		}
	}
	return null;
}

// A page's date as precise as it gives it: "2026/7" -> "2026-07", "2026/10/11" -> "2026-10-11", "2026" -> "2026";
// "" when it gives none.
function pageDate(value: string | null) {
	if (value === null) {
		return "";
	}
	const parts = value.match(/^(\d{4})(?:[/-](\d{1,2}))?(?:[/-](\d{1,2}))?/);
	if (parts === null) {
		return "";
	}
	let date = parts[1] || "";
	if (parts[2] !== undefined) {
		date += `-${parts[2].padStart(2, "0")}`;
	}
	if (parts[3] !== undefined) {
		date += `-${parts[3].padStart(2, "0")}`;
	}
	return date;
}

// A DOI without the resolver's address in front, as some pages write it.
function bareDoi(value: string) {
	return value.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
}

// What a paper's own page says, from its citation_* (Highwire) and DC.* meta tags and, where the site keeps the
// abstract in the body, its abstract block; null when the page names no title. The abstract is the citation_abstract
// or DC.Description tag (AAAI), else the Anthology's abstract block, else PoPETs' "Abstract:" paragraph. The DOI is
// the citation_doi or DC.Identifier.DOI tag, else PoPETs' "DOI:" link.
export function pagePaper(html: string, pageUrl: string): PagePaper | null {
	const tags = metaTags(html);
	const title = firstMeta(tags, ["citation_title", "DC.Title"]);
	if (title === null) {
		return null;
	}
	let authors = metaValues(tags, "citation_author");
	if (authors.length === 0) {
		authors = metaValues(tags, "DC.Creator.PersonalName");
	}
	let abstract = firstMeta(tags, ["citation_abstract", "DC.Description"]);
	if (abstract === null) {
		const block = html.match(
			/<div class="card-body acl-abstract">[\s\S]*?<span>([\s\S]*?)<\/span>/,
		);
		const paragraph = html.match(/<p><b>Abstract:<\/b>([\s\S]*?)<\/p>/);
		if (block !== null) {
			abstract = htmlText(block[1] || "");
		} else if (paragraph !== null) {
			abstract = htmlText(paragraph[1] || "");
		}
	}
	let pdf = firstMeta(tags, ["citation_pdf_url"]);
	if (pdf !== null) {
		pdf = absolute(pdf, pageUrl);
		// URL.parse takes "javascript:" and "data:" too; only a web address is written as the paper's PDF link.
		if (!isHttpUrl(pdf)) {
			pdf = null;
		}
	}
	let doi = firstMeta(tags, ["citation_doi", "DC.Identifier.DOI"]);
	if (doi === null) {
		const link = html.match(
			/<b>DOI:<\/b>\s*<a href="https?:\/\/(?:dx\.)?doi\.org\/(10\.[^"]+)"/,
		);
		if (link !== null) {
			doi = decodeHTML(link[1] || "");
		}
	}
	if (doi !== null) {
		doi = bareDoi(doi);
	}
	return {
		title: title,
		authors: authors,
		published: pageDate(
			firstMeta(tags, [
				"citation_publication_date",
				"citation_date",
				"DC.Date.issued",
			]),
		),
		abstract: abstract || "",
		pdf: pdf,
		doi: doi,
	};
}

// A paper's id: "doi:<doi>" when its page names a DOI, else "url:<its page>".
export function paperId(page: PagePaper, pageUrl: string): string {
	if (page.doi !== null) {
		return `doi:${page.doi}`;
	}
	return `url:${pageUrl}`;
}

// A proceedings paper's digests entry, keys in the order they are written: id, type, title, authors, published (only
// a whole YYYY-MM-DD date), source, url, links (its PDF), abstract, venue and venue_source.
export function proceedingsEntry(
	paper: ProceedingsPaper,
): Record<string, unknown> {
	const entry: Record<string, unknown> = {
		id: paper.id,
		type: "paper",
		title: paper.title,
		authors: paper.authors,
	};
	// The page shows a date only as a day; a year or a month alone is left out rather than made a day.
	if (/^\d{4}-\d{2}-\d{2}$/.test(paper.published)) {
		entry.published = paper.published;
	}
	entry.source = paper.source;
	entry.url = paper.url;
	if (paper.pdf !== null) {
		entry.links = [{ label: "PDF", url: paper.pdf }];
	}
	entry.abstract = paper.abstract;
	entry.venue = paper.note;
	entry.venue_source = paper.venueSource;
	return entry;
}

// The first string of a Crossref list field such as title or container-title, as plain text; "" when there is none.
function firstText(field: unknown) {
	if (!Array.isArray(field) || typeof field[0] !== "string") {
		return "";
	}
	return htmlText(field[0]);
}

// A Crossref author as a name: "Given Family", or the group's name when the record gives one ("The ... Consortium").
function authorName(author: unknown) {
	if (!isJsonObject(author)) {
		return "";
	}
	if (typeof author.name === "string") {
		return htmlText(author.name);
	}
	return htmlText(`${author.given || ""} ${author.family || ""}`);
}

// Crossref's published date as precise as the record gives it: [[2026, 10, 29]] -> "2026-10-29", [[2026, 10]] ->
// "2026-10", [[2026]] -> "2026"; null for none, or for parts that aren't numbers (Crossref writes [[null]] for some).
function crossrefDate(published: unknown) {
	if (!isJsonObject(published) || !Array.isArray(published["date-parts"])) {
		return null;
	}
	const parts = published["date-parts"][0];
	if (
		!Array.isArray(parts) ||
		parts.length === 0 ||
		parts.length > 3 ||
		!parts.every((part) => Number.isInteger(part))
	) {
		return null;
	}
	return parts.map((part) => String(part).padStart(2, "0")).join("-");
}

// A journal paper's digests entry from its Crossref record (the "message" of https://api.crossref.org/works/<doi>),
// keys in the order they are written: id, type, title, authors, published (only a whole day), source (the journal),
// url (the DOI's page), abstract (when the record has one, its JATS markup and "Abstract" heading left out). null when
// the record names no title or no author.
export function crossrefEntry(
	record: unknown,
	doi: string,
): Record<string, unknown> | null {
	if (!isJsonObject(record)) {
		return null;
	}
	const title = firstText(record.title);
	let authors: string[] = [];
	if (Array.isArray(record.author)) {
		authors = record.author.map(authorName).filter((name) => name !== "");
	}
	if (title === "" || authors.length === 0) {
		return null;
	}
	const entry: Record<string, unknown> = {
		id: `doi:${doi}`,
		type: "paper",
		title: title,
		authors: authors,
	};
	// A year or a month alone is left out rather than made a day.
	const published = crossrefDate(record.published);
	if (published !== null && published.length === "YYYY-MM-DD".length) {
		entry.published = published;
	}
	const journal = firstText(record["container-title"]);
	if (journal !== "") {
		entry.source = journal;
	}
	entry.url = `${CONSTANTS.doiBase}/${doi}`;
	if (typeof record.abstract === "string") {
		const abstract = htmlText(
			record.abstract.replace(/<jats:title>[\s\S]*?<\/jats:title>/g, ""),
		);
		if (abstract !== "") {
			entry.abstract = abstract;
		}
	}
	return entry;
}

// True when a date as precise as its record ("2026", "2026-11" or "2026-11-03") is after `day` (YYYY-MM-DD), compared
// as far as the date goes: "2026-11" is after 2026-10-31, "2026-10" is not after 2026-10-15.
export function publishedAfter(published: string, day: string): boolean {
	return published > day.slice(0, published.length);
}

// What one DOI's Crossref record gave: the entry with the record's date as precise as it is ("2026", "2026-10" or
// "2026-10-29", null for none), or why there is none: "not found" (Crossref answered 404), "incomplete" (no title or
// no author), or a problem in words that finish "Crossref ...".
export type CrossrefAnswer =
	| { entry: Record<string, unknown>; published: string | null }
	| { missing: "not found" | "incomplete" }
	| { problem: string };

// One DOI's record from Crossref, read as an entry. The DOI's parts are escaped one by one, so its "/" stays a "/".
export async function crossrefPaper(doi: string): Promise<CrossrefAnswer> {
	const url = `${CROSSREF_API}/works/${doi.split("/").map(encodeURIComponent).join("/")}`;
	const response = await request(url);
	if ("problem" in response) {
		return { problem: `${response.problem} (${url})` };
	}
	if (response.status === 404) {
		return { missing: "not found" };
	}
	if (!response.ok) {
		return { problem: `answered HTTP ${response.status} (${url})` };
	}
	let answer: unknown;
	try {
		answer = JSON.parse(response.text());
	} catch {
		return { problem: `answered with something that isn't JSON (${url})` };
	}
	if (!isJsonObject(answer)) {
		return { missing: "incomplete" };
	}
	const entry = crossrefEntry(answer.message, doi);
	if (entry === null || !isJsonObject(answer.message)) {
		return { missing: "incomplete" };
	}
	return { entry: entry, published: crossrefDate(answer.message.published) };
}
