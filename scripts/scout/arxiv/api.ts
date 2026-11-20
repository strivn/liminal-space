// arXiv's two legacy APIs: the paced request, the refusal record, and the Atom and OAI-PMH readers.
import { randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { decodeXML } from "entities";
import { XMLParser } from "fast-xml-parser";
import { isArxivId, normalizeId } from "../../../shared/arxiv-id.ts";
import { errorCode, isJsonObject } from "../../../shared/narrow.ts";
import CONSTANTS from "../../lib/constants.json" with { type: "json" };
import { request } from "../../lib/http.ts";
import CATEGORIES from "./categories.json" with { type: "json" }; // from https://arxiv.org/category_taxonomy

// The id checks live in arxiv-id.ts, which the Worker imports too; tests/unit/arxiv.test.ts reads them through here.
export { isArxivId, normalizeId };

export const OAI = process.env.ARXIV_OAI || CONSTANTS.arxivOai;
// arXiv's terms: one request every 3 seconds, one connection at a time (https://info.arxiv.org/help/api/tou.html).
// ARXIV_PAUSE_MS shortens it (tests only).
export const ARXIV_PAUSE_MS = Number(
	process.env.ARXIV_PAUSE_MS || CONSTANTS.arxivPauseMs,
);
// The folder under os.tmpdir() that keeps when this script's last request to arXiv ended, and the run's refusals.
const PACING_FOLDER = "liminal-arxiv-pacing";
// arXiv's terms count one request every 3 seconds across "the legacy APIs (including OAI-PMH, RSS, and the arXiv API)"
// (https://info.arxiv.org/help/api/tou.html), so every address this script asks shares one record.
const PACING_RECORD = "legacy-apis";

// A link on an entry, such as a paper's PDF.
export type Link = { label: string; url: string };

// One paper entry as this script writes it into a digests line, keys in the order they are written.
// source, url, links and abstract are always set, but after the object is made, so that category can come between
// source and url; the rest are set only when there is something to say.
export type Paper = {
	id: string;
	type: "paper";
	title: string;
	authors: string[];
	published: string;
	source?: string;
	category?: string;
	url?: string;
	links?: Link[];
	abstract?: string;
	journal_ref?: string;
	comment?: string;
	pick?: string;
	pick_source?: string;
	venue?: string;
	venue_source?: string;
	ad_hoc?: true;
};

// What arxivRequest gives when arXiv answered: the status and the body it sent.
export type ArxivResponse = {
	url: string;
	status: number;
	ok: boolean;
	body: string;
	problem?: never;
};

// What arxivRequest gives when no answer came: problem says why, such as "gave no answer within 30 seconds".
type ArxivNoAnswer = {
	url: string;
	problem: string;
	status?: never;
	ok?: never;
	body?: never;
};

// One request's outcome; check `problem` (or `ok`) to tell which.
export type ArxivAnswer = ArxivResponse | ArxivNoAnswer;

// One request arXiv refused (HTTP 429 or 503), as the refusal record keeps it: when its answer came (an ISO time),
// the service it went to, the status, and the URL's path.
export type Refusal = {
	time: string;
	service: "arXiv API" | "OAI-PMH";
	status: number;
	path: string;
};

// "cs.AI" -> "Artificial Intelligence"; unknown codes stay as they are.
export function categoryName(code: string): string {
	// Seen as a plain name table, so any code can be looked up; an unknown one gives undefined.
	const names: Record<string, string> = CATEGORIES;
	return names[code] || code;
}

// arXiv answers a malformed id with HTTP 400 and an error entry ".../api/errors#incorrect_id_format_for_<id>".
// Returns that id, or null when the error names none.
export function rejectedId(xml: string): string | null {
	const match = xml.match(/#incorrect_id_format_for_([^<\s]+)/);
	if (match === null || match[1] === undefined) {
		return null;
	}
	return match[1];
}

// XML text -> plain text: every XML entity decoded once (so "&amp;lt;" becomes "&lt;"), runs of whitespace collapsed.
export function text(xml: string) {
	return decodeXML(xml).replace(/\s+/g, " ").trim();
}

// First match of an element's content inside one <entry>.
export function field(entry: string, tag: string) {
	const match = entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
	if (match === null || match[1] === undefined) {
		return "";
	}
	return match[1];
}

// Add a paper's source and primary category to the entry being built, after its date and before its url
// (JSON.stringify writes keys in the order they were set). "cs.AI" gives source "arXiv Artificial Intelligence" and
// category "cs.AI"; a paper whose primary category arXiv doesn't name gets source "arXiv" and no category key.
function addCategory(paper: Paper, primary: string | undefined) {
	if (!primary) {
		paper.source = "arXiv";
		return;
	}
	paper.source = `arXiv ${categoryName(primary)}`;
	// The code too, since some names are shared: cs.LG and stat.ML are both "Machine Learning".
	paper.category = primary;
}

// What both arXiv sources say about one paper, as plain text; journalRef and comment are "" when arXiv has nothing.
type PaperFields = {
	id: string;
	title: string;
	authors: string[];
	published: string;
	primary: string | undefined;
	abstract: string;
	journalRef: string;
	comment: string;
};

// One paper's digest entry, keys in the order JSON.stringify writes them: id, type, title, authors, published, source
// and category, url, links, abstract, then where the paper is published and the authors' comment, each left out when
// arXiv has nothing.
function paperEntry(fields: PaperFields): Paper {
	const paper: Paper = {
		id: `arxiv:${fields.id}`,
		type: "paper",
		title: fields.title,
		authors: fields.authors,
		published: fields.published,
	};
	addCategory(paper, fields.primary);
	paper.url = `https://arxiv.org/abs/${fields.id}`;
	paper.links = [{ label: "PDF", url: `https://arxiv.org/pdf/${fields.id}` }];
	paper.abstract = fields.abstract;
	if (fields.journalRef) {
		paper.journal_ref = fields.journalRef;
	}
	if (fields.comment) {
		paper.comment = fields.comment;
	}
	return paper;
}

// Entities and whitespace are left as written: text() decodes them, once, as it did when the XML was read by pattern.
const PARSER = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: "@",
	parseTagValue: false,
	trimValues: false,
	processEntities: false,
});

// A document's elements, or undefined for text the parser can't read as XML (a proxy's HTML page, say).
function readXml(xml: string): unknown {
	try {
		return PARSER.parse(xml);
	} catch {
		return undefined;
	}
}

// The elements below a path of names in an XML document; undefined when the path isn't there. Several elements of one
// name give the first.
function xmlAt(node: unknown, ...path: string[]): unknown {
	let found = node;
	for (const name of path) {
		if (!isJsonObject(found)) {
			return undefined;
		}
		found = found[name];
		if (Array.isArray(found)) {
			found = found[0];
		}
	}
	return found;
}

// The elements of one name below a node, in document order; none when there is none.
function xmlList(node: unknown, name: string): unknown[] {
	if (!isJsonObject(node)) {
		return [];
	}
	const found = node[name];
	if (Array.isArray(found)) {
		return found;
	}
	if (found === undefined) {
		return [];
	}
	return [found];
}

// An element's text as written: the string itself, or the text of an element that carries attributes; "" when none.
function xmlText(node: unknown): string {
	if (typeof node === "string") {
		return node;
	}
	if (isJsonObject(node) && typeof node["#text"] === "string") {
		return node["#text"];
	}
	return "";
}

// An element's attribute as written; undefined when the element has none by that name.
function xmlAttribute(node: unknown, name: string): string | undefined {
	if (isJsonObject(node) && typeof node[`@${name}`] === "string") {
		return node[`@${name}`] as string;
	}
	return undefined;
}

// Atom feed from arXiv's API -> digest entries, in feed order.
export function parseFeed(xml: string): Paper[] {
	return xmlList(xmlAt(readXml(xml), "feed"), "entry").map((entry) => {
		const id = normalizeId(
			xmlText(xmlAt(entry, "id")).replace(/^https?:\/\/arxiv\.org\/abs\//, ""),
		);
		const primary = xmlAttribute(
			xmlAt(entry, "arxiv:primary_category"),
			"term",
		);
		return paperEntry({
			id: id,
			title: text(xmlText(xmlAt(entry, "title"))),
			authors: xmlList(entry, "author")
				.filter((author) => xmlAt(author, "name") !== undefined)
				.map((author) => text(xmlText(xmlAt(author, "name")))),
			published: xmlText(xmlAt(entry, "published")).slice(0, 10), // first version's date
			primary: primary || undefined,
			abstract: text(xmlText(xmlAt(entry, "summary"))),
			// Where the paper is published, as the authors gave it.
			journalRef: text(xmlText(xmlAt(entry, "arxiv:journal_ref"))),
			comment: text(xmlText(xmlAt(entry, "arxiv:comment"))),
		});
	});
}

// OAI-PMH GetRecord answers for one paper -> the entry parseFeed would build from the API.
// The "arXiv" format holds the metadata; only "arXivRaw" holds each version's date, and published is the first's.
export function parseOaiRecord(
	arxivXml: string,
	rawXml: string,
	id: string,
): Paper {
	id = normalizeId(id);
	const record = xmlAt(
		readXml(arxivXml),
		"OAI-PMH",
		"GetRecord",
		"record",
		"metadata",
		"arXiv",
	);
	const authors = xmlList(xmlAt(record, "authors"), "author").map((author) => {
		const parts = [
			xmlText(xmlAt(author, "forenames")),
			xmlText(xmlAt(author, "keyname")),
			xmlText(xmlAt(author, "suffix")),
		];
		return parts
			.map((part) => text(part))
			.filter((part) => part !== "")
			.join(" ");
	});
	// OAI-PMH lists the primary category first: "cs.CV cs.AI cs.LG"; "" when the record lists none.
	const primary = text(xmlText(xmlAt(record, "categories"))).split(" ")[0];
	// "Thu, 27 Nov 1997 23:53:13 GMT" -> "1997-11-27", in UTC like the API's dates; "" when there is no readable v1 date.
	const versions = xmlList(
		xmlAt(
			readXml(rawXml),
			"OAI-PMH",
			"GetRecord",
			"record",
			"metadata",
			"arXivRaw",
		),
		"version",
	);
	const firstVersion = versions.find(
		(version) => xmlAttribute(version, "version") === "v1",
	);
	let published = "";
	const date = new Date(xmlText(xmlAt(firstVersion, "date")));
	if (!Number.isNaN(date.getTime())) {
		published = date.toISOString().slice(0, 10);
	}

	return paperEntry({
		id: id,
		title: text(xmlText(xmlAt(record, "title"))),
		authors: authors,
		published: published,
		primary: primary,
		abstract: text(xmlText(xmlAt(record, "abstract"))),
		journalRef: text(xmlText(xmlAt(record, "journal-ref"))),
		comment: text(xmlText(xmlAt(record, "comments"))),
	});
}

// OAI-PMH reports problems with HTTP 200 and <error code='...'>reason</error>; returns { code, reason } or null.
export function oaiError(xml: string) {
	const error = xmlAt(readXml(xml), "OAI-PMH", "error");
	const code = xmlAttribute(error, "code");
	if (code === undefined || code === "") {
		return null;
	}
	return { code: code, reason: text(xmlText(error)) };
}

// When the last request to arXiv ended, so the next one can start 3 seconds later.
let lastRequestEnded = 0;

// The file every refused request is appended to, next to the pacing record: <tmp>/liminal-arxiv-pacing/refusals. On a
// GitHub runner the fill step and the scout's own commands share os.tmpdir(), so one run's refusals land in one file,
// which scout.ts lists in the run's log and then removes. os.tmpdir() is read at call time, so it follows TMPDIR.
export function refusalRecord(): string {
	return join(tmpdir(), PACING_FOLDER, "refusals");
}

// Append one refusal to the record, as one JSON line. O_NOFOLLOW refuses a link planted at the record's name instead of
// writing through it. Throws when the record can't be written.
export function recordRefusal(file: string, refusal: Refusal): void {
	// 0o700: only this user can list the folder or add files to it. An existing folder is left as it is.
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const flags =
		constants.O_WRONLY |
		constants.O_APPEND |
		constants.O_CREAT |
		constants.O_NOFOLLOW;
	const descriptor = openSync(file, flags, 0o600);
	try {
		writeSync(descriptor, `${JSON.stringify(refusal)}\n`);
	} finally {
		closeSync(descriptor);
	}
}

// The refusals a record holds, in the order they were kept; none when there is no record. A line that isn't a refusal
// is left out. Throws when the record exists but can't be read, or isn't a regular file (a link is never followed).
export function readRefusals(file: string): Refusal[] {
	if (!existsSync(file) && !isLink(file)) {
		return [];
	}
	if (!lstatSync(file).isFile()) {
		throw new Error(`${file} is not a regular file`);
	}
	const refusals: Refusal[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		let value: unknown = null;
		try {
			value = JSON.parse(line);
		} catch {
			continue;
		}
		if (isRefusal(value)) {
			refusals.push(value);
		}
	}
	return refusals;
}

// True when something at `file` is a symbolic link; existsSync follows links, so a dangling one reads as missing.
function isLink(file: string) {
	try {
		return lstatSync(file).isSymbolicLink();
	} catch {
		return false;
	}
}

// True when a parsed line holds a refusal as recordRefusal writes it.
function isRefusal(value: unknown): value is Refusal {
	return (
		isJsonObject(value) &&
		typeof value.time === "string" &&
		!Number.isNaN(Date.parse(value.time)) &&
		(value.service === "arXiv API" || value.service === "OAI-PMH") &&
		typeof value.status === "number" &&
		typeof value.path === "string"
	);
}

// Keep a refused request in the refusal record; one stderr line when it can't be kept, and the request goes on.
function keepRefusal(url: string, status: number) {
	let service: Refusal["service"] = "arXiv API";
	if (url.startsWith(OAI)) {
		service = "OAI-PMH";
	}
	const file = refusalRecord();
	try {
		recordRefusal(file, {
			time: new Date().toISOString(),
			service: service,
			status: status,
			path: new URL(url).pathname,
		});
	} catch (error) {
		console.error(
			`arxiv.ts: can't keep the refusal in ${file} (${errorCode(error)})`,
		);
	}
}

// The file that keeps when the last request to any of arXiv's legacy APIs ended, for every run of this script:
// <tmp>/liminal-arxiv-pacing/legacy-apis. os.tmpdir() is read here, at request time, so it follows TMPDIR as it is now.
function pacingRecord() {
	return join(tmpdir(), PACING_FOLDER, PACING_RECORD);
}

// The end time a record holds, in milliseconds; 0 (no wait) when there is no record or it isn't a number.
function recordedEnd(record: string) {
	let recorded: number;
	try {
		// Only a regular file counts. lstat looks at the name itself, so a link counts as no record instead of being
		// followed; a named pipe would also never finish reading.
		if (!lstatSync(record).isFile()) {
			return 0;
		}
		recorded = Number(readFileSync(record, "utf8").trim());
	} catch {
		return 0;
	}
	if (!Number.isFinite(recorded)) {
		return 0;
	}
	return recorded;
}

// Keep `endTime` as the record's text, never writing through a link planted at the record's name: the time goes into
// a new file with a name no one can guess, which rename then moves onto the record's name, replacing whatever is
// there (a link included) without opening it. Throws when the record can't be written.
function writeRecord(record: string, endTime: number) {
	const folder = dirname(record);
	// 0o700: only this user can list the folder or add files to it. An existing folder is left as it is.
	mkdirSync(folder, { recursive: true, mode: 0o700 });
	// 16 random hex digits.
	const temporary = join(
		folder,
		`${basename(record)}.${randomBytes(8).toString("hex")}`,
	);
	// 'wx' creates the file and refuses when anything, a link included, has that name.
	writeFileSync(temporary, String(endTime), { flag: "wx" });
	try {
		renameSync(temporary, record);
	} catch (error) {
		// Something rename can't replace has the record's name, such as a folder: remove the temporary file, then fail.
		unlinkSync(temporary);
		throw error;
	}
}

// One GET to arXiv, at least 3 s after the previous request to any of its legacy APIs ended, in this run or an
// earlier one, with a 30 s limit. An answer of HTTP 429 or 503 is kept in the refusal record.
// Returns { url, status, ok, body }, or { url, problem } when no answer came: "gave no answer within 30 seconds"
// or "could not be reached (ENOTFOUND)". Exported so a later arXiv script can share the pacing instead of copying it.
export async function arxivRequest(url: string): Promise<ArxivAnswer> {
	const record = pacingRecord();
	const previousEnd = Math.max(lastRequestEnded, recordedEnd(record));
	let waitMs = previousEnd + ARXIV_PAUSE_MS - Date.now();
	// An end time is never later than now, so a real record asks for 3 s at most. A longer wait comes from a record
	// written with the clock set ahead or a damaged file, and would stall the run (or, past 24.8 days, Node fires the
	// timer at once).
	if (waitMs > ARXIV_PAUSE_MS) {
		waitMs = ARXIV_PAUSE_MS;
	}
	if (waitMs > 0) {
		await pause(waitMs);
	}
	try {
		const answer = await request(url);
		if ("problem" in answer) {
			return { url: url, problem: answer.problem };
		}
		if (answer.status === 429 || answer.status === 503) {
			keepRefusal(url, answer.status);
		}
		return {
			url: url,
			status: answer.status,
			ok: answer.ok,
			body: answer.text(),
		};
	} finally {
		lastRequestEnded = Date.now();
		// Written before returning, so a run that starts right after this one exits finds it. A record that can't be
		// written only loses the pacing across runs; this run still paces itself through lastRequestEnded.
		try {
			writeRecord(record, lastRequestEnded);
		} catch {
			// ignored on purpose, see above
		}
	}
}

// What went wrong with an answer, in words that finish "arXiv API ..." or "OAI-PMH ...".
// A short plain-text body is arXiv's own explanation, e.g. answered HTTP 429 "Rate exceeded.".
export function whatHappened(answer: ArxivAnswer, expected: string): string {
	// problem is never an empty string, so this is the same as a truthiness check, and TypeScript can follow it.
	if (answer.problem !== undefined) {
		return answer.problem;
	}
	if (answer.ok) {
		// text() keeps the quoted start on one line, so the message stays one line.
		return `answered with something that isn't ${expected} (starts "${text(answer.body).slice(0, 40)}")`;
	}
	const said = answer.body.trim();
	if (said !== "" && said.length <= 100 && !said.includes("<")) {
		return `answered HTTP ${answer.status} "${said}"`;
	}
	return `answered HTTP ${answer.status}`;
}

// The API failed when it gave no usable answer: no answer, 429, any 5xx, or a 200 that isn't an Atom feed
// (a Wi-Fi login page, a proxy). A 400 is arXiv rejecting an id, handled by the caller.
export function apiFailed(answer: ArxivAnswer): boolean {
	// problem is never an empty string, so this is the same as a truthiness check, and TypeScript can follow it.
	if (answer.problem !== undefined) {
		return true;
	}
	if (answer.status === 429 || answer.status >= 500) {
		return true;
	}
	return answer.ok && !answer.body.includes("<feed");
}
