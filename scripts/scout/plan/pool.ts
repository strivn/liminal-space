// The candidate pool (pool.json): what the searches and lists add to it, and the candidate lines it prints.
import { isArxivId, normalizeId } from "../../../shared/arxiv-id.ts";
import { isJsonObject } from "../../../shared/narrow.ts";
import { daysBefore } from "../../lib/run-date.ts";
import type { Paper } from "../arxiv/api.ts";
import type { Lookup, ReadList } from "../arxiv/search.ts";
import { keptId, TITLE_CHARS } from "../arxiv/search.ts";
import type { HuggingFacePaper } from "../hugging-face/hugging-face.ts";
import type { Topic } from "./interests.ts";
import { cut } from "./interests.ts";
import { readKept, writeKept } from "./kept.ts";
import { normaliseTitle, phraseMatches } from "./title-match.ts";

const NOTE_CHARS = 60;
// A candidate stays in the pool for this many days after a search first found it.
const POOL_DAYS = 60;
// Each topic prints at most this many candidates, fewer when the whole output would pass OUTPUT_CHARS.
const POOL_LINES = 40;
const OUTPUT_CHARS = 30000;
// A line Jev scored with less confidence than this ends with " ?".
const DOUBTFUL_BELOW = 0.5;

// One candidate of pool.json, by its arXiv id without "arxiv:": what arXiv said about the paper, the topics whose
// searches found it, and the day (Asia/Jakarta) a search first found it; its upvotes when it is on Hugging Face's lists.
// Once scripts/scout/score.ts has scored it: Jev's score (0 to 4), its confidence, the topic probabilities, the weighted
// score and the day it was scored.
export type PoolRecord = {
	id: string;
	title: string;
	abstract: string;
	authors: string[];
	published: string;
	note: string | null;
	topics: number[];
	firstSeen: string;
	listed?: string;
	huggingFace?: number;
	score?: number;
	confidence?: number;
	topicProbabilities?: Record<string, number>;
	weighted?: number;
	scoredOn?: string;
};

// pool.json in the cache folder: every candidate of the last 60 days, by arXiv id.
export type Pool = Record<string, PoolRecord>;

// The lines for an ad-hoc search's candidates, header first: papers with a venue note first, then the rest, each group in
// the order given; at most `maxLines`, the rest counted in the header. A line is "<date> <id> <title>", then
// " | <venue note>" when the paper has one.
export function candidateLines(
	label: string,
	found: number,
	alreadyIn: number,
	unused: Paper[],
	maxLines: number,
): string[] {
	// filter keeps the order, so each group stays in the order given.
	const withNote = unused.filter((paper) => hasAcceptanceHint(paper));
	const others = unused.filter((paper) => !hasAcceptanceHint(paper));
	const printed = withNote.concat(others).slice(0, maxLines);
	const leftOut = found - alreadyIn - printed.length;
	let header = `${label} (${found} found`;
	if (alreadyIn > 0) {
		header += `, ${alreadyIn} already in the digests`;
	}
	if (leftOut > 0) {
		header += `, ${leftOut} left out`;
	}
	const lines = [`${header}):`];
	for (const paper of printed) {
		lines.push(
			candidateLine({
				id: paper.id,
				title: paper.title,
				published: paper.published,
				note: venueNote(paper),
			}),
		);
	}
	if (printed.length === 0) {
		lines.push("none");
	}
	return lines;
}

// Add one topic search's papers to the pool: a new paper gets `day` as its first day, a known one keeps the earlier
// of the two and gains the topic. arXiv's metadata is taken from the newest answer; a score is kept.
export function addToPool(
	pool: Pool,
	papers: Paper[],
	topic: number,
	day: string,
): void {
	for (const paper of papers) {
		const id = normalizeId(paper.id);
		const known = pool[id];
		let topics = [topic];
		let firstSeen = day;
		if (known !== undefined) {
			topics = known.topics;
			if (!topics.includes(topic)) {
				topics = topics.concat([topic]);
			}
			if (known.firstSeen < day) {
				firstSeen = known.firstSeen;
			}
		}
		pool[id] = Object.assign({}, known, {
			id: id,
			title: paper.title,
			abstract: paper.abstract || "",
			authors: paper.authors,
			published: paper.published,
			note: venueNote(paper),
			topics: topics,
			firstSeen: firstSeen,
		});
	}
}

// Drop the candidates first found more than 60 days before `day`, and those now in the digests.
export function prunePool(
	pool: Pool,
	inDigests: Set<string>,
	day: string,
): void {
	const oldest = daysBefore(day, POOL_DAYS);
	for (const record of Object.values(pool)) {
		if (record.firstSeen < oldest || inDigests.has(record.id)) {
			delete pool[record.id];
		}
	}
}

// The weighted score of every scored candidate now in the digests, added to `kept` (scores.json, by arXiv id without
// "arxiv:"), so bringing unread papers back later can still rank the paper once prunePool has dropped it.
export function keepScores(
	pool: Pool,
	inDigests: Set<string>,
	kept: Record<string, unknown>,
): void {
	for (const record of Object.values(pool)) {
		if (inDigests.has(record.id) && typeof record.weighted === "number") {
			kept[record.id] = record.weighted;
		}
	}
}

// The longest text a pool record's field may hold; the cache folder is read as data.
export const POOL_FIELD_CHARS = 10000;

// Whether `value`, kept under `id` in pool.json, is a record the pool can use: an object whose id is `id` and is an
// arXiv id (normalizeId form) or a "doi:" or "url:" id; title, abstract (when present), published, firstSeen and note
// (when not null) strings of at most POOL_FIELD_CHARS; authors (when present) a list of such strings; topics a list of
// numbers; listed, scoredOn (when present) strings; huggingFace, score, confidence, weighted (when present) numbers;
// topicProbabilities (when present) an object of numbers. Anything else is not a record.
export function isPoolRecord(id: string, value: unknown): value is PoolRecord {
	if (!isJsonObject(value) || value.id !== id) {
		return false;
	}
	if (!isArxivId(id) && !id.startsWith("doi:") && !id.startsWith("url:")) {
		return false;
	}
	const text = (field: unknown) =>
		typeof field === "string" && field.length <= POOL_FIELD_CHARS;
	const number = (field: unknown) => typeof field === "number";
	// A field that may be absent: undefined passes, a present value must pass `check`.
	const optional = (field: unknown, check: (field: unknown) => boolean) =>
		field === undefined || check(field);
	const list = (field: unknown, check: (item: unknown) => boolean) =>
		Array.isArray(field) && field.every(check);
	return (
		text(value.title) &&
		text(value.published) &&
		text(value.firstSeen) &&
		optional(value.abstract, text) &&
		(value.note === null || text(value.note)) &&
		optional(value.authors, (field) => list(field, text)) &&
		list(value.topics, number) &&
		optional(value.listed, (field) => typeof field === "string") &&
		optional(value.scoredOn, (field) => typeof field === "string") &&
		optional(value.huggingFace, number) &&
		optional(value.score, number) &&
		optional(value.confidence, number) &&
		optional(value.weighted, number) &&
		optional(
			value.topicProbabilities,
			(field) => isJsonObject(field) && Object.values(field).every(number),
		)
	);
}

// The records of pool.json as the cache folder holds them; a record of the wrong shape (isPoolRecord) is dropped and
// counted on stderr, since the next search that finds the paper writes it whole again.
function poolOf(kept: Record<string, unknown>): Pool {
	const pool: Pool = {};
	let dropped = 0;
	for (const [id, value] of Object.entries(kept)) {
		if (isPoolRecord(id, value)) {
			pool[id] = value;
		} else {
			dropped += 1;
		}
	}
	if (dropped > 0) {
		console.error(`pool.json: ${dropped} records of the wrong shape dropped`);
	}
	return pool;
}

// The pool as the cache folder holds it, and writing it back; scripts/scout/score.ts reads and writes it here too.
export function readPool(): Pool {
	return poolOf(readKept("pool.json"));
}
export function writePool(pool: Pool): boolean {
	return writeKept("pool.json", pool);
}

// What one topic's search leaves for its lines: arXiv's total today, today's results already in the digests, the ids
// today's search found, the topic's candidates in the pool in printing order, how many of them only earlier searches
// found and how many came from conference lists, and why the topic wasn't searched today (null when it was).
export type TopicResult = {
	topic: number;
	found: number;
	alreadyIn: number;
	today: Set<string>;
	candidates: PoolRecord[];
	earlier: number;
	listed: number;
	huggingFace: number;
	notSearched: string | null;
};

// The topics whose phrases one of a paper's names holds, by number.
export function topicsOf(names: string[], topics: Topic[]): number[] {
	return topics
		.filter((topic) =>
			names.some((name) =>
				topic.phrases.some((phrase) => phraseMatches(phrase, name)),
			),
		)
		.map((topic) => topic.topic);
}

// Add each list paper arXiv has, with its abstract, to the pool: for every topic whose phrase one of its names holds,
// with the note "<venue> <year>" (the year from the list's URL) and `listed` naming the venue. A paper in the digests,
// or whose abstract isn't kept yet, stays out.
export function addListedToPool(
	pool: Pool,
	lists: ReadList[],
	lookups: Record<string, Lookup>,
	topics: Topic[],
	inDigests: Set<string>,
	day: string,
): void {
	for (const list of lists) {
		let note = list.venue;
		const year = list.url.match(/20\d\d/);
		if (year !== null) {
			note = `${list.venue} ${year[0]}`;
		}
		for (const names of list.matching) {
			const found = keptId(names, lookups);
			if (found === null || inDigests.has(found.id)) {
				continue;
			}
			const kept = lookups[normaliseTitle(found.name)];
			if (kept === undefined || kept.abstract === undefined) {
				continue;
			}
			const known = pool[found.id];
			let paperTopics = topicsOf(names, topics);
			let firstSeen = day;
			let paperNote = note;
			if (known !== undefined) {
				paperTopics = known.topics.concat(
					paperTopics.filter((topic) => !known.topics.includes(topic)),
				);
				if (known.firstSeen < day) {
					firstSeen = known.firstSeen;
				}
				if (known.note !== null) {
					paperNote = known.note;
				}
			}
			pool[found.id] = Object.assign({}, known, {
				id: found.id,
				title: kept.title || found.name,
				abstract: kept.abstract,
				authors: kept.authors || [],
				published: found.arxivDate,
				note: paperNote,
				topics: paperTopics,
				firstSeen: firstSeen,
				listed: list.venue,
			});
		}
	}
}

// Add Hugging Face's papers to the pool with their upvotes: a new paper with no topic of its own, since no search
// found it (topicCandidates places it by Jev's topic), a known one keeping what it has. A paper in the digests stays out.
export function addHuggingFaceToPool(
	pool: Pool,
	papers: HuggingFacePaper[],
	inDigests: Set<string>,
	day: string,
): void {
	for (const paper of papers) {
		if (inDigests.has(paper.id)) {
			continue;
		}
		const known = pool[paper.id];
		if (known !== undefined) {
			known.huggingFace = paper.upvotes;
			continue;
		}
		pool[paper.id] = {
			id: paper.id,
			title: paper.title,
			abstract: paper.abstract,
			authors: paper.authors,
			published: paper.published,
			note: null,
			topics: [],
			firstSeen: day,
			huggingFace: paper.upvotes,
		};
	}
}

// The topic Jev gave the highest probability ({ t5: 0.8, none: 0.2 } -> 5), by number; null when that is "none" or
// Jev hasn't scored the paper. Ties go to the option Jev listed first.
export function jevTopic(
	probabilities: Record<string, number> | undefined,
): number | null {
	let best: string | null = null;
	let highest = -1;
	for (const [key, probability] of Object.entries(probabilities || {})) {
		if (probability > highest) {
			best = key;
			highest = probability;
		}
	}
	if (best === null || !/^t\d+$/.test(best)) {
		return null;
	}
	return Number(best.slice(1));
}

// A candidate's line: "<date> <id> <title>", then " | <venue note>" when it has one, else " | Hugging Face, <n>
// upvotes" when it is on Hugging Face's lists, then " ?" when Jev scored it with confidence below 0.5.
function candidateLine(record: {
	id: string;
	title: string;
	published: string;
	note: string | null;
	huggingFace?: number;
	confidence?: number;
}): string {
	// An arXiv id without its "arxiv:" prefix, which would only take room; a proceedings paper's "doi:" or "url:" id
	// whole, so the scout can tell the two apart.
	let id = record.id;
	if (!id.startsWith("doi:") && !id.startsWith("url:")) {
		id = normalizeId(id);
	}
	let line = `${record.published} ${id} ${cut(record.title, TITLE_CHARS)}`;
	if (record.note !== null) {
		line += ` | ${cut(record.note, NOTE_CHARS)}`;
	} else if (record.huggingFace !== undefined) {
		line += ` | Hugging Face, ${record.huggingFace} upvotes`;
	}
	if (record.confidence !== undefined && record.confidence < DOUBTFUL_BELOW) {
		line += " ?";
	}
	return line;
}

// One topic's lines, header first, with at most `maxLines` candidates. The header counts arXiv's results today, those
// already in the digests, the candidates only earlier searches found, and the rest left out: today's results not
// printed, read or not, plus the earlier candidates not printed.
function topicLines(result: TopicResult, maxLines: number): string[] {
	const label = `topic ${result.topic}`;
	const printed = result.candidates.slice(0, maxLines);
	const parts = [];
	if (result.notSearched !== null) {
		const earlierParts = [];
		if (result.earlier > 0) {
			earlierParts.push(`${result.earlier} from earlier searches`);
		}
		if (result.listed > 0) {
			earlierParts.push(`${result.listed} from conference lists`);
		}
		if (result.huggingFace > 0) {
			earlierParts.push(`${result.huggingFace} from Hugging Face`);
		}
		const notPrinted =
			result.earlier + result.listed + result.huggingFace - printed.length;
		if (notPrinted > 0) {
			earlierParts.push(`${notPrinted} left out`);
		}
		let header = `${label} (not searched today: ${result.notSearched}`;
		if (earlierParts.length > 0) {
			header += `; ${earlierParts.join(", ")}`;
		}
		parts.push(`${header}):`);
	} else {
		let header = `${label} (${result.found} found`;
		if (result.alreadyIn > 0) {
			header += `, ${result.alreadyIn} already in the digests`;
		}
		if (result.earlier > 0) {
			header += `, ${result.earlier} from earlier searches`;
		}
		if (result.listed > 0) {
			header += `, ${result.listed} from conference lists`;
		}
		if (result.huggingFace > 0) {
			header += `, ${result.huggingFace} from Hugging Face`;
		}
		// A listed paper today's search also found is counted once, among today's results.
		const listedOnly = result.candidates.filter(
			(record) => record.listed !== undefined && !result.today.has(record.id),
		).length;
		const leftOut =
			result.found -
			result.alreadyIn +
			result.earlier +
			listedOnly +
			result.huggingFace -
			printed.length;
		if (leftOut > 0) {
			header += `, ${leftOut} left out`;
		}
		parts.push(`${header}):`);
	}
	for (const record of printed) {
		parts.push(candidateLine(record));
	}
	if (printed.length === 0 && result.notSearched === null) {
		parts.push("none");
	}
	return parts;
}

// The whole output: every topic's lines with the same cap, the most up to 40 for which the output stays under 30,000
// characters (Claude Code's inline limit for a tool result), then the rest.
export function outputText(results: TopicResult[], rest: string[]): string {
	let text = "";
	for (let maxLines = POOL_LINES; maxLines >= 1; maxLines -= 1) {
		const lines = results.flatMap((result) => topicLines(result, maxLines));
		text = `${lines.concat(rest).join("\n")}\n`;
		if (text.length < OUTPUT_CHARS) {
			return text;
		}
	}
	return text;
}

// A comment part that mentions a submission, which never counts as an acceptance, whatever else it says.
const SUBMISSION = /under review|submitted|submission/i;
// Words that name an acceptance: "Accepted at", "To appear in", "Camera-ready", "Proceedings of", "Published in".
const ACCEPTANCE_WORDS =
	/accepted|to appear|camera[- ]ready|proceedings|published in/i;
// A known venue followed by its year: 2 or 4 digits after a space or an apostrophe ("ICML 2026", "COLM'26"), or 4
// digits right after the name ("NeurIPS2026"). "USENIX Security" comes before "USENIX" so the longer name is tried
// first.
const VENUE_YEAR =
	/\b(?:NeurIPS|ICML|ICLR|ACL|EMNLP|NAACL|EACL|COLING|COLM|FAccT|AIES|PoPETs|PETS|CVPR|ICCV|ECCV|AAAI|IJCAI|KDD|CHI|CSCW|USENIX Security|USENIX|CCS|TMLR|JMLR)(?:(?: |'|’)(?:\d{4}|\d{2})|\d{4})\b/i;

// Where arXiv's metadata says the paper was accepted, and nothing else: the journal reference when there is one; else
// the parts of the comment, split at commas and semicolons, that name an acceptance or a venue with a year, joined
// with ", " ("9 pages; Accepted at AIES 2026; code at ..." -> "Accepted at AIES 2026"); else null. A part that
// mentions a submission ("extended version under review at JMLR") never counts.
export function venueNote(paper: Paper): string | null {
	if (paper.journal_ref && paper.journal_ref.trim() !== "") {
		return paper.journal_ref.trim();
	}
	const parts = [];
	for (const part of (paper.comment || "").split(/[,;]/)) {
		if (SUBMISSION.test(part)) {
			continue;
		}
		if (ACCEPTANCE_WORDS.test(part) || VENUE_YEAR.test(part)) {
			parts.push(part.trim());
		}
	}
	if (parts.length === 0) {
		return null;
	}
	return parts.join(", ");
}

// True when a venue note names one of `venues` (the venues of interests.md's conference lists), with no letter on either
// side, in any case: "Findings of ACL 2026" and "NeurIPS2026" name "ACL" and "NeurIPS", "EACL 2026" doesn't.
export function namesListedVenue(note: string, venues: string[]): boolean {
	return venues.some((venue) => {
		// A venue's name is matched as written, never as a pattern (RegExp.escape is past tsconfig's es2024 lib).
		const name = venue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return new RegExp(`(?<![a-z])${name}(?![a-z])`, "i").test(note);
	});
}

// True when arXiv's metadata says the paper was accepted somewhere, that is when it has a venue note. An ad-hoc search
// prints such papers first.
export function hasAcceptanceHint(paper: Paper): boolean {
	return venueNote(paper) !== null;
}

// One topic of interests.md as Jev's topic question names it: its key (t<number>), its name and its weight.
export type TopicWeight = { key: string; name: string; weight: number };
// Every topic's weight, and the weight of a paper on none of them.
export type Weights = { topics: TopicWeight[]; none: number };

// The topics of interests.md's "Topics" section, each with the weight written after its name ("(weight 1.00)"), and
// the weight its "A paper on none of these topics has weight" line gives; null when either is missing.
export function topicWeights(markdown: string): Weights | null {
	const lines = markdown.split("\n");
	const start = lines.findIndex((text) => text.startsWith("## Topics"));
	if (start === -1) {
		return null;
	}
	const topics: TopicWeight[] = [];
	let none: number | null = null;
	for (const text of lines.slice(start + 1)) {
		if (text.startsWith("## ")) {
			break;
		}
		if (/^\d+\. /.test(text)) {
			const match = text.match(/^(\d+)\. (.+?) \(weight (\d+(?:\.\d+)?)\)/);
			if (match === null) {
				return null;
			}
			topics.push({
				key: `t${match[1]}`,
				name: String(match[2]),
				weight: Number(match[3]),
			});
		}
		const noneMatch = text.match(
			/none of these topics has weight (\d+(?:\.\d+)?)/,
		);
		if (noneMatch !== null) {
			none = Number(noneMatch[1]);
		}
	}
	if (topics.length === 0 || none === null) {
		return null;
	}
	return { topics: topics, none: none };
}
