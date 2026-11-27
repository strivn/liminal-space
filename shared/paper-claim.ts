// What one paper without an arXiv id may hold when it comes from outside: the connector's add_papers and the file
// scripts/scout/web/paper.ts reads. Nothing from Node, so the Worker and the scripts read a claim the same way.
import { normalizeId } from "./arxiv-id.ts";
import {
	FIELD_CAPS,
	hasControlCharacter,
	MAX_AUTHORS,
} from "./entry-checks.ts";
import { isJsonObject } from "./narrow.ts";

// What the scout or the connector gives for one paper.
export type PaperClaim = {
	title: string;
	authors: string[];
	venue: string;
	url: string;
	doi?: string;
	abstract?: string;
};

// The longest DOI a claim may hold; the longest registered ones are about 150 characters.
export const MAX_DOI_CHARS = 200;

// A DOI without its "doi:" prefix or a resolver's address in front: "10.<registrant>/<suffix>".
const BARE_DOI = /^10\.\S+\/\S+$/;
// A DOI written as a link to the resolver.
const DOI_LINK = /^https?:\/\/(?:dx\.)?doi\.org\/(10\.\S+)$/i;

// The DOI a link to doi.org names, or null for anything else.
export function doiOfLink(text: string): string | null {
	return text.match(DOI_LINK)?.[1] ?? null;
}

// The arXiv paper a claim's address or DOI names ("the arXiv id 2507.11473", or "the arXiv address <url>"), or null
// for none.
export function arxivPaperOf(claim: Pick<PaperClaim, "url" | "doi">) {
	const fromDoi = claim.doi?.match(/^10\.48550\/arxiv\.(.+)$/i);
	if (fromDoi?.[1] !== undefined) {
		return `the arXiv id ${normalizeId(fromDoi[1])}`;
	}
	const page = URL.parse(claim.url);
	if (page === null || !/(^|\.)arxiv\.org$/i.test(page.hostname)) {
		return null;
	}
	const fromPath = page.pathname.match(/^\/(?:abs|pdf|html)\/(.+?)(?:\.pdf)?$/);
	if (fromPath?.[1] !== undefined) {
		return `the arXiv id ${normalizeId(fromPath[1])}`;
	}
	return `the arXiv address ${claim.url}`;
}

// Text of one line within a cap: non-empty, no control character.
function textProblem(name: string, value: unknown, cap: number) {
	if (typeof value !== "string" || value.trim() === "") {
		return `${name} must be text`;
	}
	if (value.length > cap) {
		return `${name} is over ${cap} characters`;
	}
	if (hasControlCharacter(value)) {
		return `${name} holds a control character`;
	}
	return null;
}

// Why a value isn't a paper's metadata, as reason phrases; [] when it is one. Only its shape and size: the page the
// url names, and the DOI, are checked by scripts/scout/web/paper.ts.
export function paperClaimProblems(value: unknown): string[] {
	if (!isJsonObject(value)) {
		return ["a paper must be an object"];
	}
	const problems: string[] = [];
	const checks = [
		textProblem("title", value.title, FIELD_CAPS.title),
		textProblem("venue", value.venue, FIELD_CAPS.source),
		textProblem("url", value.url, FIELD_CAPS.url),
	];
	if (value.doi !== undefined) {
		if (typeof value.doi === "string" && doiOfLink(value.doi) !== null) {
			checks.push("doi must be the DOI itself, not a link");
		} else if (typeof value.doi === "string" && !BARE_DOI.test(value.doi)) {
			checks.push("doi must look like 10.1145/3442188.3445922");
		} else {
			checks.push(textProblem("doi", value.doi, MAX_DOI_CHARS));
		}
	}
	if (value.abstract !== undefined) {
		if (typeof value.abstract !== "string") {
			checks.push("abstract must be text");
		} else if (value.abstract.length > FIELD_CAPS.abstract) {
			checks.push(`abstract is over ${FIELD_CAPS.abstract} characters`);
		}
	}
	if (
		!Array.isArray(value.authors) ||
		value.authors.length === 0 ||
		value.authors.length > MAX_AUTHORS
	) {
		checks.push(`authors must be a list of 1 to ${MAX_AUTHORS} names`);
	} else {
		for (const name of value.authors) {
			checks.push(textProblem("an author's name", name, FIELD_CAPS.authorName));
		}
	}
	for (const problem of checks) {
		if (problem !== null && !problems.includes(problem)) {
			problems.push(problem);
		}
	}
	const allowed = ["title", "authors", "venue", "url", "doi", "abstract"];
	const extra = Object.keys(value).filter((key) => !allowed.includes(key));
	if (extra.length > 0) {
		problems.push(`a paper doesn't take: ${extra.join(", ")}`);
	}
	return problems;
}

// The value as a PaperClaim, or the reasons it isn't one.
export function paperClaimOf(value: unknown): PaperClaim | string[] {
	const problems = paperClaimProblems(value);
	if (problems.length > 0 || !isJsonObject(value)) {
		return problems;
	}
	const { title, venue, url, authors, doi, abstract } = value;
	if (
		typeof title !== "string" ||
		typeof venue !== "string" ||
		typeof url !== "string" ||
		!Array.isArray(authors)
	) {
		return ["a paper must hold a title, authors, a venue and a url"];
	}
	const claim: PaperClaim = {
		title: title,
		authors: authors.map(String),
		venue: venue,
		url: url,
	};
	if (typeof doi === "string") {
		claim.doi = doi;
	}
	if (typeof abstract === "string") {
		claim.abstract = abstract;
	}
	return claim;
}
