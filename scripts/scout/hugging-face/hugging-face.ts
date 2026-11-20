// Hugging Face's daily papers for scripts/scout/search.ts's candidate pool: the 10 most upvoted of the lists of the last 7
// days, ranked by each paper's own upvote count, and every paper of the newest of those lists that has papers. Copied
// from scripts/scout/surprise.ts's huggingFaceCandidates and rankHuggingFace, with the abstract, authors and arXiv date a
// candidate needs.
// Environment: HF_API (a stand-in for tests).

import { isJsonObject } from "../../../shared/narrow.ts";
import { request } from "../../lib/http.ts";

const HF_API = process.env.HF_API || "https://huggingface.co/api";
// Hugging Face's lists lag; this many of the most upvoted are re-read from each paper's own record.
const HF_RECHECKED = 10;

// A paper of Hugging Face's lists: its arXiv id, title, abstract, authors and first-version date (YYYY-MM-DD), the
// first list it is on (YYYY-MM-DD), and its upvotes; fromList when the count is the list's, not its own record's.
export type HuggingFacePaper = {
	id: string;
	title: string;
	abstract: string;
	authors: string[];
	published: string;
	listed: string;
	upvotes: number;
	fromList: boolean;
};

// What getJson read: the parsed JSON, or a problem; an HTTP error also gives its status.
type JsonAnswer = { json: unknown } | { problem: string; status?: number };

// Any text as one line: runs of whitespace, line breaks included, become one space.
function oneLine(value: unknown) {
	return String(value || "")
		.replace(/\s+/g, " ")
		.trim();
}

// One item of a daily list -> the paper it holds, with its list count and `date` as its listing day; null for an item
// without a paper id.
function listItemPaper(item: unknown, date: string): HuggingFacePaper | null {
	if (
		!isJsonObject(item) ||
		!isJsonObject(item.paper) ||
		typeof item.paper.id !== "string"
	) {
		return null;
	}
	const paper = item.paper;
	const authors: string[] = [];
	if (Array.isArray(paper.authors)) {
		for (const author of paper.authors) {
			if (isJsonObject(author) && typeof author.name === "string") {
				authors.push(author.name);
			}
		}
	}
	return {
		id: String(paper.id),
		title: oneLine(paper.title),
		abstract: oneLine(paper.summary),
		authors: authors,
		// "2026-10-22T00:00:00.000Z" -> "2026-10-22"
		published: String(paper.publishedAt || "").slice(0, 10),
		listed: date,
		upvotes: Number(paper.upvotes) || 0,
		fromList: true,
	};
}

// Every paper Hugging Face's daily lists hold, once, in list order: the oldest day first, then the list's own order.
// A paper listed on several days keeps its first day and its highest list count.
function listedPapers(listItemsByDate: Record<string, unknown[]>) {
	const days = Object.keys(listItemsByDate).sort();
	const papers: HuggingFacePaper[] = [];
	const byId = new Map<string, HuggingFacePaper>();
	for (const date of days) {
		for (const item of listItemsByDate[date] || []) {
			const paper = listItemPaper(item, date);
			if (paper === null) {
				continue;
			}
			const seen = byId.get(paper.id);
			if (seen === undefined) {
				papers.push(paper);
				byId.set(paper.id, paper);
			} else if (paper.upvotes > seen.upvotes) {
				seen.upvotes = paper.upvotes;
			}
		}
	}
	return papers;
}

// Hugging Face's daily lists -> the 10 papers with the most list upvotes, ranked by their live counts.
// listItemsByDate: { "YYYY-MM-DD": [items as daily_papers gives them] }. liveCounts: { id: upvotes } read from each
// paper's own record; a paper without a live count keeps its list count and gets fromList: true. Ties, in both steps,
// go to the paper listed first.
export function rankHuggingFace(
	listItemsByDate: Record<string, unknown[]>,
	liveCounts: Record<string, number>,
): HuggingFacePaper[] {
	const listed = listedPapers(listItemsByDate);
	// The 10 most upvoted by list counts; sort() is stable, so ties stay in list order.
	const mostUpvoted = listed
		.slice()
		.sort((a, b) => b.upvotes - a.upvotes)
		.slice(0, HF_RECHECKED);
	// Those 10 back in list order, each with its live count where there is one.
	const ranked: HuggingFacePaper[] = [];
	for (const paper of listed) {
		if (!mostUpvoted.includes(paper)) {
			continue;
		}
		// Object.hasOwn: a name every object inherits, such as "constructor", doesn't count.
		const liveCount = liveCounts[paper.id];
		if (Object.hasOwn(liveCounts, paper.id) && liveCount !== undefined) {
			ranked.push(
				Object.assign({}, paper, { upvotes: liveCount, fromList: false }),
			);
		} else {
			ranked.push(paper);
		}
	}
	// Most upvoted first; stable, so equal counts stay in list order.
	return ranked.sort((a, b) => b.upvotes - a.upvotes);
}

// The papers of the newest list that has any, in its own order, with their list counts. Hugging Face lists nothing
// on weekends, so on a Monday morning in Jakarta that is Friday's.
export function latestList(
	listItemsByDate: Record<string, unknown[]>,
): HuggingFacePaper[] {
	const days = Object.keys(listItemsByDate).sort().reverse();
	for (const date of days) {
		const papers = listedPapers({ [date]: listItemsByDate[date] || [] });
		if (papers.length > 0) {
			return papers;
		}
	}
	return [];
}

// One GET with the user agent and a 30 s limit, read as JSON. Requests are awaited one by one, so only one is open at a
// time. Returns { json }, or { problem } in words that finish "Hugging Face ..."; an HTTP error also gives { status }.
async function getJson(url: string): Promise<JsonAnswer> {
	const answer = await request(url);
	if ("problem" in answer) {
		return { problem: answer.problem };
	}
	if (!answer.ok) {
		return {
			problem: `answered HTTP ${answer.status}`,
			status: answer.status,
		};
	}
	try {
		return { json: JSON.parse(answer.text()) };
	} catch {
		return { problem: "answered with something that isn't JSON" };
	}
}

// The pool's Hugging Face papers for these days (oldest first): the ranking, then the newest list's other papers. A
// problem, in words that finish "Hugging Face ...", when a list failed, since a ranking without that day could put the
// wrong papers first. endsToday: the newest day is Jakarta's today, which Hugging Face, dating its lists in UTC, may
// not have reached; it answers HTTP 400 for such a date, which counts as a day with no list.
export async function huggingFacePapers(
	days: string[],
	endsToday: boolean,
): Promise<{ papers: HuggingFacePaper[] } | { problem: string }> {
	const newestDay = days[days.length - 1];
	const lists: Record<string, unknown[]> = {};
	for (const date of days) {
		const url = `${HF_API}/daily_papers?date=${date}&limit=100`;
		// biome-ignore lint/performance/noAwaitInLoops: stops at the first failed day: the ranking needs every day's list
		const answer = await getJson(url);
		if (
			"problem" in answer &&
			answer.status === 400 &&
			endsToday &&
			date === newestDay
		) {
			lists[date] = [];
			continue;
		}
		if ("problem" in answer) {
			return { problem: `${answer.problem} (${url})` };
		}
		if (!Array.isArray(answer.json)) {
			return { problem: `answered JSON that isn't a list (${url})` };
		}
		lists[date] = answer.json;
	}

	// The lists' counts lag: re-read the 10 most upvoted from their own records. A record that fails keeps its list count.
	const liveCounts: Record<string, number> = {};
	for (const paper of rankHuggingFace(lists, {})) {
		// biome-ignore lint/performance/noAwaitInLoops: one record at a time, so only one request to Hugging Face is open
		const answer = await getJson(`${HF_API}/papers/${paper.id}`);
		if (
			"json" in answer &&
			isJsonObject(answer.json) &&
			typeof answer.json.upvotes === "number"
		) {
			liveCounts[paper.id] = answer.json.upvotes;
		}
	}
	const papers = rankHuggingFace(lists, liveCounts);
	for (const paper of latestList(lists)) {
		if (!papers.some((ranked) => ranked.id === paper.id)) {
			papers.push(paper);
		}
	}
	return { papers: papers };
}
