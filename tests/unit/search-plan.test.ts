// Tests of the search plan's pieces as scripts/scout/search.ts runs them, in this process, against stand-ins for arXiv, Google
// News and the conference lists on 127.0.0.1: one topic's arXiv search and its printed candidates, the retries, the
// conference lists and the title lookups, and each topic's news. The environment is set before the modules load, since
// they read it once.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, test } from "vitest";
import type * as ArxivSearch from "../../scripts/scout/arxiv/search.ts";
import type * as News from "../../scripts/scout/news/news.ts";
import type { Topic } from "../../scripts/scout/plan/interests.ts";
import type * as Pool from "../../scripts/scout/plan/pool.ts";
import type * as TopicSearch from "../../scripts/scout/plan/topic-search.ts";
import type * as VenueLists from "../../scripts/scout/proceedings/venue-lists.ts";
import { closeServers } from "./local-server.ts";
import type { ArxivPaper } from "./search-stand-ins.ts";
import {
	atomFeed,
	newsItem,
	pageOf,
	rss,
	startStandIns,
} from "./search-stand-ins.ts";

const TMP = mkdtempSync(join(tmpdir(), "liminal-unit-plan-"));
const stand = await startStandIns();
process.env.TMPDIR = TMP;
process.env.LIMINAL_CACHE = join(TMP, "cache");
process.env.ARXIV_API = `${stand.base}/api/query`;
process.env.NEWS_RSS = `${stand.base}/rss`;
process.env.ARXIV_PAUSE_MS = "0";
// A minute of the retry waits lasts 5 ms.
process.env.ARXIV_RETRY_MINUTE_MS = "5";

const search: typeof TopicSearch = await import(
	"../../scripts/scout/plan/topic-search.ts"
);
const arxivSearch: typeof ArxivSearch = await import(
	"../../scripts/scout/arxiv/search.ts"
);
const pool: typeof Pool = await import("../../scripts/scout/plan/pool.ts");
const news: typeof News = await import("../../scripts/scout/news/news.ts");
const venueLists: typeof VenueLists = await import(
	"../../scripts/scout/proceedings/venue-lists.ts"
);

afterAll(async () => {
	await closeServers();
	rmSync(TMP, { recursive: true, force: true });
});

const DAY = "2026-10-12";
const TOPIC_1: Topic = {
	topic: 1,
	phrases: [
		"sparse autoencoder",
		"activation steering",
		"deception & language model",
	],
};
const TOPIC_2: Topic = { topic: 2, phrases: ["labor market"] };

// stderr lines the code under test prints, captured for the length of one call.
async function withStderr<T>(
	work: () => Promise<T>,
): Promise<{ result: T; stderr: string }> {
	const lines: string[] = [];
	const printed = console.error;
	console.error = (...args: unknown[]) => {
		lines.push(args.join(" "));
	};
	try {
		const result = await work();
		return { result: result, stderr: lines.join("\n") };
	} finally {
		console.error = printed;
	}
}

beforeEach(() => {
	stand.arxiv.requests.length = 0;
	stand.arxiv.answer = () => ({ status: 200, body: atomFeed([]) });
	stand.news.requests.length = 0;
	stand.news.answer = () => ({ status: 200, body: rss([]) });
	stand.all.length = 0;
	stand.pageRequests.length = 0;
	for (const path of Object.keys(stand.pages)) {
		delete stand.pages[path];
	}
});

function idOf(n: number): string {
	return `2610.${String(n).padStart(5, "0")}`;
}

// n papers, the first `newest` published on 2026-10-11 and the rest on 2026-10-01, as arXiv lists them (newest first).
function papers(count: number, newest = count): ArxivPaper[] {
	return Array.from({ length: count }, (_, n) => ({
		id: idOf(n),
		title: `Paper ${n}`,
		published: n < newest ? "2026-10-11" : "2026-10-01",
	}));
}

// One topic's search of `listed` papers and the text it prints; `inDigests` are ids already on the page.
async function searchOne(
	listed: ArxivPaper[],
	inDigests: string[] = [],
	topic = TOPIC_1,
	venues: string[] = [],
) {
	stand.arxiv.answer = (request) => pageOf(listed, request);
	const run = { failed: false, arxivStopped: false };
	const kept: Pool.Pool = {};
	const result = await search.searchTopic(
		topic,
		"20260813",
		"20261012",
		DAY,
		new Set(inDigests),
		kept,
		run,
	);
	search.topicCandidates(result, kept, DAY, venues);
	return {
		text: pool.outputText([result], []),
		run: run,
		result: result,
		pool: kept,
	};
}

test("A topic's search asks arXiv for the last 60 days, newest first, and prints the papers not in the digests, counting those that are", async () => {
	const listed: ArxivPaper[] = [
		{ id: idOf(1), title: "Paper 1", published: "2026-10-10" },
		{ id: idOf(2), title: "Paper 2", published: "2026-10-09" },
		{ id: idOf(3), title: "Paper 3", published: "2026-10-08" },
		{ id: idOf(4), title: "Paper 4", published: "2026-10-07" },
		{ id: idOf(5), title: "Paper 5", published: "2026-10-06" },
	];
	const { text } = await searchOne(listed, [idOf(2), idOf(4)]);
	const [request] = stand.arxiv.requests;
	assert.equal(stand.arxiv.requests.length, 1);
	assert.ok(request);
	assert.equal(
		request.query,
		'submittedDate:[202608130000 TO 202610122359] AND (abs:"sparse autoencoder" OR abs:"activation steering" OR (abs:"deception" AND abs:"language model"))',
	);
	assert.equal(request.sortBy, "submittedDate");
	assert.equal(request.maxResults, 100);
	assert.equal(request.start, 0);
	assert.equal(
		text,
		[
			"topic 1 (5 found, 2 already in the digests):",
			"2026-10-10 2610.00001 Paper 1",
			"2026-10-08 2610.00003 Paper 3",
			"2026-10-06 2610.00005 Paper 5",
			"",
		].join("\n"),
	);
});

test("limit: At most 40 papers are printed per topic, the rest counted, and only the first page is read when it holds 100 new papers", async () => {
	const { text } = await searchOne(papers(140, 40));
	const lines = text.trimEnd().split("\n");
	assert.equal(lines[0], "topic 1 (140 found, 100 left out):");
	assert.equal(lines.length, 41);
	for (const line of lines.slice(1)) {
		assert.match(line, /^2026-10-11 2610\.000\d\d Paper \d+$/);
	}
	assert.deepEqual(
		stand.arxiv.requests.map((request) => request.start),
		[0],
	);
});

test("A second page is read when the first is used up by papers already in the digests", async () => {
	const everyone = papers(130);
	const first100 = everyone.slice(0, 100).map((paper) => paper.id);
	const { text } = await searchOne(everyone, first100);
	assert.deepEqual(
		stand.arxiv.requests.map((request) => request.start),
		[0, 100],
	);
	const lines = text.trimEnd().split("\n");
	assert.equal(
		lines[0],
		"topic 2 (130 found, 100 already in the digests):".replace(
			"topic 2",
			"topic 1",
		),
	);
	assert.equal(lines.length, 31);
});

test("A topic with no results prints its header and 'none'", async () => {
	const { text } = await searchOne([], [], TOPIC_2);
	assert.equal(text, "topic 2 (0 found):\nnone\n");
});

test("Papers accepted at a listed conference come first when the 40 are chosen, each with its journal reference", async () => {
	// 50 papers, newest first; the 2 oldest are accepted at ACL, which has a list.
	const listed = papers(50).map((paper, n) => {
		if (n >= 48) {
			return { ...paper, journal: "Proceedings of ACL 2026" };
		}
		return {
			...paper,
			published: `2026-10-${String(11 - Math.floor(n / 10)).padStart(2, "0")}`,
		};
	});
	listed[48] = { ...listed[48], published: "2026-09-02" } as ArxivPaper;
	listed[49] = { ...listed[49], published: "2026-09-01" } as ArxivPaper;
	const { text } = await searchOne(listed, [], TOPIC_1, ["ACL"]);
	const lines = text.trimEnd().split("\n");
	assert.equal(lines[0], "topic 1 (50 found, 10 left out):");
	assert.equal(
		lines[1],
		`2026-09-02 ${idOf(48)} Paper 48 | Proceedings of ACL 2026`,
	);
	assert.equal(
		lines[2],
		`2026-09-01 ${idOf(49)} Paper 49 | Proceedings of ACL 2026`,
	);
	assert.equal(lines.length, 41);
	// The other 38 are the newest of the rest.
	assert.equal(
		lines.slice(3).some((line) => line.includes("ACL")),
		false,
	);
	assert.equal(lines[3]?.startsWith("2026-10-11 "), true);
});

test("A query arXiv rejects is named, the run is marked failed, and the next topic is still searched", async () => {
	stand.arxiv.answer = (request) => {
		if (request.query?.includes("sparse autoencoder")) {
			return { status: 400, body: "" };
		}
		return pageOf(
			[{ id: idOf(7), title: "Paper 7", published: "2026-10-10" }],
			request,
		);
	};
	const run = { failed: false, arxivStopped: false };
	const kept: Pool.Pool = {};
	const first = await withStderr(() =>
		search.searchTopic(
			TOPIC_1,
			"20260813",
			"20261012",
			DAY,
			new Set(),
			kept,
			run,
		),
	);
	const second = await search.searchTopic(
		TOPIC_2,
		"20260813",
		"20261012",
		DAY,
		new Set(),
		kept,
		run,
	);
	assert.match(
		first.stderr,
		/arXiv rejected topic 1's query \(http:\/\/127\.0\.0\.1:\d+\/api\/query\?/,
	);
	assert.equal(first.result.notSearched, "arXiv rejected its query");
	assert.equal(run.failed, true);
	assert.equal(run.arxivStopped, false);
	assert.equal(second.found, 1);
});

for (const [failure, answer, words] of [
	[
		"HTTP 429",
		{ status: 429, body: "Rate exceeded." },
		'answered HTTP 429 "Rate exceeded."',
	],
	[
		"an HTML page",
		{ status: 200, body: "<html>maintenance</html>" },
		"answered with something that isn't an arXiv feed",
	],
] as const) {
	test(`limit: When arXiv answers ${failure} at every try, the search is tried 5 times and the next topic is not searched`, async () => {
		stand.arxiv.answer = () => answer;
		const run = { failed: false, arxivStopped: false };
		const kept: Pool.Pool = {};
		const first = await withStderr(() =>
			search.searchTopic(
				TOPIC_1,
				"20260813",
				"20261012",
				DAY,
				new Set(),
				kept,
				run,
			),
		);
		const second = await search.searchTopic(
			TOPIC_2,
			"20260813",
			"20261012",
			DAY,
			new Set(),
			kept,
			run,
		);
		assert.equal(
			stand.arxiv.requests.length,
			5,
			"the first try and the 4 retries",
		);
		assert.equal(run.failed && run.arxivStopped, true);
		assert.match(first.stderr, /arXiv refused the search after 4 retries/);
		assert.ok(first.stderr.includes(words), first.stderr);
		assert.match(first.stderr, /no more arXiv requests in this run/);
		assert.equal(second.notSearched, "no more arXiv requests in this run");
		assert.equal(stand.arxiv.requests.length, 5, "topic 2 asked nothing");
	});
}

test("limit: A search refused once is answered on the second try, and the run notes one retry", async () => {
	let asked = 0;
	stand.arxiv.answer = (request) => {
		asked += 1;
		if (asked === 1) {
			return { status: 429, body: "Rate exceeded." };
		}
		return pageOf(
			[{ id: idOf(1), title: "Paper 1", published: "2026-10-10" }],
			request,
		);
	};
	const run = { failed: false, arxivStopped: false };
	const { result, stderr } = await withStderr(() =>
		search.searchTopic(
			TOPIC_1,
			"20260813",
			"20261012",
			DAY,
			new Set(),
			{},
			run,
		),
	);
	assert.equal(result.found, 1);
	assert.equal(run.failed, false);
	assert.equal(stderr.match(/retry \d of 4/g)?.length, 1);
	assert.match(stderr, /retry 1 of 4 in 1 minute/);
});

// ---- the candidate pool ----

function record(
	id: string,
	extra: Partial<Pool.PoolRecord> = {},
): Pool.PoolRecord {
	return {
		id: id,
		title: `Paper ${id}`,
		abstract: "Abstract.",
		authors: ["Ada Example"],
		published: "2026-10-05",
		note: null,
		topics: [1],
		firstSeen: "2026-10-06",
		...extra,
	};
}

test("The pool keeps a paper found last week and drops one found 61 days ago and one now in the digests", () => {
	const kept: Pool.Pool = {
		a: record("2610.00001", { firstSeen: "2026-10-06" }),
		b: record("2608.00002", {
			firstSeen: "2026-08-12",
			published: "2026-08-10",
		}),
		c: record("2610.00003"),
	};
	// Keyed as pool.json is, by the record's own id.
	const byId = Object.fromEntries(
		Object.values(kept).map((value) => [value.id, value]),
	);
	pool.prunePool(byId, new Set(["2610.00003"]), DAY);
	assert.deepEqual(Object.keys(byId), ["2610.00001"]);
});

test("A paper found again keeps the day it was first found, and gains the topic", () => {
	const kept: Pool.Pool = {
		"2610.00001": record("2610.00001", {
			firstSeen: "2026-08-14",
			topics: [1],
		}),
	};
	pool.addToPool(
		kept,
		[
			{
				id: "arxiv:2610.00001",
				title: "Paper 2610.00001",
				authors: ["Ada Example"],
				published: "2026-10-05",
				abstract: "New abstract.",
			} as never,
		],
		2,
		DAY,
	);
	assert.equal(kept["2610.00001"]?.firstSeen, "2026-08-14");
	assert.deepEqual(kept["2610.00001"]?.topics, [1, 2]);
	assert.equal(kept["2610.00001"]?.abstract, "New abstract.");
});

test("A candidate first submitted more than 60 days before the day is not offered, however late it was found", () => {
	const result: Pool.TopicResult = {
		topic: 1,
		found: 0,
		alreadyIn: 0,
		today: new Set<string>(),
		candidates: [],
		earlier: 0,
		listed: 0,
		huggingFace: 0,
		notSearched: null,
	};
	const kept: Pool.Pool = {
		"2608.00001": record("2608.00001", {
			published: "2026-08-12",
			firstSeen: "2026-10-02",
		}),
		"2610.00002": record("2610.00002", { published: "2026-10-05" }),
	};
	search.topicCandidates(result, kept, DAY, []);
	assert.deepEqual(
		result.candidates.map((candidate) => candidate.id),
		["2610.00002"],
	);
});

test("The whole output stays under 30,000 characters, and every topic prints the same number of lines, fewer than 40", () => {
	const kept: Pool.Pool = {};
	const results = Array.from({ length: 8 }, (_, t) => ({
		topic: t + 1,
		found: 100,
		alreadyIn: 0,
		today: new Set<string>(),
		candidates: [] as Pool.PoolRecord[],
		earlier: 0,
		listed: 0,
		huggingFace: 0,
		notSearched: null,
	}));
	for (const result of results) {
		for (let n = 0; n < 100; n++) {
			const id = `26${String(result.topic).padStart(2, "0")}.${String(n).padStart(5, "0")}`;
			kept[id] = record(id, {
				title: "T".repeat(100),
				note: "N".repeat(60),
				topics: [result.topic],
				published: "2026-10-05",
			});
		}
		search.topicCandidates(result, kept, DAY, []);
	}
	const text = pool.outputText(results, []);
	assert.ok(text.length < 30000, `${text.length} characters`);
	const counts = text
		.split(/^topic \d \(.*\n/m)
		.slice(1)
		.map((block) => block.trimEnd().split("\n").length);
	assert.equal(counts.length, 8);
	assert.equal(new Set(counts).size, 1, `${counts}`);
	assert.ok((counts[0] ?? 40) < 40);
});

test("A topic arXiv can't search today still prints its earlier candidates and says it wasn't searched", async () => {
	stand.arxiv.answer = () => ({ status: 503, body: "" });
	const run = { failed: false, arxivStopped: false };
	const kept: Pool.Pool = {
		"2610.00001": record("2610.00001", {
			published: "2026-10-10",
			firstSeen: "2026-10-11",
		}),
	};
	const { result } = await withStderr(() =>
		search.searchTopic(
			TOPIC_1,
			"20260813",
			"20261012",
			DAY,
			new Set(),
			kept,
			run,
		),
	);
	search.topicCandidates(result, kept, DAY, []);
	const text = pool.outputText([result], []);
	assert.equal(
		text.split("\n")[0],
		"topic 1 (not searched today: arXiv API answered HTTP 503; 1 from earlier searches):",
	);
	assert.match(
		text.split("\n")[1] ?? "",
		/^2026-10-10 2610\.00001 Paper 2610\.00001$/,
	);
});

// ---- Google News ----

// The run starts at 05:00 in Jakarta on 2026-10-12; a headline is published so many hours before it.
const RUN_START = Date.parse("2026-10-12T05:00:00+07:00");
const hoursBefore = (hours: number) =>
	new Date(RUN_START - hours * 3600 * 1000);

async function searchNews(
	topic: Topic,
	own: Topic | undefined,
	date: string | null,
	run = { failed: false, arxivStopped: false },
) {
	return withStderr(() =>
		news.searchNews(
			topic,
			own,
			date === null ? RUN_START : Date.parse(`${date}T08:30:00+07:00`),
			date,
			run,
		),
	);
}

test('A topic\'s news phrases make one 2-day search for the plain phrases and one per "A & B" phrase, and a headline found twice is printed once', async () => {
	stand.news.answer = () => ({
		status: 200,
		body: rss([
			newsItem(
				"Chatbot logs get differential privacy",
				"Wired",
				hoursBefore(3),
			),
		]),
	});
	const { result: lines } = await searchNews(
		TOPIC_2,
		{ topic: 2, phrases: ["differential privacy", "chatbot & privacy"] },
		null,
	);
	const queries = stand.news.requests.map((url) =>
		new URL(url, "http://x").searchParams.get("q"),
	);
	assert.deepEqual(queries, [
		'("differential privacy") when:2d',
		'"chatbot" "privacy" when:2d',
	]);
	assert.deepEqual(lines, [
		"news, topic 2 (1 found):",
		"2026-10-12 Wired: Chatbot logs get differential privacy",
	]);
});

test("A topic prints its newest 5 headlines as date, source and headline without links, counts the rest, and cuts a long headline at 100 characters", async () => {
	const items = Array.from({ length: 9 }, (_, n) =>
		newsItem(`Headline ${n + 1}`, "Reuters", hoursBefore(n + 1)),
	);
	items[0] = newsItem("H".repeat(150), "Reuters", hoursBefore(1));
	stand.news.answer = () => ({ status: 200, body: rss(items) });
	const { result: lines } = await searchNews(
		TOPIC_2,
		{ topic: 2, phrases: ["labor market"] },
		null,
	);
	assert.equal(lines[0], "news, topic 2 (9 found, 4 left out):");
	assert.equal(lines.length, 6);
	assert.equal(lines[1], `2026-10-12 Reuters: ${"H".repeat(99)}…`);
	assert.equal(lines[5], "2026-10-12 Reuters: Headline 5");
	assert.equal(
		lines.some((line) => line.includes("http")),
		false,
	);
});

test("A headline published more than 48 hours before the run, or with no date, is left out and counted", async () => {
	stand.news.answer = () => ({
		status: 200,
		body: rss([
			newsItem("One hour old", "Reuters", hoursBefore(1)),
			newsItem("Forty-seven hours old", "Reuters", hoursBefore(47)),
			newsItem("Forty-nine hours old", "Reuters", hoursBefore(49)),
			newsItem("No date", "Reuters", null),
		]),
	});
	const { result: lines } = await searchNews(
		TOPIC_2,
		{ topic: 2, phrases: ["labor market"] },
		null,
	);
	assert.deepEqual(lines, [
		"news, topic 2 (4 found, 2 older than 48 hours or undated):",
		"2026-10-12 Reuters: One hour old",
		"2026-10-10 Reuters: Forty-seven hours old",
	]);
});

test("A topic with no news phrases is searched with its search phrases, and its header says so", async () => {
	const { result: lines } = await searchNews(TOPIC_2, undefined, null);
	const queries = stand.news.requests.map((url) =>
		new URL(url, "http://x").searchParams.get("q"),
	);
	assert.deepEqual(queries, ['("labor market") when:2d']);
	assert.equal(
		lines[0],
		"news, topic 2 (no news phrases in interests.md, searched with its search phrases; 0 found):",
	);
	assert.equal(lines[1], "none");
});

test("A news feed that fails is named, the run is marked failed, and the topic says it wasn't read", async () => {
	stand.news.answer = () => ({ status: 503, body: "" });
	const run = { failed: false, arxivStopped: false };
	const { result: lines, stderr } = await searchNews(
		TOPIC_2,
		{ topic: 2, phrases: ["labor market"] },
		null,
		run,
	);
	assert.match(
		stderr,
		/Google News answered HTTP 503 \(http:\/\/127\.0\.0\.1:\d+\/rss\?/,
	);
	assert.equal(run.failed, true);
	assert.deepEqual(lines, ["news, topic 2 (not read: answered HTTP 503):"]);
});

test("An HTTP 200 answer that isn't an RSS feed fails the run instead of counting as a day without news", async () => {
	stand.news.answer = () => ({
		status: 200,
		body: "<html>Before you continue</html>",
	});
	const run = { failed: false, arxivStopped: false };
	const { result: lines } = await searchNews(
		TOPIC_2,
		{ topic: 2, phrases: ["labor market"] },
		null,
		run,
	);
	assert.equal(run.failed, true);
	assert.deepEqual(lines, [
		"news, topic 2 (not read: answered with something that isn't an RSS feed):",
	]);
});

test("With a date given, Google News is asked for the days around it, and only headlines from the 48 hours before 08:30 that day are kept", async () => {
	const at = (text: string) => new Date(Date.parse(`${text}+07:00`));
	stand.news.answer = () => ({
		status: 200,
		body: rss([
			newsItem("Before the run", "Reuters", at("2026-10-10T08:00:00")),
			newsItem("Just inside", "Reuters", at("2026-10-08T09:00:00")),
			newsItem("Just outside", "Reuters", at("2026-10-08T08:00:00")),
			newsItem("After the run", "Reuters", at("2026-10-10T09:00:00")),
		]),
	});
	const { result: lines } = await searchNews(
		TOPIC_2,
		{ topic: 2, phrases: ["labor market"] },
		"2026-10-10",
	);
	const [query] = stand.news.requests.map((url) =>
		new URL(url, "http://x").searchParams.get("q"),
	);
	assert.equal(query, '("labor market") after:2026-10-07 before:2026-10-11');
	assert.deepEqual(lines, [
		"news, topic 2 (4 found, 2 outside the 48 hours or undated):",
		"2026-10-10 Reuters: Before the run",
		"2026-10-08 Reuters: Just inside",
	]);
});

// ---- the conference lists and the title lookups ----

const TOPICS = [TOPIC_1, TOPIC_2];

// The stand-in's catalogue of arXiv papers: a title search finds the paper whose title it names, an id_list the ones listed.
function serveCatalogue(catalogue: ArxivPaper[]) {
	const squash = (text: string) =>
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, " ")
			.trim();
	stand.arxiv.answer = (request) => {
		let found: ArxivPaper[] = [];
		if (request.ids.length > 0) {
			found = catalogue.filter((paper) => request.ids.includes(paper.id));
		} else {
			const exact = /^ti:"(.*)"$/.exec(request.query ?? "");
			if (exact !== null) {
				found = catalogue.filter(
					(paper) => squash(paper.title) === squash(String(exact[1])),
				);
			}
		}
		return pageOf(found, { ...request, start: 0, maxResults: 100 });
	};
}

// A CSV list at `path` holding these titles; the plan reads it as FAccT's list.
function serveList(path: string, titles: string[]) {
	stand.pages[path] = () => ({
		status: 200,
		body: `Title\n${titles.join("\n")}\n`,
	});
}

function listAt(venue: string, path: string, published: string | null = null) {
	return { venue: venue, url: `${stand.base}${path}`, published: published };
}

type Lookups = Record<string, ArxivSearch.Lookup>;

// Reads the lists, looks the matching titles up and prints each list's lines, as the plan does.
async function readAndLookUp(
	lists: ReturnType<typeof listAt>[],
	keptLists: Record<string, unknown> = {},
	lookups: Lookups = {},
	inDigests: string[] = [],
) {
	const run = { failed: false, arxivStopped: false };
	const read = await venueLists.readLists(lists, keptLists, DAY, run);
	for (const list of read) {
		list.matching = venueLists.matchingPapers(list.titles, TOPICS);
	}
	const looked = await arxivSearch.lookUpTitles(read, lookups, DAY, run);
	const digests = new Set(inDigests);
	const lines = read.flatMap((list) =>
		arxivSearch.listLines(list, lookups, looked.waiting, digests, run),
	);
	return {
		read: read,
		lookups: lookups,
		waiting: looked.waiting,
		lines: lines,
		run: run,
	};
}

const FIND = (n: number): string => `Sparse Autoencoder Circuits ${n}`;

test("A matching title gets its arXiv id and is printed with its date; a title that matches no phrase is never looked up", async () => {
	serveList("/lists/aies.csv", [
		"Sparse Autoencoders Find Deception Features in Language Models",
		"Fairness of Loan Approval Models",
	]);
	serveCatalogue([
		{
			id: "2606.12345",
			title: "Sparse Autoencoders Find Deception Features in Language Models",
			published: "2026-06-02",
		},
	]);
	const { lines, lookups } = await readAndLookUp([
		listAt("AIES", "/lists/aies.csv"),
	]);
	assert.deepEqual(lines, [
		`AIES (${stand.base}/lists/aies.csv) (publication date unknown; 2 titles, 1 match the topics, 1 on arXiv):`,
		"2026-06-02 2606.12345 Sparse Autoencoders Find Deception Features in Language Models",
	]);
	assert.equal(stand.arxiv.requests.length, 1);
	assert.deepEqual(Object.values(lookups), [
		{
			id: "2606.12345",
			arxivDate: "2026-06-02",
			checked: DAY,
			title: "Sparse Autoencoders Find Deception Features in Language Models",
			authors: ["Ada Example"],
			abstract: "Abstract of 2606.12345.",
		},
	]);
});

test("An arXiv paper whose title differs from the list title is not taken, and the title is kept as not on arXiv for today", async () => {
	serveList("/lists/aies.csv", ["Sparse Autoencoder Probes"]);
	serveCatalogue([
		{
			id: "2606.00001",
			title: "Sparse Autoencoder Probes for Vision",
			published: "2026-06-02",
		},
	]);
	// arXiv's phrase search misses nothing here, but answers with a longer title for whatever is asked.
	stand.arxiv.answer = (request) =>
		pageOf(
			[
				{
					id: "2606.00001",
					title: "Sparse Autoencoder Probes for Vision",
					published: "2026-06-02",
				},
			],
			request,
		);
	const { lines, lookups } = await readAndLookUp([
		listAt("AIES", "/lists/aies.csv"),
	]);
	assert.equal(lines.length, 1);
	assert.match(lines[0] ?? "", /1 match the topics, 0 on arXiv\):$/);
	assert.deepEqual(Object.values(lookups), [
		{ id: null, arxivDate: null, checked: DAY },
	]);
});

test("At most 8 lines are printed per list, newest arXiv date first, the rest counted", async () => {
	const titles = Array.from({ length: 11 }, (_, n) => FIND(n));
	serveList("/lists/acl.csv", titles);
	const lookups: Lookups = {};
	for (const [n, title] of titles.entries()) {
		lookups[title.toLowerCase()] = {
			id: idOf(n),
			arxivDate: `2026-09-${String(n + 10).padStart(2, "0")}`,
			checked: "2026-10-01",
		};
	}
	const { lines } = await readAndLookUp(
		[listAt("ACL", "/lists/acl.csv")],
		{},
		lookups,
	);
	assert.match(
		lines[0] ?? "",
		/11 match the topics, 11 on arXiv, 3 left out\):$/,
	);
	assert.equal(lines.length, 9);
	assert.equal(lines[1], `2026-09-20 ${idOf(10)} ${FIND(10)}`);
	assert.equal(lines[8], `2026-09-13 ${idOf(3)} ${FIND(3)}`);
	assert.equal(
		stand.arxiv.requests.length,
		0,
		"kept answers are not asked again",
	);
});

test("limit: At most 60 titles are looked up per run, titles never asked first, and the rest are counted as still to look up", async () => {
	const fresh = Array.from({ length: 70 }, (_, n) => FIND(n));
	const old = Array.from(
		{ length: 5 },
		(_, n) => `Activation Steering Study ${n}`,
	);
	serveList("/lists/neurips.csv", fresh);
	serveList("/lists/aies.csv", old);
	serveCatalogue(
		fresh.map((title, n) => ({
			id: idOf(n),
			title: title,
			published: "2026-09-01",
		})),
	);
	const lookups: Lookups = {};
	for (const title of old) {
		lookups[title.toLowerCase()] = {
			id: null,
			arxivDate: null,
			checked: "2026-09-11",
		};
	}
	// The AIES list comes first in interests.md order, yet its answers are 31 days old: the never-asked titles go first.
	const { waiting } = await readAndLookUp(
		[
			listAt("AIES", "/lists/aies.csv"),
			listAt("NeurIPS", "/lists/neurips.csv"),
		],
		{},
		lookups,
	);
	assert.equal(stand.arxiv.requests.length, 60);
	assert.equal(
		stand.arxiv.requests.every((request) =>
			request.query?.includes("Sparse Autoencoder Circuits"),
		),
		true,
	);
	assert.equal(waiting.size, 15);
});

test("A 'not on arXiv' answer from 20 days ago is reused and one from 31 days ago is asked again, while a found id is kept for good", async () => {
	const titles = [FIND(1), FIND(2), FIND(3)];
	serveList("/lists/aies.csv", titles);
	serveCatalogue([]);
	const lookups: Lookups = {
		[titles[0]?.toLowerCase() ?? ""]: {
			id: "2606.12345",
			arxivDate: "2026-06-02",
			checked: "2026-09-02",
		},
		[titles[1]?.toLowerCase() ?? ""]: {
			id: null,
			arxivDate: null,
			checked: "2026-09-22",
		},
		[titles[2]?.toLowerCase() ?? ""]: {
			id: null,
			arxivDate: null,
			checked: "2026-09-11",
		},
	};
	const { lines } = await readAndLookUp(
		[listAt("AIES", "/lists/aies.csv")],
		{},
		lookups,
	);
	const exactSearches = stand.arxiv.requests
		.map((request) => request.query)
		.filter((query) => query?.startsWith('ti:"'));
	assert.deepEqual(
		exactSearches,
		[`ti:"${FIND(3)}"`],
		"only the third title is asked",
	);
	assert.ok(lines.some((line) => line.includes("2606.12345")));
});

test("Papers already in the digests are left out of the list lines and counted", async () => {
	serveList("/lists/aies.csv", [FIND(1)]);
	const lookups: Lookups = {
		[FIND(1).toLowerCase()]: {
			id: "2606.12345",
			arxivDate: "2026-06-02",
			checked: "2026-10-01",
		},
	};
	const { lines } = await readAndLookUp(
		[listAt("AIES", "/lists/aies.csv")],
		{},
		lookups,
		["2606.12345"],
	);
	assert.equal(lines.length, 1);
	assert.match(
		lines[0] ?? "",
		/1 match the topics, 1 on arXiv, 1 already in the digests\):$/,
	);
});

test("A list's publication date is shown when interests.md gives one", async () => {
	serveList("/lists/pets.csv", []);
	serveList("/lists/acl.csv", []);
	const { lines } = await readAndLookUp([
		listAt("PETS", "/lists/pets.csv", "2026-10-01"),
		listAt("ACL", "/lists/acl.csv"),
	]);
	assert.match(lines[0] ?? "", /\(published 2026-10-01; /);
});

// A paper listed twice, as an oral and as a poster, in the JSON format the NeurIPS list uses.
function serveTwoNames(path: string) {
	stand.pages[path] = () => ({
		status: 200,
		body: JSON.stringify({
			results: [
				{
					name: "Sparse Autoencoder Features at Scale",
					paper_url: "https://openreview.net/forum?id=ABC123",
				},
				{
					name: "Activation Steering in Practice",
					paper_url: "https://openreview.net/forum?id=ABC123",
				},
			],
		}),
	});
}

test("A paper listed under two titles is looked up once when its first title finds it", async () => {
	serveTwoNames("/lists/neurips.json");
	serveCatalogue([
		{
			id: "2609.11111",
			title: "Sparse Autoencoder Features at Scale",
			published: "2026-09-05",
		},
	]);
	const { lines } = await readAndLookUp([
		listAt("NeurIPS", "/lists/neurips.json"),
	]);
	assert.equal(stand.arxiv.requests.length, 1);
	assert.equal(lines.length, 2);
	assert.match(lines[1] ?? "", /^2026-09-05 2609\.11111 /);
});

test("A paper's second title is looked up when its first finds nothing", async () => {
	serveTwoNames("/lists/neurips.json");
	serveCatalogue([
		{
			id: "2609.11111",
			title: "Activation Steering in Practice",
			published: "2026-09-05",
		},
	]);
	const { lines } = await readAndLookUp([
		listAt("NeurIPS", "/lists/neurips.json"),
	]);
	const exact = stand.arxiv.requests
		.map((request) => request.query)
		.filter((query) => query?.startsWith('ti:"'));
	assert.deepEqual(exact, [
		'ti:"Sparse Autoencoder Features at Scale"',
		'ti:"Activation Steering in Practice"',
	]);
	assert.equal(lines.length, 2);
	assert.match(lines[1] ?? "", /^2026-09-05 2609\.11111 /);
});

test("An unchanged list is not downloaded again: the kept ETag is sent and a 304 keeps the titles", async () => {
	stand.pages["/lists/neurips.csv"] = (incoming) => {
		if (incoming.headers["if-none-match"] === '"v1"') {
			return { status: 304, body: "" };
		}
		return {
			status: 200,
			body: `Title\n${FIND(1)}\n`,
			headers: { etag: '"v1"' },
		};
	};
	const kept: Record<string, unknown> = {};
	const first = await readAndLookUp(
		[listAt("NeurIPS", "/lists/neurips.csv")],
		kept,
	);
	const second = await readAndLookUp(
		[listAt("NeurIPS", "/lists/neurips.csv")],
		kept,
	);
	assert.equal(stand.pageRequests[1]?.headers["if-none-match"], '"v1"');
	assert.deepEqual(second.read[0]?.titles, first.read[0]?.titles);
	assert.deepEqual(second.read[0]?.titles, [FIND(1)]);
});

test("A list that can't be downloaded uses the kept copy, says so, and fails the run", async () => {
	serveList("/lists/pets.csv", [FIND(1), FIND(2)]);
	const kept: Record<string, unknown> = {};
	await readAndLookUp([listAt("PETS", "/lists/pets.csv")], kept);
	stand.pages["/lists/pets.csv"] = () => ({ status: 503, body: "" });
	const { stderr, result } = await withStderr(() =>
		readAndLookUp([listAt("PETS", "/lists/pets.csv")], kept),
	).then((done) => ({ stderr: done.stderr, result: done.result }));
	assert.match(
		stderr,
		/PETS list answered HTTP 503 \(http:\/\/127\.0\.0\.1:\d+\/lists\/pets\.csv\)/,
	);
	assert.deepEqual(result.read[0]?.titles, [FIND(1), FIND(2)]);
	assert.equal(result.read[0]?.copyKept, DAY);
	assert.match(
		result.lines[0] ?? "",
		/; titles from the copy kept 2026-10-12; 2 titles/,
	);
	assert.equal(result.run.failed, true);
});

test("A title missing from a later download stays, and a new title is added after the kept ones", async () => {
	serveList("/lists/pets.csv", [FIND(1), FIND(2)]);
	const kept: Record<string, unknown> = {};
	await readAndLookUp([listAt("PETS", "/lists/pets.csv")], kept);
	serveList("/lists/pets.csv", [FIND(3), FIND(1)]);
	const { read } = await readAndLookUp(
		[listAt("PETS", "/lists/pets.csv")],
		kept,
	);
	assert.deepEqual(read[0]?.titles, [FIND(1), FIND(2), FIND(3)]);
	const keptList = kept[`${stand.base}/lists/pets.csv`] as { titles: string[] };
	assert.deepEqual(keptList.titles, [FIND(1), FIND(2), FIND(3)]);
});

test("A list that can't be read at all is named in its header and the others are still read", async () => {
	stand.pages["/lists/pets.csv"] = () => ({ status: 404, body: "" });
	serveList("/lists/acl.csv", [FIND(1)]);
	const { lines, run } = await readAndLookUp([
		listAt("PETS", "/lists/pets.csv"),
		listAt("ACL", "/lists/acl.csv"),
	]);
	assert.equal(
		lines[0],
		`PETS (${stand.base}/lists/pets.csv) (not read: answered HTTP 404):`,
	);
	assert.match(lines[1] ?? "", /^ACL \(/);
	assert.equal(run.failed, true);
});

test("A list page in a format the script doesn't read is named and fails the run", async () => {
	stand.pages["/lists/aies.html"] = () => ({
		status: 200,
		body: "<html><body>Maintenance</body></html>",
	});
	const { stderr, result } = await withStderr(() =>
		readAndLookUp([listAt("AIES", "/lists/aies.html")]),
	);
	assert.match(
		stderr,
		/no titles found in the AIES list \(http:\/\/127\.0\.0\.1:\d+\/lists\/aies\.html\)/,
	);
	assert.equal(result.run.failed, true);
});

// ---- conference papers in the pool ----

test("Papers found by title lookup get their abstracts through arXiv's id_list, 100 per request, and one with no abstract stays out of the pool", async () => {
	const titles = Array.from({ length: 150 }, (_, n) => FIND(n));
	const lookups: Lookups = {};
	const catalogue: ArxivPaper[] = [];
	for (const [n, title] of titles.entries()) {
		lookups[title.toLowerCase()] = {
			id: idOf(n),
			arxivDate: "2026-06-02",
			checked: "2026-10-01",
		};
		// arXiv has every paper but the last.
		if (n < 149) {
			catalogue.push({ id: idOf(n), title: title, published: "2026-06-02" });
		}
	}
	serveCatalogue(catalogue);
	const run = { failed: false, arxivStopped: false };
	await withStderr(() => search.fillAbstracts(lookups, run));
	assert.deepEqual(
		stand.arxiv.requests.map((request) => request.ids.length),
		[100, 50],
	);
	assert.equal(
		lookups[FIND(0).toLowerCase()]?.abstract,
		`Abstract of ${idOf(0)}.`,
	);
	assert.equal(lookups[FIND(149).toLowerCase()]?.abstract, undefined);
	const list = {
		venue: "FAccT",
		url: "https://facct.example/2026/accepted.csv",
		published: null,
		titles: titles,
		copyKept: null,
		problem: null,
		matching: titles.map((title) => [title]),
	};
	const kept: Pool.Pool = {};
	pool.addListedToPool(kept, [list], lookups, TOPICS, new Set(), DAY);
	assert.equal(Object.keys(kept).length, 149);
	assert.equal(kept[idOf(149)], undefined);
	assert.equal(kept[idOf(0)]?.note, "FAccT 2026");
});

test("A conference paper submitted 90 days ago is a candidate of its topic, noted with its venue and year, before newer arXiv-only papers", () => {
	const list = {
		venue: "FAccT",
		url: "https://facct.example/2026/accepted.csv",
		published: null,
		titles: ["Sparse Autoencoder Circuits"],
		copyKept: null,
		problem: null,
		matching: [["Sparse Autoencoder Circuits"]],
	};
	const lookups: Lookups = {
		"sparse autoencoder circuits": {
			id: "2606.12345",
			arxivDate: "2026-07-14",
			checked: DAY,
			title: "Sparse Autoencoder Circuits",
			authors: ["Ada Example"],
			abstract: "Circuits.",
		},
	};
	const kept: Pool.Pool = {};
	for (const n of [1, 2, 3]) {
		kept[idOf(n)] = record(idOf(n), { published: "2026-10-10" });
	}
	pool.addListedToPool(kept, [list], lookups, TOPICS, new Set(), DAY);
	const result = {
		topic: 1,
		found: 3,
		alreadyIn: 0,
		today: new Set(["2610.00001", "2610.00002", "2610.00003"]),
		candidates: [] as Pool.PoolRecord[],
		earlier: 0,
		listed: 0,
		huggingFace: 0,
		notSearched: null,
	};
	search.topicCandidates(result, kept, DAY, ["FAccT"]);
	const lines = pool.outputText([result], []).trimEnd().split("\n");
	assert.equal(
		lines[1],
		"2026-07-14 2606.12345 Sparse Autoencoder Circuits | FAccT 2026",
	);
	assert.equal(lines.length, 5);
});

test("A conference title not on arXiv stays out of the pool", () => {
	const list = {
		venue: "FAccT",
		url: "https://facct.example/2026/accepted.csv",
		published: null,
		titles: ["Sparse Autoencoder Ethics"],
		copyKept: null,
		problem: null,
		matching: [["Sparse Autoencoder Ethics"]],
	};
	const lookups: Lookups = {
		"sparse autoencoder ethics": { id: null, arxivDate: null, checked: DAY },
	};
	const kept: Pool.Pool = {};
	pool.addListedToPool(kept, [list], lookups, TOPICS, new Set(), DAY);
	assert.deepEqual(kept, {});
});

// ---- the order of a topic's candidates ----

// A topic's printed ids in order, for these pool records and listed venues.
function order(records: Pool.PoolRecord[], venues: string[] = []): string[] {
	const kept: Pool.Pool = {};
	for (const one of records) {
		kept[one.id] = one;
	}
	const result: Pool.TopicResult = {
		topic: 1,
		found: records.length,
		alreadyIn: 0,
		today: new Set(records.map((one) => one.id)),
		candidates: [],
		earlier: 0,
		listed: 0,
		huggingFace: 0,
		notSearched: null,
	};
	search.topicCandidates(result, kept, DAY, venues);
	return result.candidates.map((candidate) => candidate.id);
}

test("Scored candidates come in order of weighted score, a low confidence does not change that order, and a paper weighted 0 comes last", () => {
	const scored = (id: string, weighted: number, confidence = 0.9) =>
		record(id, { weighted: weighted, confidence: confidence, score: 3 });
	assert.deepEqual(
		order([
			scored("2610.00001", 0.6),
			scored("2610.00002", 3, 0.3),
			scored("2610.00003", 2.85),
			scored("2610.00004", 0),
		]),
		["2610.00002", "2610.00003", "2610.00001", "2610.00004"],
	);
});

test("Equal scores are ordered by confidence, and papers Jev hasn't scored come first, newest first", () => {
	assert.deepEqual(
		order([
			record("2610.00001", { weighted: 2, confidence: 0.6, score: 3 }),
			record("2610.00002", { weighted: 2, confidence: 0.9, score: 3 }),
			record("2610.00003", { published: "2026-10-04" }),
			record("2610.00004", { published: "2026-10-09" }),
		]),
		["2610.00004", "2610.00003", "2610.00002", "2610.00001"],
	);
});

test("A paper accepted at a listed conference comes before a better-scored arXiv-only paper, and a venue not listed doesn't", () => {
	const strong = record("2610.00001", {
		weighted: 3,
		confidence: 0.9,
		score: 4,
	});
	const thinListed = record("2610.00002", {
		weighted: 0.5,
		confidence: 0.9,
		score: 1,
		note: "Accepted at NeurIPS 2026",
	});
	const thinElsewhere = record("2610.00003", {
		weighted: 0.5,
		confidence: 0.9,
		score: 1,
		note: "APSEC 2026",
	});
	assert.deepEqual(order([strong, thinListed, thinElsewhere], ["NeurIPS"]), [
		"2610.00002",
		"2610.00001",
		"2610.00003",
	]);
});

test("A paper found again keeps its score, and the pool record keeps the fields search doesn't write", () => {
	const kept: Pool.Pool = {
		"2610.00001": record("2610.00001", {
			score: 3,
			confidence: 0.9,
			weighted: 2.85,
			topicProbabilities: { t1: 1 },
			scoredOn: "2026-10-11",
		}),
	};
	pool.addToPool(
		kept,
		[
			{
				id: "arxiv:2610.00001",
				title: "Paper 2610.00001",
				authors: ["Ada Example"],
				published: "2026-10-05",
				abstract: "Again.",
			} as never,
		],
		1,
		DAY,
	);
	assert.equal(kept["2610.00001"]?.score, 3);
	assert.equal(kept["2610.00001"]?.weighted, 2.85);
	assert.equal(kept["2610.00001"]?.scoredOn, "2026-10-11");
});

test("limit: A title lookup refused once is retried and then finds the paper, with one retry noted", async () => {
	serveList("/lists/aies.csv", [FIND(1)]);
	let asked = 0;
	stand.arxiv.answer = (request) => {
		asked += 1;
		if (asked === 1) {
			return { status: 429, body: "Rate exceeded." };
		}
		return pageOf(
			[{ id: "2606.12345", title: FIND(1), published: "2026-06-02" }],
			request,
		);
	};
	const { result, stderr } = await withStderr(() =>
		readAndLookUp([listAt("AIES", "/lists/aies.csv")]),
	);
	assert.ok(result.lines.some((line) => line.includes("2606.12345")));
	assert.equal(stderr.match(/retry \d of 4/g)?.length, 1);
});
