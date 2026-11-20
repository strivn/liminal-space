// Tests of scripts/scout/search.ts run as the scout runs it: interests.md, a digests file and a cache folder in a temp folder,
// stand-ins on 127.0.0.1 for arXiv, Google News, Hugging Face and the conference lists, the exit code, what it prints
// and what it keeps. Nothing here reaches another host.

import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, test } from "vitest";
import { closeServers } from "./local-server.ts";
import {
	digestText,
	removeTempFolders,
	runScript,
	scriptPath,
	tempFolder,
} from "./run-script.ts";
import type { ArxivPaper, StandIns } from "./search-stand-ins.ts";
import { newsItem, pageOf, rss, startStandIns } from "./search-stand-ins.ts";

const SEARCH = scriptPath("scout/search.ts");
const TODAY = "2026-10-12";

let stand: StandIns;

beforeEach(async () => {
	stand = await startStandIns();
	stand.pages["/hf/daily_papers"] = () => ({ status: 200, body: "[]" });
});
afterEach(closeServers);
afterAll(removeTempFolders);

type Setup = {
	folder: string;
	cache: string;
	interests: string;
	digests: string;
};

type Options = {
	// Replaces the interests.md text.
	interests?: string;
	lists?: string[];
	newsPhrases?: string[];
	digestLines?: string[];
};

// interests.md with two topics, the lists given as "- <venue>: <path under the stand-in>" lines, and a digests file.
function setup(options: Options = {}): Setup {
	const folder = tempFolder("liminal-unit-search-");
	const cache = join(folder, "cache");
	mkdirSync(cache);
	const interests = join(folder, "interests.md");
	const lists = (options.lists ?? []).map((line) =>
		line.replace("<base>", stand.base),
	);
	let text = [
		"# Interests",
		"",
		"## Topics, highest priority first",
		"1. Interpretability (weight 1.00): probes",
		"2. Labour (weight 0.90): jobs",
		"A paper on none of these topics has weight 0.75.",
		"",
		"## Search phrases",
		"1. sparse autoencoder, activation steering, deception & language model",
		"2. labor market",
		"",
	].join("\n");
	if (options.newsPhrases !== undefined) {
		text += `\n## News phrases\n${options.newsPhrases.join("\n")}\n`;
	}
	text += `\n## Conferences\n${lists.join("\n")}\n`;
	writeFileSync(interests, options.interests ?? text);
	const digests = join(folder, "digests.js");
	writeFileSync(digests, `${(options.digestLines ?? []).join("\n")}\n`);
	return {
		folder: folder,
		cache: cache,
		interests: interests,
		digests: digests,
	};
}

function plan(run: Setup, args: string[], env: Record<string, string> = {}) {
	return runScript(SEARCH, args, {
		ARXIV_API: `${stand.base}/api/query`,
		NEWS_RSS: `${stand.base}/rss`,
		HF_API: `${stand.base}/hf`,
		POPETS_BASE: stand.base,
		ACL_ANTHOLOGY_BASE: stand.base,
		AAAI_OJS_BASE: stand.base,
		CROSSREF_API: stand.base,
		INTERESTS_FILE: run.interests,
		LIMINAL_CACHE: run.cache,
		LIMINAL_TODAY: TODAY,
		// arXiv's pacing record goes in the run's own folder, not in the machine's temp folder.
		TMPDIR: run.folder,
		ARXIV_PAUSE_MS: "0",
		ARXIV_RETRY_MINUTE_MS: "5",
		PROCEEDINGS_PAUSE_MS: "0",
		...env,
	});
}

function papersFor(count: number, prefix = "2610"): ArxivPaper[] {
	return Array.from({ length: count }, (_, n) => ({
		id: `${prefix}.${String(n).padStart(5, "0")}`,
		title: `Paper ${n}`,
		published: "2026-10-10",
	}));
}

// Every arXiv search's query holds this text.
function queries(): string[] {
	return stand.arxiv.requests.map((request) => request.query ?? "");
}

test("A daily run searches arXiv over the 60 days ending today and Google News over 2 days, then prints the topics, lists and news", async () => {
	stand.arxiv.answer = (request) => {
		if (request.query?.includes("sparse autoencoder")) {
			return pageOf(papersFor(3), request);
		}
		if (request.query?.startsWith('ti:"')) {
			return pageOf(
				[
					{
						id: "2606.12345",
						title: "Sparse Autoencoder Circuits",
						published: "2026-06-02",
					},
				],
				request,
			);
		}
		return pageOf([], request);
	};
	stand.pages["/lists/facct/accepted.csv"] = () => ({
		status: 200,
		body: "Title\nSparse Autoencoder Circuits\nFairness of Loan Approval Models\n",
	});
	stand.news.answer = () => ({
		status: 200,
		body: rss([
			newsItem(
				"Labor market cools",
				"Reuters",
				// The run measures a headline's age from the real clock, not from LIMINAL_TODAY.
				new Date(Date.now() - 3600 * 1000),
			),
		]),
	});
	const run = setup({ lists: ["- FAccT: <base>/lists/facct/accepted.csv"] });
	const ran = await plan(run, [run.digests]);
	assert.equal(ran.code, 0, ran.stderr);
	const topicQueries = queries().filter((query) =>
		query.startsWith("submittedDate"),
	);
	assert.deepEqual(topicQueries, [
		'submittedDate:[202608130000 TO 202610122359] AND (abs:"sparse autoencoder" OR abs:"activation steering" OR (abs:"deception" AND abs:"language model"))',
		'submittedDate:[202608130000 TO 202610122359] AND (abs:"labor market")',
	]);
	const lines = ran.stdout.split("\n");
	assert.equal(lines[0], "topic 1 (3 found, 1 from conference lists):");
	assert.match(lines.join("\n"), /\ntopic 2 \(0 found\):\nnone\n/);
	assert.match(
		ran.stdout,
		/\nFAccT \(http:\/\/127\.0\.0\.1:\d+\/lists\/facct\/accepted\.csv\) \(publication date unknown; 2 titles, 1 match the topics, 1 on arXiv\):\n2026-06-02 2606\.12345 Sparse Autoencoder Circuits\n/,
	);
	assert.match(ran.stdout, /\ntitles still to look up: 0\n/);
	assert.match(
		ran.stdout,
		/\nnews, topic 2 \(no news phrases in interests\.md, searched with its search phrases; 1 found\):\n\d{4}-\d{2}-\d{2} Reuters: Labor market cools\n/,
	);
	assert.equal(
		stand.news.requests.every((url) =>
			decodeURIComponent(url).includes("when:2d"),
		),
		true,
	);
	assert.equal(
		/Reuters: .*http/.test(ran.stdout),
		false,
		"a headline has no link",
	);
});

test("With --date, the searches end on that day, a list published later is skipped and named, and nothing is kept for --cached", async () => {
	stand.pages["/lists/acl.csv"] = () => ({
		status: 200,
		body: "Title\nSparse Autoencoder Study\n",
	});
	stand.pages["/lists/facct.csv"] = () => ({
		status: 200,
		body: "Title\nFairness of Loan Approval Models\n",
	});
	const run = setup({
		lists: [
			"- ACL: <base>/lists/acl.csv (published 2026-10-11)",
			"- FAccT: <base>/lists/facct.csv (published 2026-10-01)",
		],
	});
	const ran = await plan(run, ["--date", "2026-10-10", run.digests]);
	assert.equal(ran.code, 0, ran.stderr);
	for (const query of queries().filter((q) => q.startsWith("submittedDate"))) {
		assert.ok(
			query.startsWith("submittedDate:[202608110000 TO 202610102359]"),
			query,
		);
	}
	assert.deepEqual(
		stand.pageRequests
			.map((request) => request.path)
			.filter((path) => path.startsWith("/lists")),
		["/lists/facct.csv"],
	);
	assert.match(
		ran.stdout,
		/\nACL list published on 2026-10-11, after 2026-10-10: left out\n/,
	);
	assert.match(ran.stdout, /\nFAccT \(.*\) \(published 2026-10-01; /);
	const asked = stand.news.requests.map((url) => decodeURIComponent(url));
	assert.equal(
		asked.length > 0 &&
			asked.every((url) => url.includes("after:2026-10-07 before:2026-10-11")),
		true,
	);
	assert.equal(
		asked.some((url) => url.includes("when:2d")),
		false,
	);
	assert.equal(existsSync(join(run.cache, "output.json")), false);
});

test("A --date after today, arguments that can't be used and missing arguments stop before any request", async () => {
	const run = setup();
	const late = await plan(run, ["--date", "2026-10-13", run.digests]);
	assert.notEqual(late.code, 0);
	assert.match(late.stderr, /--date is after today/);
	for (const args of [
		[],
		["--cached", "--date", "2026-10-10", run.digests],
		[run.digests, "extra"],
	]) {
		const ran = await plan(run, args);
		assert.notEqual(ran.code, 0, args.join(" "));
		assert.match(ran.stderr, /usage: node scripts\/scout\/search\.ts/);
	}
	assert.deepEqual(stand.all, []);
});

test("An interests.md without a Search phrases section, or with none of its topic lines, stops before any request", async () => {
	const none = setup({
		interests:
			"# Interests\n\n## Topics, highest priority first\n1. X (weight 1.00): y\n",
	});
	const missing = await plan(none, [none.digests]);
	assert.notEqual(missing.code, 0);
	assert.match(missing.stderr, /has no "Search phrases" section/);
	const prose = setup({
		interests: "## Search phrases\nOne line per topic.\n",
	});
	const empty = await plan(prose, [prose.digests]);
	assert.notEqual(empty.code, 0);
	assert.match(
		empty.stderr,
		/"Search phrases" section in interests\.md has no topic lines/,
	);
	assert.deepEqual(stand.all, []);
});

test("limit: When arXiv refuses every search, the run says so, asks 5 times in all, still prints, and lists the titles it didn't look up", async () => {
	stand.arxiv.answer = () => ({ status: 429, body: "Rate exceeded." });
	stand.pages["/lists/aies.csv"] = () => ({
		status: 200,
		body: "Title\nSparse Autoencoder Circuits\n",
	});
	const run = setup({ lists: ["- AIES: <base>/lists/aies.csv"] });
	const ran = await plan(run, [run.digests]);
	assert.notEqual(ran.code, 0);
	assert.equal(stand.arxiv.requests.length, 5);
	assert.match(ran.stderr, /arXiv refused the search after 4 retries/);
	assert.match(ran.stderr, /no more arXiv requests in this run/);
	assert.match(
		ran.stdout,
		/^topic 1 \(not searched today: arXiv API answered HTTP 429 "Rate exceeded\."\):\ntopic 2 \(not searched today: no more arXiv requests in this run\):\n/,
	);
	assert.match(ran.stdout, /\nnot looked up: Sparse Autoencoder Circuits\n/);
	assert.match(ran.stdout, /1 not looked up\):/);
});

test("When Google News, a list and Hugging Face fail, each is named, the topics are still printed, and the run exits non-zero", async () => {
	stand.arxiv.answer = (request) => pageOf(papersFor(2), request);
	stand.news.answer = () => ({ status: 503, body: "" });
	stand.pages["/lists/pets.csv"] = () => ({ status: 404, body: "" });
	stand.pages["/hf/daily_papers"] = () => ({ status: 503, body: "" });
	const run = setup({ lists: ["- PETS: <base>/lists/pets.csv"] });
	const ran = await plan(run, [run.digests]);
	assert.notEqual(ran.code, 0);
	assert.match(ran.stderr, /Google News answered HTTP 503/);
	assert.match(ran.stderr, /Hugging Face answered HTTP 503/);
	assert.match(ran.stdout, /^topic 1 \(2 found\):\n/);
	assert.match(ran.stdout, /\nPETS \(.*\) \(not read: answered HTTP 404\):\n/);
	assert.match(
		ran.stdout,
		/\nnews, topic 1 \(.*not read: answered HTTP 503\):\n/,
	);
});

test("A pool.json that doesn't load is named and the run goes on with a new one", async () => {
	stand.arxiv.answer = (request) => pageOf(papersFor(2), request);
	const run = setup();
	writeFileSync(join(run.cache, "pool.json"), "{ not json");
	const ran = await plan(run, [run.digests]);
	assert.equal(ran.code, 0, ran.stderr);
	assert.match(
		ran.stderr,
		/pool\.json doesn't load; this run goes on without it/,
	);
	assert.match(
		ran.stdout,
		/^topic 1 \(2 found\):\n2026-10-10 2610\.0000[01] Paper [01]\n/,
	);
	assert.deepEqual(
		Object.keys(
			JSON.parse(readFileSync(join(run.cache, "pool.json"), "utf8")),
		).sort(),
		["2610.00000", "2610.00001"],
	);
});

test("limit: Hugging Face is read once a day: a second run asks it nothing", async () => {
	const run = setup();
	await plan(run, [run.digests]);
	const first = stand.pageRequests.filter((request) =>
		request.path.startsWith("/hf"),
	).length;
	assert.ok(first > 0);
	await plan(run, [run.digests]);
	assert.equal(
		stand.pageRequests.filter((request) => request.path.startsWith("/hf"))
			.length,
		first,
	);
});

// ---- the ad-hoc search ----

test("An ad-hoc --query searches abstracts over all time in relevance order, 100 at a time, with no date in the query", async () => {
	const run = setup();
	await plan(run, [
		run.digests,
		"--query",
		"cooperative AI, multi-agent risk & language model",
	]);
	assert.equal(stand.arxiv.requests.length, 1);
	const [request] = stand.arxiv.requests;
	assert.equal(
		request?.query,
		'abs:"cooperative AI" OR (abs:"multi-agent risk" AND abs:"language model")',
	);
	assert.equal(request?.sortBy, "relevance");
	assert.equal(request?.maxResults, 100);
	assert.equal(request?.start, 0);
});

test("An --author search takes accents off the name, and with --query asks for both", async () => {
	const run = setup();
	await plan(run, [run.digests, "--author", "Bernhard Schölkopf"]);
	await plan(run, [
		run.digests,
		"--query",
		"cooperative AI",
		"--author",
		"Yoshua Bengio",
	]);
	assert.deepEqual(queries(), [
		'au:"Bernhard Scholkopf"',
		'au:"Yoshua Bengio" AND (abs:"cooperative AI")',
	]);
});

test("An ad-hoc search prints papers with a venue note first and the rest in arXiv's order, leaves out papers in the digests, and names the author in its header", async () => {
	const papers: ArxivPaper[] = [
		{ id: "2501.00001", title: "P1", published: "2025-01-01" },
		{
			id: "2501.00002",
			title: "P2",
			published: "2025-01-02",
			journal: "Journal of Examples 12",
		},
		{ id: "2501.00003", title: "P3", published: "2025-01-03" },
		{ id: "2501.00004", title: "P4", published: "2025-01-04" },
		{
			id: "2501.00005",
			title: "P5",
			published: "2025-01-05",
			comment: "Accepted at AIES 2025",
		},
	];
	stand.arxiv.answer = (request) => pageOf(papers, request);
	const run = setup({
		digestLines: [
			digestText("2026-10-01", [
				{
					id: "arxiv:2501.00003",
					type: "paper",
					title: "P3",
					authors: ["Ada Example"],
					published: "2025-01-03",
					source: "arXiv",
					url: "https://arxiv.org/abs/2501.00003",
					links: [],
					abstract: "x",
				},
			]),
		],
	});
	const ran = await plan(run, [run.digests, "--query", "cooperative AI"]);
	assert.equal(ran.code, 0, ran.stderr);
	assert.equal(
		ran.stdout,
		[
			'query "cooperative AI" (5 found, 1 already in the digests):',
			"2025-01-02 2501.00002 P2 | Journal of Examples 12",
			"2025-01-05 2501.00005 P5 | Accepted at AIES 2025",
			"2025-01-01 2501.00001 P1",
			"2025-01-04 2501.00004 P4",
			"",
		].join("\n"),
	);
	const byAuthor = await plan(run, [run.digests, "--author", "Yoshua Bengio"]);
	assert.match(
		byAuthor.stdout,
		/^author "Yoshua Bengio" \(5 found, 1 already in the digests\):\n/,
	);
});

test("An ad-hoc search prints at most 25, reads a second page when the first is used up, and counts the rest", async () => {
	const papers: ArxivPaper[] = Array.from({ length: 160 }, (_, n) => ({
		id: `2501.${String(n).padStart(5, "0")}`,
		title: `P${n}`,
		published: "2025-01-01",
	}));
	stand.arxiv.answer = (request) => pageOf(papers, request);
	const inDigests = papers.slice(0, 90).map((paper) => ({
		id: `arxiv:${paper.id}`,
		type: "paper",
		title: paper.title,
		authors: ["Ada Example"],
		published: "2025-01-01",
		source: "arXiv",
		url: `https://arxiv.org/abs/${paper.id}`,
		links: [],
		abstract: "x",
	}));
	const run = setup({ digestLines: [digestText("2026-10-01", inDigests)] });
	const ran = await plan(run, [run.digests, "--query", "cooperative AI"]);
	assert.deepEqual(
		stand.arxiv.requests.map((request) => request.start),
		[0, 100],
	);
	const lines = ran.stdout.trimEnd().split("\n");
	const header = lines[0];
	const printed = lines.length - 1;
	assert.equal(
		header,
		'query "cooperative AI" (160 found, 90 already in the digests, 45 left out):',
	);
	assert.equal(printed, 25);
});

test("An ad-hoc search runs none of the daily plan, writes nothing to the cache, needs no interests.md, and is not retried", async () => {
	stand.arxiv.answer = () => ({ status: 429, body: "Rate exceeded." });
	const run = setup();
	const ran = await plan(run, [run.digests, "--query", "cooperative AI"], {
		INTERESTS_FILE: join(run.folder, "missing.md"),
	});
	assert.notEqual(ran.code, 0);
	assert.equal(stand.arxiv.requests.length, 1, "one request, no retry");
	assert.match(
		ran.stderr,
		/arXiv answered HTTP 429 "Rate exceeded\." \(.*\); try again in a few minutes/,
	);
	assert.equal(
		stand.all.every((url) => url.startsWith("/api/query")),
		true,
		"nothing but arXiv's search was asked",
	);
	assert.deepEqual(readdirSync(run.cache), []);
});

test("An ad-hoc search names what arXiv answered: an HTML page, a rejected query", async () => {
	const run = setup();
	stand.arxiv.answer = () => ({
		status: 200,
		body: "<html>maintenance</html>",
	});
	const html = await plan(run, [run.digests, "--query", "cooperative AI"]);
	assert.notEqual(html.code, 0);
	assert.match(
		html.stderr,
		/arXiv answered with something that isn't an arXiv feed/,
	);
	stand.arxiv.answer = () => ({ status: 400, body: "" });
	const rejected = await plan(run, [run.digests, "--query", "cooperative AI"]);
	assert.notEqual(rejected.code, 0);
	assert.match(
		rejected.stderr,
		/arXiv rejected the query \(http:\/\/127\.0\.0\.1:\d+\/api\/query\?/,
	);
});

test("Ad-hoc arguments that can't be used are refused with the usage line before any request", async () => {
	const run = setup();
	const refused: string[][] = [
		[run.digests, "--query"],
		[run.digests, "--query", ""],
		[run.digests, "--query", ",,"],
		[run.digests, "--author", "  "],
		[run.digests, "--author", "A B", "--author", "C D"],
		["--date", "2026-10-10", run.digests, "--query", "cooperative AI"],
		["--query", "cooperative AI"],
	];
	for (const args of refused) {
		const ran = await plan(run, args);
		assert.notEqual(ran.code, 0, args.join(" "));
		assert.match(
			ran.stderr,
			/usage: node scripts\/scout\/search\.ts/,
			args.join(" "),
		);
	}
	assert.deepEqual(stand.all, []);
});

// ---- --cached ----

test("--cached prints the output kept from today's run without a request, says so on stderr, and leaves the cache unchanged", async () => {
	stand.arxiv.answer = (request) => pageOf(papersFor(2), request);
	const run = setup();
	const first = await plan(run, [run.digests]);
	assert.equal(first.code, 0, first.stderr);
	const before = readdirSync(run.cache).sort();
	const asked = stand.all.length;
	const second = await plan(run, [run.digests, "--cached"]);
	assert.equal(second.code, 0, second.stderr);
	assert.equal(second.stdout, first.stdout);
	assert.equal(stand.all.length, asked, "no request");
	assert.match(second.stderr, /search\.ts: printed from the run kept at /);
	assert.deepEqual(readdirSync(run.cache).sort(), before);
});

// The pool's records as the plan kept them, with scores written in as score.ts would.
function scoreInPool(
	run: Setup,
	scores: Record<string, { weighted: number; confidence: number }>,
) {
	const file = join(run.cache, "pool.json");
	const pool = JSON.parse(readFileSync(file, "utf8"));
	for (const [id, score] of Object.entries(scores)) {
		Object.assign(pool[id], {
			score: 3,
			confidence: score.confidence,
			weighted: score.weighted,
			topicProbabilities: { t1: 1 },
			scoredOn: TODAY,
		});
	}
	writeFileSync(file, JSON.stringify(pool));
}

test("--cached ranks a topic's papers by the scores Jev gave after the kept run, and marks a low-confidence score with '?'", async () => {
	stand.arxiv.answer = (request) =>
		pageOf(
			[
				{
					id: "2610.00001",
					title: "Sparse probes for deception",
					published: "2026-10-10",
				},
				{
					id: "2610.00002",
					title: "Steering vectors at scale",
					published: "2026-10-10",
				},
			],
			request,
		);
	const run = setup();
	await plan(run, [run.digests]);
	scoreInPool(run, {
		"2610.00001": { weighted: 1, confidence: 0.9 },
		"2610.00002": { weighted: 3, confidence: 0.3 },
	});
	const replay = await plan(run, [run.digests, "--cached"]);
	const lines = replay.stdout.split("\n");
	assert.equal(lines[1], "2026-10-10 2610.00002 Steering vectors at scale ?");
	assert.equal(lines[2], "2026-10-10 2610.00001 Sparse probes for deception");
});

test("A paper added to the digests after the kept run is left out of the --cached output", async () => {
	stand.arxiv.answer = (request) =>
		pageOf(
			[
				{
					id: "2606.33333",
					title: "Sparse probes for deception",
					published: "2026-10-10",
				},
				{
					id: "2606.44444",
					title: "Steering vectors at scale",
					published: "2026-10-09",
				},
			],
			request,
		);
	const run = setup();
	await plan(run, [run.digests]);
	writeFileSync(
		run.digests,
		`${digestText("2026-10-12", [
			{
				id: "arxiv:2606.33333",
				type: "paper",
				title: "Sparse probes for deception",
				authors: ["Ada Example"],
				published: "2026-10-10",
				source: "arXiv",
				url: "https://arxiv.org/abs/2606.33333",
				links: [],
				abstract: "x",
			},
		])}\n`,
	);
	const replay = await plan(run, [run.digests, "--cached"]);
	assert.equal(replay.stdout.includes("2606.33333"), false);
	assert.match(replay.stdout, /2606\.44444 Steering vectors at scale/);
});

test("Without today's kept output, --cached runs the plan and keeps its output", async () => {
	stand.arxiv.answer = (request) => pageOf(papersFor(1), request);
	const run = setup();
	writeFileSync(
		join(run.cache, "output.json"),
		JSON.stringify({
			day: "2026-10-11",
			at: "x",
			text: "2026-10-01 2610.99999 Yesterday's paper\n",
			failed: false,
			topics: [],
			rest: [],
			venues: [],
		}),
	);
	const ran = await plan(run, [run.digests, "--cached"]);
	assert.equal(ran.code, 0, ran.stderr);
	assert.equal(ran.stdout.includes("2610.99999"), false);
	assert.ok(stand.arxiv.requests.length > 0);
	assert.equal(
		JSON.parse(readFileSync(join(run.cache, "output.json"), "utf8")).day,
		TODAY,
	);
});

test("--cached exits non-zero and says so on stderr when the kept run named a failure", async () => {
	stand.arxiv.answer = (request) => pageOf(papersFor(1), request);
	stand.pages["/lists/aies.csv"] = () => ({ status: 500, body: "" });
	const run = setup({ lists: ["- AIES: <base>/lists/aies.csv"] });
	const first = await plan(run, [run.digests]);
	assert.notEqual(first.code, 0);
	const replay = await plan(run, [run.digests, "--cached"]);
	assert.notEqual(replay.code, 0);
	assert.equal(replay.stdout, first.stdout);
	assert.match(replay.stderr, /the kept run named a failure/);
});

// ---- the pool file and Hugging Face ----

test("Records of pool.json of the wrong shape are dropped and counted, and only the good record is offered", async () => {
	const run = setup();
	const good = {
		id: "2610.00001",
		title: "Sparse probes for deception",
		abstract: "Abstract.",
		authors: ["Ada Example"],
		published: "2026-10-10",
		note: null,
		topics: [1],
		firstSeen: "2026-10-11",
	};
	writeFileSync(
		join(run.cache, "pool.json"),
		JSON.stringify({
			"2610.00001": good,
			"2610.00002": { ...good, id: "2610.00002", title: 42 },
			"../x": { ...good, id: "../x" },
			"2610.00003": { ...good, id: "2610.00003", abstract: "a".repeat(20000) },
		}),
	);
	const ran = await plan(run, [run.digests]);
	assert.equal(ran.code, 0, ran.stderr);
	assert.match(ran.stderr, /pool\.json: 3 records of the wrong shape dropped/);
	assert.match(
		ran.stdout,
		/^topic 1 \(0 found, 1 from earlier searches\):\n2026-10-10 2610\.00001 Sparse probes for deception\n/,
	);
	assert.equal(
		ran.stdout.includes("2610.00002") || ran.stdout.includes("2610.00003"),
		false,
	);
});

test("Hugging Face's answer of HTTP 400 for today's date is a day with no list, not a failure", async () => {
	stand.pages["/hf/daily_papers"] = (incoming) => {
		if (String(incoming.url).includes(`date=${TODAY}`)) {
			return { status: 400, body: '{"error":"Invalid date"}' };
		}
		return { status: 200, body: "[]" };
	};
	const run = setup();
	const ran = await plan(run, [run.digests]);
	assert.equal(ran.code, 0, ran.stderr);
	assert.equal(ran.stderr.includes("Hugging Face"), false);
	assert.ok(
		stand.pageRequests.some((request) => request.path === "/hf/daily_papers"),
	);
});
