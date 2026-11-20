// arXiv searches of the plan with their retries, and the arXiv lookup of the conference lists' titles.
import { setTimeout as pause } from "node:timers/promises";
import { normalizeId } from "../../../shared/arxiv-id.ts";
import CONSTANTS from "../../lib/constants.json" with { type: "json" };
import { cut } from "../plan/interests.ts";
import { writeKept } from "../plan/kept.ts";
import {
	normaliseTitle,
	titleSearchText,
	titlesMatch,
	wordsQuery,
} from "../plan/title-match.ts";
import type { ArxivAnswer, Paper } from "./api.ts";
import { apiFailed, arxivRequest, parseFeed, whatHappened } from "./api.ts";

export const ARXIV_API = process.env.ARXIV_API || CONSTANTS.arxivApi;
export const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
export const PAGE_SIZE = 100; // arXiv results per request
const LIST_LINES = 8;
export const TITLE_CHARS = 100;
// Each title lookup is one arXiv request, 3 s apart: 60 take at least 3 minutes.
const LOOKUPS_PER_RUN = 60;
// A "not on arXiv" answer is asked again once it is older than this; a found id is kept for good. The same holds for a
// "not in the proceedings" answer.
export const NOT_ON_ARXIV_KEPT_DAYS = 30;

// One paper of a list: its title, or the array of names it is listed under.
export type ListTitle = string | string[];
// What a run keeps track of: whether a source failed, and whether arXiv requests stopped.
export type Run = { failed: boolean; arxivStopped: boolean };
// One list as read in this run, with its papers that hold a topic phrase.
export type ReadList = {
	venue: string;
	url: string;
	published: string | null;
	titles: ListTitle[];
	copyKept: string | null;
	problem: string | null;
	matching: string[][];
};
// One kept answer of lookups.json: the arXiv id and date of a title, null for "not on arXiv", and when it was asked.
// A found paper's title, authors and abstract are kept with it, so the paper can join the pool; an older answer has
// none, until fillAbstracts fetches them.
export type Lookup = {
	id: string | null;
	arxivDate: string | null;
	checked: string;
	title?: string;
	authors?: string[];
	abstract?: string;
};
// A paper of a list found on arXiv: the name it was found under, its id and its arXiv date.
type FoundPaper = { name: string; id: string; arxivDate: string };

// The number of results arXiv has for a query, from the feed's <opensearch:totalResults>; `fallback` when it has none.
function totalResults(xml: string, fallback: number) {
	const match = xml.match(/<opensearch:totalResults[^>]*>\s*(\d+)\s*</);
	if (match === null) {
		return fallback;
	}
	return Number(match[1]);
}

// The waits before the retries of a failed arXiv request, in minutes: 15 minutes in all before the run stops asking.
const RETRY_WAITS_MINUTES = [1, 2, 4, 8];
// The length of a minute for those waits; ARXIV_RETRY_MINUTE_MS shortens it (tests only).
const MINUTE_MS = Number(process.env.ARXIV_RETRY_MINUTE_MS) || 60 * 1000;

// One arXiv request of the daily plan, asked again after each wait of RETRY_WAITS_MINUTES while arXiv fails
// (apiFailed). Each retry is one stderr line. Returns the last answer; the caller stops arXiv when it still failed.
export async function askArxiv(url: string): Promise<ArxivAnswer> {
	let answer = await arxivRequest(url);
	for (const [index, minutes] of RETRY_WAITS_MINUTES.entries()) {
		if (!apiFailed(answer)) {
			return answer;
		}
		let wait = `${minutes} minutes`;
		if (minutes === 1) {
			wait = "1 minute";
		}
		console.error(
			`search.ts: arXiv API ${whatHappened(answer, "an arXiv feed")} (${answer.url}); ` +
				`retry ${index + 1} of ${RETRY_WAITS_MINUTES.length} in ${wait}`,
		);
		// biome-ignore lint/performance/noAwaitInLoops: each retry waits for the answer to the one before
		await pause(minutes * MINUTE_MS);
		answer = await arxivRequest(url);
	}
	return answer;
}

// After an arXiv request failed (at every try, when it was one askArxiv retries), make no more in this run, and say so.
export function stopArxiv(run: Run, answer: ArxivAnswer): void {
	run.arxivStopped = true;
	run.failed = true;
	// Only a failure apiFailed names was retried; another (a 403, a 404) stopped at the first try.
	let retried = "";
	if (apiFailed(answer)) {
		retried = `arXiv refused the search after ${RETRY_WAITS_MINUTES.length} retries: `;
	}
	console.error(
		`search.ts: ${retried}arXiv API ${whatHappened(answer, "an arXiv feed")} (${answer.url}); ` +
			"no more arXiv requests in this run",
	);
}

// What reading one arXiv search gave: arXiv's total (null when no page was read), how many results were already in
// the digests, the others in arXiv's order, and the answer that stopped the reading when one did.
type Candidates = {
	found: number | null;
	alreadyIn: number;
	unused: Paper[];
	stoppedBy: ArxivAnswer | null;
};

// Read one arXiv search, page by page of 100, leaving out papers already in the digests, until `wanted` others are
// found or the results end. `request` asks arXiv: askArxiv for the daily plan, arxivRequest for an ad-hoc search. A 400
// (arXiv can't parse the query) or a failed request stops the reading; the caller says what happened.
export async function readCandidates(
	query: string,
	sortBy: string,
	wanted: number,
	inDigests: Set<string>,
	request: (url: string) => Promise<ArxivAnswer>,
): Promise<Candidates> {
	const result: Candidates = {
		found: null,
		alreadyIn: 0,
		unused: [],
		stoppedBy: null,
	};
	let offset = 0;
	while (true) {
		const url =
			`${ARXIV_API}?search_query=${encodeURIComponent(query)}&sortBy=${sortBy}&sortOrder=descending` +
			`&max_results=${PAGE_SIZE}&start=${offset}`;
		// biome-ignore lint/performance/noAwaitInLoops: each page's offset follows from arXiv's answer to the page before
		const answer = await request(url);
		if (answer.status === 400 || apiFailed(answer) || !answer.ok) {
			result.stoppedBy = answer;
			return result;
		}
		const papers = parseFeed(answer.body);
		if (result.found === null) {
			result.found = totalResults(answer.body, papers.length);
		}
		for (const paper of papers) {
			if (inDigests.has(normalizeId(paper.id))) {
				result.alreadyIn += 1;
			} else {
				result.unused.push(paper);
			}
		}
		offset += papers.length;
		// An empty page also ends the reading, so a total arXiv overstates can't loop forever.
		if (
			result.unused.length >= wanted ||
			papers.length === 0 ||
			offset >= result.found
		) {
			return result;
		}
	}
}

// Whole days from one YYYY-MM-DD date to a later one; NaN when either isn't a date.
export function daysBetween(earlier: string, later: string): number {
	return Math.round((Date.parse(later) - Date.parse(earlier)) / DAY_MS);
}

// The kept arXiv answer for a paper: { name, id, arxivDate } of its first name found on arXiv; null when none was.
export function keptId(
	names: string[],
	lookups: Record<string, Lookup>,
): FoundPaper | null {
	for (const name of names) {
		const kept = lookups[normaliseTitle(name)];
		if (kept && kept.id) {
			return {
				name: name,
				id: normalizeId(kept.id),
				arxivDate: kept.arxivDate || "",
			};
		}
	}
	return null;
}

// True when a kept "not on arXiv" answer is older than 30 days, or has no readable date, and should be asked again.
function isStale(kept: Lookup, today: string) {
	if (kept.id) {
		return false;
	}
	const age = daysBetween(kept.checked, today);
	return Number.isNaN(age) || age > NOT_ON_ARXIV_KEPT_DAYS;
}

// The paper of an arXiv answer that a list title names: the one whose title is the same once normalised, else the
// first whose title titlesMatch finds alike; null for none.
function namedPaper(papers: Paper[], name: string) {
	const key = normaliseTitle(name);
	const same = papers.find((paper) => normaliseTitle(paper.title) === key);
	if (same !== undefined) {
		return same;
	}
	return papers.find((paper) => titlesMatch(name, paper.title)) || null;
}

// Look one list title up on arXiv and keep the answer in `lookups` under its normalised title: the id of the paper the
// title names (namedPaper), else null for "not on arXiv". The exact-title search comes first; when it finds no such
// paper, a second search asks for the title's four longest words (wordsQuery), since arXiv's phrase search misses a
// title with a word added or a "Position:" label. Returns true when an answer was kept, false when a request failed.
async function lookUp(
	name: string,
	lookups: Record<string, Lookup>,
	today: string,
	run: Run,
) {
	const key = normaliseTitle(name);
	const queries = [`ti:"${titleSearchText(name)}"`];
	const words = wordsQuery(name);
	if (words !== "") {
		queries.push(words);
	}
	let found: Paper | null = null;
	for (const query of queries) {
		// biome-ignore lint/performance/noAwaitInLoops: the second search is asked only when the first found nothing
		const answer = await askArxiv(
			`${ARXIV_API}?search_query=${encodeURIComponent(query)}&max_results=5`,
		);
		if (answer.status === 400) {
			// arXiv couldn't read the search; the title counts as not on arXiv until that answer is old.
			console.error(
				`search.ts: arXiv rejected the title search for "${name}" (${answer.url})`,
			);
			run.failed = true;
			lookups[key] = { id: null, arxivDate: null, checked: today };
			return true;
		}
		if (apiFailed(answer) || !answer.ok) {
			stopArxiv(run, answer);
			return false;
		}
		found = namedPaper(parseFeed(answer.body), name);
		if (found !== null) {
			break;
		}
	}
	let kept: Lookup = { id: null, arxivDate: null, checked: today };
	if (found !== null) {
		kept = {
			id: normalizeId(found.id),
			arxivDate: found.published,
			checked: today,
			title: found.title,
			authors: found.authors,
			abstract: found.abstract || "",
		};
	}
	lookups[key] = kept;
	return true;
}

// Look up the arXiv ids of the lists' matching titles that have no answer yet, or whose "not on arXiv" answer is older
// than 30 days: never-asked titles first, then old answers, each with lists in interests.md order and titles in list
// order, at most 60 per run. A paper listed under several names has them asked in that order until one is found.
// Returns the normalised titles still to look up after this run.
// lookups.json is written after each answer: 60 lookups take 3 to 6 minutes (a title the exact search misses is asked
// twice), longer than a tool may let a command run, and a run stopped part-way then keeps what it learned, so the next
// run goes on from there.
export async function lookUpTitles(
	read: ReadList[],
	lookups: Record<string, Lookup>,
	today: string,
	run: Run,
): Promise<{ waiting: Set<string> }> {
	// Each queued title as { name, names, answered }: names are its paper's names, answered is set once arXiv answers.
	const never = [];
	const stale = [];
	const queued = new Set<string>(); // normalised titles, so a title in two lists is asked once
	for (const list of read) {
		for (const names of list.matching) {
			if (keptId(names, lookups) !== null) {
				continue;
			}
			// Every name of a paper may be asked: an oral's name or its poster's may be the arXiv title.
			for (const name of names) {
				const key = normaliseTitle(name);
				if (queued.has(key)) {
					continue;
				}
				const title = { name: name, names: names, answered: false };
				if (lookups[key] === undefined || lookups[key] === null) {
					never.push(title);
					queued.add(key);
				} else if (isStale(lookups[key], today)) {
					stale.push(title);
					queued.add(key);
				}
			}
		}
	}
	const titles = never.concat(stale);

	let asked = 0;
	let writable = true; // after one failed write, stop trying, so the failure is named once
	for (const title of titles) {
		if (asked >= LOOKUPS_PER_RUN || run.arxivStopped) {
			break;
		}
		// An earlier name of the same paper was found: this one isn't asked and costs no lookup.
		if (keptId(title.names, lookups) !== null) {
			continue;
		}
		// biome-ignore lint/performance/noAwaitInLoops: lookups go to arXiv, which asks for spaced-out requests, and stop at the run's lookup budget
		title.answered = await lookUp(title.name, lookups, today, run);
		asked += 1;
		if (title.answered && writable) {
			writable = writeKept("lookups.json", lookups);
		}
	}

	// Still to look up: the titles arXiv didn't answer this run, unless another name of their paper was found.
	const waiting = new Set<string>();
	for (const title of titles) {
		if (!title.answered && keptId(title.names, lookups) === null) {
			waiting.add(normaliseTitle(title.name));
		}
	}
	return { waiting: waiting };
}

// True when no name of a list paper was found on arXiv and at least one was asked: a paper "not on arXiv".
export function notOnArxiv(
	names: string[],
	lookups: Record<string, Lookup>,
): boolean {
	return (
		keptId(names, lookups) === null &&
		names.some((name) => lookups[normaliseTitle(name)] !== undefined)
	);
}

// One list's header and lines: its matching papers with an arXiv id that aren't in the digests, newest arXiv date
// first, at most 8; then, when arXiv failed this run, at most 8 matching titles whose lookup is still due.
export function listLines(
	list: ReadList,
	lookups: Record<string, Lookup>,
	waiting: Set<string>,
	inDigests: Set<string>,
	run: Run,
): string[] {
	if (list.problem !== null) {
		return [`${list.venue} (${list.url}) (not read: ${list.problem}):`];
	}
	let onArxiv = 0;
	let alreadyIn = 0;
	const candidates = []; // { name, id, arxivDate }
	const notLookedUp: string[] = []; // titles
	for (const names of list.matching) {
		const found = keptId(names, lookups);
		if (found !== null) {
			onArxiv += 1;
			if (inDigests.has(found.id)) {
				alreadyIn += 1;
			} else {
				candidates.push(found);
			}
		} else if (names.some((name) => waiting.has(normaliseTitle(name)))) {
			const firstName = names[0];
			if (firstName !== undefined) {
				notLookedUp.push(firstName);
			}
		}
	}
	// Newest arXiv date first; sort keeps list order for papers of the same day.
	candidates.sort((a, b) => b.arxivDate.localeCompare(a.arxivDate));
	const printed = candidates.slice(0, LIST_LINES);
	const leftOut = candidates.length - printed.length;

	let header = `${list.venue} (${list.url}) (`;
	if (list.published) {
		header += `published ${list.published}`;
	} else {
		header += "publication date unknown";
	}
	if (list.copyKept !== null) {
		header += `; titles from the copy kept ${list.copyKept}`;
	}
	header += `; ${list.titles.length} titles, ${list.matching.length} match the topics, ${onArxiv} on arXiv`;
	if (alreadyIn > 0) {
		header += `, ${alreadyIn} already in the digests`;
	}
	if (leftOut > 0) {
		header += `, ${leftOut} left out`;
	}
	if (notLookedUp.length > 0) {
		header += `, ${notLookedUp.length} not looked up`;
	}
	const lines = [`${header}):`];
	for (const paper of printed) {
		lines.push(
			`${paper.arxivDate} ${paper.id} ${cut(paper.name, TITLE_CHARS)}`,
		);
	}
	if (run.arxivStopped) {
		for (const title of notLookedUp.slice(0, LIST_LINES)) {
			lines.push(`not looked up: ${cut(title, TITLE_CHARS)}`);
		}
	}
	return lines;
}
