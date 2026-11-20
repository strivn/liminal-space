// Each topic's arXiv search into the pool, the topic's candidates from the pool, and the abstracts of listed papers.
import { normalizeId } from "../../../shared/arxiv-id.ts";
import { isJsonObject } from "../../../shared/narrow.ts";
import { daysBefore } from "../../lib/run-date.ts";
import type { Paper } from "../arxiv/api.ts";
import { apiFailed, parseFeed, whatHappened } from "../arxiv/api.ts";
import type { Lookup, Run } from "../arxiv/search.ts";
import {
	ARXIV_API,
	askArxiv,
	PAGE_SIZE,
	readCandidates,
	stopArxiv,
} from "../arxiv/search.ts";
import type { Topic } from "./interests.ts";
import { topicQuery } from "./interests.ts";
import type { Pool, PoolRecord, TopicResult } from "./pool.ts";
import { addToPool, jevTopic, namesListedVenue } from "./pool.ts";

export const SEARCH_DAYS = 60;

// A topic's result as output.json keeps it: the counts, with today's ids as a list and without the candidates, which a
// replay takes from the pool again.
export function keptTopic(result: TopicResult): Record<string, unknown> {
	return { ...result, today: [...result.today], candidates: [] };
}

// The topics output.json kept, as results whose candidates topicCandidates fills in again; null when the field is
// absent (a file kept before it existed) or of the wrong shape, and then the plan runs instead.
export function keptTopics(value: unknown): TopicResult[] | null {
	if (!Array.isArray(value)) {
		return null;
	}
	const results: TopicResult[] = [];
	for (const item of value) {
		if (
			!isJsonObject(item) ||
			typeof item.topic !== "number" ||
			typeof item.found !== "number" ||
			typeof item.alreadyIn !== "number" ||
			typeof item.earlier !== "number" ||
			typeof item.listed !== "number" ||
			typeof item.huggingFace !== "number" ||
			!(item.notSearched === null || typeof item.notSearched === "string") ||
			!Array.isArray(item.today) ||
			!item.today.every((id) => typeof id === "string")
		) {
			return null;
		}
		results.push({
			topic: item.topic,
			found: item.found,
			alreadyIn: item.alreadyIn,
			today: new Set(item.today as string[]),
			candidates: [],
			earlier: item.earlier,
			listed: item.listed,
			huggingFace: item.huggingFace,
			notSearched: item.notSearched,
		});
	}
	return results;
}

// A list of strings as output.json keeps it; null for anything else.
export function keptStrings(value: unknown): string[] | null {
	if (
		!Array.isArray(value) ||
		!value.every((item) => typeof item === "string")
	) {
		return null;
	}
	return value;
}

// Fetch, through arXiv's id_list, 100 ids a request, the title, authors and abstract of every found paper lookups.json
// keeps without an abstract. Stops, like any arXiv request, once arXiv has failed.
export async function fillAbstracts(
	lookups: Record<string, Lookup>,
	run: Run,
): Promise<void> {
	const missing = Object.values(lookups).filter(
		(kept) => kept.id && kept.abstract === undefined,
	);
	for (let at = 0; at < missing.length && !run.arxivStopped; at += PAGE_SIZE) {
		const batch = missing.slice(at, at + PAGE_SIZE);
		const ids = batch.map((kept) => normalizeId(String(kept.id)));
		// biome-ignore lint/performance/noAwaitInLoops: arXiv asks for one request at a time; askArxiv paces them
		const answer = await askArxiv(
			`${ARXIV_API}?id_list=${ids.join(",")}&max_results=${PAGE_SIZE}`,
		);
		if (apiFailed(answer) || !answer.ok) {
			stopArxiv(run, answer);
			return;
		}
		const byId: Record<string, Paper> = {};
		for (const paper of parseFeed(answer.body)) {
			byId[normalizeId(paper.id)] = paper;
		}
		for (const kept of batch) {
			const paper = byId[normalizeId(String(kept.id))];
			if (paper !== undefined) {
				kept.title = paper.title;
				kept.authors = paper.authors;
				kept.abstract = paper.abstract || "";
			}
		}
	}
}

// One topic's search: papers first submitted in the window, without those already in the digests, read in pages of
// 100 until 100 such papers are found or the results end, and added to the pool. A topic arXiv couldn't search today
// still has the candidates of earlier searches (topicCandidates).
export async function searchTopic(
	topic: Topic,
	start: string,
	end: string,
	day: string,
	inDigests: Set<string>,
	pool: Pool,
	run: Run,
): Promise<TopicResult> {
	const result: TopicResult = {
		topic: topic.topic,
		found: 0,
		alreadyIn: 0,
		today: new Set<string>(),
		candidates: [],
		earlier: 0,
		listed: 0,
		huggingFace: 0,
		notSearched: null,
	};
	if (run.arxivStopped) {
		result.notSearched = "no more arXiv requests in this run";
	} else {
		const read = await readCandidates(
			topicQuery(topic.phrases, start, end),
			"submittedDate",
			PAGE_SIZE,
			inDigests,
			askArxiv,
		);
		const answer = read.stoppedBy;
		if (answer !== null) {
			// arXiv answers a query it can't parse with HTTP 400; the other topics' queries may still work.
			if (answer.status === 400) {
				console.error(
					`search.ts: arXiv rejected topic ${topic.topic}'s query (${answer.url})`,
				);
				run.failed = true;
				if (read.found === null) {
					result.notSearched = "arXiv rejected its query";
				}
			} else {
				stopArxiv(run, answer);
				if (read.found === null) {
					result.notSearched = `arXiv API ${whatHappened(answer, "an arXiv feed")}`;
				}
			}
		}
		result.found = read.found || 0;
		result.alreadyIn = read.alreadyIn;
		addToPool(pool, read.unused, topic.topic, day);
		for (const paper of read.unused) {
			result.today.add(normalizeId(paper.id));
		}
	}
	return result;
}

// A topic's candidates, once every search and list has added to the pool: the pool's papers for the topic, first
// submitted in the 60 days ending on `day` or on a conference list whatever their date; those accepted at a conference
// of `venues` (the venues of interests.md's lists) first, each group newest first.
export function topicCandidates(
	result: TopicResult,
	pool: Pool,
	day: string,
	venues: string[],
): void {
	// The scout's rule for papers: first submitted in the 60 days ending on the run's day, whenever a search found it.
	const oldest = daysBefore(day, SEARCH_DAYS);
	// A Hugging Face paper no search found is a candidate of the topic Jev put it in.
	const fromHuggingFace = (record: PoolRecord) =>
		!record.topics.includes(result.topic) &&
		record.huggingFace !== undefined &&
		jevTopic(record.topicProbabilities) === result.topic;
	const candidates = Object.values(pool).filter(
		(record) =>
			(record.topics.includes(result.topic) || fromHuggingFace(record)) &&
			record.published <= day &&
			(record.published >= oldest || record.listed !== undefined),
	);
	// Newest first by first-version date; sort keeps the pool's order for papers of the same day, and filter keeps that
	// order within each group below.
	candidates.sort((a, b) => b.published.localeCompare(a.published));
	// Papers accepted at a conference of interests.md first: on one of its lists, or with a venue note naming it. Within
	// each group, those Jev hasn't scored yet first, newest first, then the scored ones by weighted score, then confidence.
	const ordered = (group: PoolRecord[]) => {
		const unscored = group.filter((record) => record.weighted === undefined);
		const scored = group.filter((record) => record.weighted !== undefined);
		scored.sort(
			(a, b) =>
				(b.weighted || 0) - (a.weighted || 0) ||
				(b.confidence || 0) - (a.confidence || 0),
		);
		return unscored.concat(scored);
	};
	const atListed = (record: PoolRecord) =>
		record.listed !== undefined ||
		(record.note !== null && namesListedVenue(record.note, venues));
	const first = candidates.filter((record) => atListed(record));
	const others = candidates.filter((record) => !atListed(record));
	result.candidates = ordered(first).concat(ordered(others));
	result.listed = candidates.filter(
		(record) => record.listed !== undefined,
	).length;
	result.huggingFace = candidates.filter(fromHuggingFace).length;
	result.earlier = candidates.filter(
		(record) =>
			!result.today.has(record.id) &&
			record.listed === undefined &&
			!fromHuggingFace(record),
	).length;
}
