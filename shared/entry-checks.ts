// Checks on one digests line or entry, with nothing from Node, so the Worker can import them as well as the scripts.
// What the page needs to draw an entry, and the schema news, articles and reports follow (scripts/scout/scout.md).
import { isLabFigure } from "./lab-figures.ts";
import { isJsonObject, type JsonObject } from "./narrow.ts";

const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;
// The shortest real description held 11 words; "Introduction" and link lists held 1-3.
const USABLE_DESCRIPTION_WORDS = 8;
// The types add accepts. Papers come from scripts/scout/arxiv/arxiv.ts.
// Typed as unknown[] so includes() can test any field's value, which may be anything a digests line holds.
export const ADDED_TYPES: readonly unknown[] = ["news", "article", "report"];
// Every field an added entry may have, in the order they are written.
export const SCHEMA_KEYS = [
	"id",
	"type",
	"title",
	"authors",
	"published",
	"source",
	"url",
	"links",
	"description",
	"figure",
	"ad_hoc",
];
// Query parameters that only say where a reader came from. Any utm_* parameter is one too.
const TRACKING_PARAMETERS = ["fbclid", "gclid", "msclkid", "mc_cid", "mc_eid"];

// Caps on text fields.
export const FIELD_CAPS = {
	id: 2100,
	title: 500,
	source: 200,
	authorName: 200,
	abstract: 10_000,
	description: 20_000,
	linkLabel: 300,
	url: 2048,
};
export const MAX_AUTHORS = 1000;
export const MAX_LINKS = 50;
// Fields held to a cap.
const CAPPED_FIELDS = [
	["id", FIELD_CAPS.id],
	["title", FIELD_CAPS.title],
	["source", FIELD_CAPS.source],
	["abstract", FIELD_CAPS.abstract],
	["description", FIELD_CAPS.description],
	["url", FIELD_CAPS.url],
	["venue_source", FIELD_CAPS.url],
	["pick_source", FIELD_CAPS.url],
] as const;

// How entryProblems judges an entry: "add" for what add accepts, "check" for what check accepts.
type CheckMode = "add" | "check";
// Where JSON.parse stopped, read from V8's message "... in JSON at position 7 (line 1 column 8)": the offset counts
// from 0, line and column from 1. null when the message names no position, as in `Unexpected token 'S', "SECRET..."
// is not valid JSON`. Only the numbers are kept: that message quotes the text.
export function jsonErrorPosition(error: unknown) {
	// JSON.parse throws a SyntaxError, which always has a message.
	if (!(error instanceof Error)) {
		return null;
	}
	const match = error.message.match(
		/at position (\d+) \(line (\d+) column (\d+)\)$/,
	);
	if (match === null) {
		return null;
	}
	return {
		offset: Number(match[1]),
		line: Number(match[2]),
		column: Number(match[3]),
	};
}

// "digest({...});" -> the object inside; the final ";" may be missing. Throws when the line isn't one, with the
// message "doesn't load", plus " (at column <c>)" when JSON.parse says where it stopped. The message never quotes
// the line. What the line holds is unknown until a caller checks it.
export function parseLine(line: string): unknown {
	const match = line.match(/^digest\(([\s\S]*)\);?\s*$/);
	// The group always captures when the line matches; TypeScript can't tell, so both are checked.
	if (match === null || match[1] === undefined) {
		throw new Error("doesn't load");
	}
	try {
		return JSON.parse(match[1]);
	} catch (error) {
		const position = jsonErrorPosition(error);
		if (position === null) {
			throw new Error("doesn't load");
		}
		// The JSON starts after "digest(", the line's first 7 characters, and columns count from 1.
		// The offset, not V8's column: V8 starts a new line at a lone "\r", which a digests line may hold.
		throw new Error(`doesn't load (at column ${position.offset + 8})`);
	}
}

// A line of a digests file that doesn't load: its number and parseLine's words, so a script can name the file too.
// Its message is "line <n> doesn't load ...".
export class UnloadedLine extends Error {
	line: number;
	problem: string;
	constructor(line: number, problem: string) {
		super(`line ${line} ${problem}`);
		this.line = line;
		this.problem = problem;
	}
}

// One non-blank line of a digests text: what parseLine read from it, or the problem when it doesn't load.
export type DigestLine =
	| { number: number; digest: unknown; problem?: never }
	| { number: number; problem: string; digest?: never };

// Each non-blank line of a digests text: { number, digest }, or { number, problem } when the line doesn't load,
// the problem being parseLine's "doesn't load ...". number is the line's own in the file, counting from 1.
export function readLines(text: string) {
	const lines = text.split("\n");
	const result: DigestLine[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line === undefined || line.trim() === "") {
			continue;
		}
		try {
			result.push({ number: i + 1, digest: parseLine(line) });
		} catch (error) {
			// parseLine only throws the Errors it makes itself.
			if (!(error instanceof Error)) {
				throw error;
			}
			result.push({ number: i + 1, problem: error.message });
		}
	}
	return result;
}
// True for a string with something besides spaces in it.
export function hasText(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

// True for a description that says something: 8 or more words once URLs are taken out. A word holds a letter or a
// digit, so "•" or "—" is not one. Shared by newsfeed.ts and describe.ts.
export function isUsableDescription(text: string): boolean {
	const withoutUrls = text.replace(/https?:\/\/\S+/g, " ");
	const words = withoutUrls.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
	return words.length >= USABLE_DESCRIPTION_WORDS;
}

// True when a field gives nothing: absent, null, or a string of only spaces.
function isAbsent(value: unknown) {
	if (value === undefined || value === null) {
		return true;
	}
	return typeof value === "string" && value.trim() === "";
}

// True for a YYYY-MM-DD string naming a day that exists: "2026-02-30" is false.
// A day that doesn't exist either fails to parse or rolls over to another day, so the round trip catches both.
function isRealDate(text: string) {
	const date = new Date(`${text}T00:00:00Z`);
	if (Number.isNaN(date.getTime())) {
		return false;
	}
	return date.toISOString().slice(0, 10) === text;
}

// True for a string in the YYYY-MM-DD form that names a real day.
export function isDay(value: unknown): value is string {
	return (
		typeof value === "string" && DATE_FORMAT.test(value) && isRealDate(value)
	);
}

// True for a string holding a tab, a line break or another control character: the C0 range and DEL, the C1 range
// (U+0085 is "next line"), and the line and paragraph separators U+2028 and U+2029. Printed in a message, such a
// string could start a new line that reads as a message of its own.
export function hasControlCharacter(value: string) {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: finding control characters is the point of this check
	return /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value);
}

// The text without terminal escape sequences ("\x1b[2J") and without any other control character. A tab or a line
// break is dropped too, so collapse whitespace first where a break should read as a space.
export function withoutControlCharacters(text: string): string {
	// A whole sequence goes ("\x1b[2J"), not only its first character; then what is left of the C0 and C1 control
	// characters (U+0000 to U+001F, U+007F to U+009F). Written here, not with Node's util.stripVTControlCharacters:
	// this file is also the Worker's and the page's.
	return (
		text
			.replace(ESCAPE_SEQUENCE, "")
			// biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point
			.replace(/[\x00-\x1f\x7f-\x9f]/g, "")
	);
}

// A terminal escape sequence (ECMA-48): an operating system command, ESC ] ... ended by BEL or ESC \, or a control
// sequence, ESC [ or U+009B, then parameter bytes, intermediate bytes and one final byte.
const ESCAPE_SEQUENCE =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching escape sequences is the point
	/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g;

// The text cut to at most `max` characters at a word, ending in "…" when cut; a text that fits is given back whole.
// The cut falls at the last space among the first max - 1 characters; a text with no space there is cut where it is.
export function cutAtWord(text: string, max: number): string {
	if (text.length <= max) {
		return text;
	}
	const cut = text.slice(0, max - 1);
	const lastSpace = cut.lastIndexOf(" ");
	if (lastSpace > 0) {
		return `${cut.slice(0, lastSpace)}…`;
	}
	return `${cut}…`;
}

// True for a string that parses as an http or https URL. URL.parse returns null instead of throwing.
export function isHttpUrl(value: unknown): value is string {
	if (typeof value !== "string") {
		return false;
	}
	// URL.parse would drop tabs and line breaks silently and accept the rest, so any space or control character fails.
	if (/\s/.test(value) || hasControlCharacter(value)) {
		return false;
	}
	const parsed = URL.parse(value);
	if (parsed === null) {
		return false;
	}
	return parsed.protocol === "http:" || parsed.protocol === "https:";
}

// How a refused news, article or report is named: its url when that is a usable http or https url, else its title in
// double quotes, else `place` ("entry 3" in digests.ts add's items file, "link 3" in the connector's call). A url
// refused as not http or https (missing, ftp, holding a space or line break) is never printed: it can't say which entry
// it was, and the title can. A title holding a line break or other control character is passed over too, so the
// message stays one line.
export function linkLabel(item: unknown, place: string): string {
	if (!isJsonObject(item)) {
		return place;
	}
	if (isHttpUrl(item.url)) {
		return item.url;
	}
	if (hasText(item.title) && !hasControlCharacter(item.title)) {
		return `"${item.title}"`;
	}
	return place;
}

// True for a list of names: every item a string with text in it. An empty list passes.
function isNameList(value: unknown) {
	if (!Array.isArray(value)) {
		return false;
	}
	return value.every((name) => hasText(name));
}

// True for a query parameter that only tracks where a reader came from.
function isTrackingParameter(name: string) {
	const lower = name.toLowerCase();
	return lower.startsWith("utm_") || TRACKING_PARAMETERS.includes(lower);
}

// The form two URLs are compared in to find a repeat: http and https alike, host in lower case without a leading
// "www.", no fragment, no tracking parameters, one trailing slash on the path dropped. Other query parameters count.
// A string that isn't an http or https URL is compared as it is.
export function normalizeUrl(url: string): string {
	const parsed = URL.parse(url);
	if (
		parsed === null ||
		(parsed.protocol !== "http:" && parsed.protocol !== "https:")
	) {
		return url;
	}
	// URL has already lower-cased the host.
	const host = parsed.host.replace(/^www\./, "");
	let path = parsed.pathname;
	if (path.endsWith("/")) {
		path = path.slice(0, -1);
	}
	const kept = new URLSearchParams();
	for (const [name, value] of parsed.searchParams) {
		if (!isTrackingParameter(name)) {
			kept.append(name, value);
		}
	}
	let query = kept.toString();
	if (query !== "") {
		query = `?${query}`;
	}
	return `https://${host}${path}${query}`;
}

// The only fields a link holds. A link carrying more could carry text another script reads as its own: arxiv.ts
// finds the ids a file holds by its text, so a link with "id": "arxiv:..." made that paper count as already there.
const LINK_KEYS = ["label", "url"];

// What is wrong with a list of links, each phrase once: every link needs a label and a url, its url must be http or
// https, and it holds nothing else.
function linkProblems(links: unknown[]) {
	let unlabelled = false;
	let notHttp = false;
	let extraField = false;
	for (const link of links) {
		if (!isJsonObject(link) || !hasText(link.label) || !hasText(link.url)) {
			unlabelled = true;
			continue;
		}
		if (!isHttpUrl(link.url)) {
			notHttp = true;
		}
		if (Object.keys(link).some((key) => !LINK_KEYS.includes(key))) {
			extraField = true;
		}
	}
	const problems = [];
	if (unlabelled) {
		problems.push("every link needs a label and a url");
	}
	if (notHttp) {
		problems.push("a link's url must be http or https");
	}
	if (extraField) {
		problems.push('a link holds only "label" and "url"');
	}
	return problems;
}

// What is wrong with the fields of a new entry that are printed on a line of their own: a control character in one
// (a line break, an escape sequence) could start a line that reads as the script's or as the owner's. digests.ts status
// prints titles for the scout to read: a title "x\npapers today: 9" forged a line of it.
function controlCharacterProblems(entry: JsonObject) {
	const problems = [];
	if (typeof entry.title === "string" && hasControlCharacter(entry.title)) {
		problems.push("title holds a control character");
	}
	if (typeof entry.source === "string" && hasControlCharacter(entry.source)) {
		problems.push("source holds a control character");
	}
	if (
		Array.isArray(entry.authors) &&
		entry.authors.some(
			(name) => typeof name === "string" && hasControlCharacter(name),
		)
	) {
		problems.push("an author's name holds a control character");
	}
	return problems;
}

function isOver(value: unknown, cap: number) {
	return typeof value === "string" && value.length > cap;
}

// Over-cap fields, named.
function capProblems(entry: JsonObject) {
	const problems = [];
	for (const [field, cap] of CAPPED_FIELDS) {
		if (isOver(entry[field], cap)) {
			problems.push(`${field} is over ${cap} characters`);
		}
	}
	if (Array.isArray(entry.authors)) {
		if (entry.authors.length > MAX_AUTHORS) {
			problems.push(`authors holds more than ${MAX_AUTHORS} names`);
		}
		if (entry.authors.some((name) => isOver(name, FIELD_CAPS.authorName))) {
			problems.push(
				`an author's name is over ${FIELD_CAPS.authorName} characters`,
			);
		}
	}
	if (Array.isArray(entry.links)) {
		if (entry.links.length > MAX_LINKS) {
			problems.push(`links holds more than ${MAX_LINKS} links`);
		}
		for (const link of entry.links) {
			if (!isJsonObject(link)) {
				continue;
			}
			if (isOver(link.label, FIELD_CAPS.linkLabel)) {
				problems.push(
					`a link's label is over ${FIELD_CAPS.linkLabel} characters`,
				);
			}
			if (isOver(link.url, FIELD_CAPS.url)) {
				problems.push(`a link's url is over ${FIELD_CAPS.url} characters`);
			}
		}
	}
	if (isJsonObject(entry.figure)) {
		for (const field of ["src", "from"]) {
			if (isOver(entry.figure[field], FIELD_CAPS.url)) {
				problems.push(`figure.${field} is over ${FIELD_CAPS.url} characters`);
			}
		}
	}
	return problems;
}

// What is wrong with a news, article or report entry under the schema. In "check" mode the id is required,
// since add always writes one; in "add" mode it may be left out and is then filled in.
function schemaProblems(entry: JsonObject, mode: CheckMode) {
	const problems = [];
	if (entry.id === undefined) {
		if (mode === "check") {
			problems.push("id is missing");
		}
	} else if (typeof entry.url === "string" && entry.id !== `url:${entry.url}`) {
		problems.push("id doesn't match the url");
	}
	if (!ADDED_TYPES.includes(entry.type)) {
		problems.push("type must be news, article or report");
	}
	if (!hasText(entry.title)) {
		problems.push("title is missing");
	}
	if (entry.authors !== undefined && !isNameList(entry.authors)) {
		problems.push("authors must be a list of names");
	}
	if (isAbsent(entry.published)) {
		problems.push("published is missing");
	} else if (
		typeof entry.published !== "string" ||
		!DATE_FORMAT.test(entry.published)
	) {
		problems.push("published must be YYYY-MM-DD");
	} else if (!isRealDate(entry.published)) {
		problems.push("published is not a real date");
	}
	if (!hasText(entry.source)) {
		problems.push("source is missing");
	}
	if (isAbsent(entry.url)) {
		problems.push("url is missing");
	} else if (!isHttpUrl(entry.url)) {
		problems.push("url must be http or https");
	}
	if (entry.links !== undefined) {
		if (Array.isArray(entry.links)) {
			for (const problem of linkProblems(entry.links)) {
				problems.push(problem);
			}
		} else {
			problems.push("links must be a list");
		}
	}
	// Only what add and the connector take in: a stored entry is left as it is.
	if (mode === "add") {
		for (const problem of controlCharacterProblems(entry)) {
			problems.push(problem);
		}
	}
	if (
		entry.description !== undefined &&
		typeof entry.description !== "string"
	) {
		problems.push("description must be text");
	}
	if (entry.figure !== undefined) {
		for (const problem of labFigureProblems(entry, mode)) {
			problems.push(problem);
		}
	}
	// "ad_hoc" marks an entry added from a Claude app (digests.ts add --ad-hoc); it says so or is absent.
	if (entry.ad_hoc !== undefined && entry.ad_hoc !== true) {
		problems.push("ad_hoc must be true");
	}
	for (const key of Object.keys(entry)) {
		if (!SCHEMA_KEYS.includes(key)) {
			problems.push(`"${key}" is not in the schema`);
		}
	}
	for (const problem of capProblems(entry)) {
		problems.push(problem);
	}
	return problems;
}

// Where a figure the page shows comes from; site/page/entry.ts and figure.ts apply the same test.
const FIGURE_SITE = "https://arxiv.org/html/";

// What is wrong with a paper's figure: it holds the image's address under arXiv's HTML pages, and the page it was
// read from.
function figureProblems(figure: unknown) {
	if (!isJsonObject(figure)) {
		return ["figure must hold a src and where it is from"];
	}
	const problems = [];
	if (typeof figure.src !== "string" || !figure.src.startsWith(FIGURE_SITE)) {
		problems.push(`figure.src must start with ${FIGURE_SITE}`);
	}
	if (figure.from !== undefined && !isHttpUrl(figure.from)) {
		problems.push("figure.from must be http or https");
	}
	return problems;
}

function cameraReadyProblems(value: unknown) {
	if (!isJsonObject(value)) {
		return ["camera_ready must hold a url, a venue and where it was read"];
	}
	const problems = [];
	if (!isHttpUrl(value.url) || !value.url.startsWith("https:")) {
		problems.push("camera_ready.url must be https");
	}
	if (!hasText(value.venue)) {
		problems.push("camera_ready.venue is missing");
	}
	if (!isHttpUrl(value.from)) {
		problems.push("camera_ready.from must be http or https");
	}
	for (const field of ["url", "from"]) {
		if (isOver(value[field], FIELD_CAPS.url)) {
			problems.push(
				`camera_ready.${field} is over ${FIELD_CAPS.url} characters`,
			);
		}
	}
	return problems;
}

// Only post-figure.ts writes figures.
function labFigureProblems(entry: JsonObject, mode: CheckMode) {
	if (mode === "add") {
		return ["a figure comes from scripts/scout/web/post-figure.ts"];
	}
	const figure = entry.figure;
	if (!isJsonObject(figure)) {
		return ["figure must hold a src and where it is from"];
	}
	const problems = [];
	if (
		typeof entry.url !== "string" ||
		typeof figure.src !== "string" ||
		!isLabFigure(entry.url, figure.src)
	) {
		problems.push("figure.src must be an image address of the post's lab");
	}
	if (figure.from !== entry.url) {
		problems.push("figure.from must be the post's url");
	}
	for (const field of ["alt", "caption"]) {
		if (figure[field] !== undefined && typeof figure[field] !== "string") {
			problems.push(`figure.${field} must be text`);
		}
		if (isOver(figure[field], FIELD_CAPS.description)) {
			problems.push(
				`figure.${field} is over ${FIELD_CAPS.description} characters`,
			);
		}
	}
	return problems;
}

// What is wrong with a paper, or any entry that isn't news, an article or a report: what the page needs to draw it,
// and that every address it holds is a web address: its url, its links, where its venue and its pick were read, and
// its figure. The page links only http and https, but the Markdown and the connector print each address as it is.
// Other fields, such as a paper's abstract or venue, are allowed.
function pageProblems(entry: JsonObject) {
	const problems = [];
	if (!hasText(entry.id)) {
		problems.push("id is missing");
	}
	if (!hasText(entry.title)) {
		problems.push("title is missing");
	}
	if (!hasText(entry.type)) {
		problems.push("type is missing");
	}
	if (entry.published !== undefined && !isDay(entry.published)) {
		problems.push("published must be YYYY-MM-DD");
	}
	if (entry.authors !== undefined && !isNameList(entry.authors)) {
		problems.push("authors must be a list of names");
	}
	if (entry.url !== undefined && !isHttpUrl(entry.url)) {
		problems.push("url must be http or https");
	}
	if (entry.links !== undefined) {
		if (Array.isArray(entry.links)) {
			for (const problem of linkProblems(entry.links)) {
				problems.push(problem);
			}
		} else {
			problems.push("links must be a list");
		}
	}
	for (const field of ["venue_source", "pick_source"]) {
		if (entry[field] !== undefined && !isHttpUrl(entry[field])) {
			problems.push(`${field} must be http or https`);
		}
	}
	if (entry.camera_ready !== undefined) {
		for (const problem of cameraReadyProblems(entry.camera_ready)) {
			problems.push(problem);
		}
	}
	if (entry.figure !== undefined) {
		for (const problem of figureProblems(entry.figure)) {
			problems.push(problem);
		}
	}
	for (const problem of capProblems(entry)) {
		problems.push(problem);
	}
	return problems;
}

// What is wrong with one entry, as reason phrases; [] when nothing is.
// mode "add": what add accepts, which is news, articles and reports under the schema.
// mode "check": news, articles and reports under the same schema; any other entry, such as a paper, by the page's needs.
export function entryProblems(entry: unknown, mode: CheckMode): string[] {
	if (!isJsonObject(entry)) {
		return ["entry is not an object"];
	}
	if (mode === "add" && entry.type === "paper") {
		return ["papers come from scripts/scout/arxiv/arxiv.ts"];
	}
	if (mode === "add" || ADDED_TYPES.includes(entry.type)) {
		return schemaProblems(entry, mode);
	}
	return pageProblems(entry);
}
