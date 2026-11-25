// The OpenAlex topics script, scripts/scout/openalex/topics.ts: adding OpenAlex's topics and keywords to papers.
import { readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { afterAll, afterEach, expect, test } from "vitest";
import CONSTANTS from "../../scripts/lib/constants.json" with { type: "json" };
import { topicsFromAnswer } from "../../scripts/scout/openalex/topics.ts";
import { closeServers, serve } from "./local-server.ts";
import {
	digestText,
	entriesOfLine,
	removeTempFolders,
	runScript,
	scriptPath,
	tempFolder,
} from "./run-script.ts";

const SCRIPT = scriptPath("scout/openalex/topics.ts");
const TODAY = "2026-11-24";
const ATTENTION = "Attention Is All You Need";
const MONITORABILITY =
	"Chain of Thought Monitorability: A New and Fragile Opportunity for AI Safety";

type Json = Record<string, unknown>;
type Work = Json & { doi: string; title: string };
type Answer = { status?: number; body: string | Json };

afterEach(closeServers);
afterAll(removeTempFolders);

const FIXTURE: { results: Work[] } = JSON.parse(
	readFileSync(
		new URL("../fixtures/openalex/works.json", import.meta.url),
		"utf8",
	),
);
const [ATTENTION_WORK] = FIXTURE.results as [Work];

function paper(id: string, title: string, extra: Json = {}) {
	return {
		id: id,
		type: "paper",
		title: title,
		authors: ["Ada Example"],
		published: "2026-11-20",
		url: `https://arxiv.org/abs/${id.replace(/^arxiv:/, "")}`,
		...extra,
	};
}

const ATTENTION_PAPER = paper("arxiv:1706.03762", ATTENTION);
const MONITORABILITY_PAPER = paper("arxiv:2507.11473", MONITORABILITY);

type Asked = {
	method: string;
	path: string;
	query: URLSearchParams;
	headers: IncomingMessage["headers"];
	dois: string[];
};

// An OpenAlex stand-in answering from the real answer's two works unless `answer` says otherwise; its requests kept.
async function openAlex(
	answer: (asked: Asked, count: number) => Answer | null = (asked) => ({
		body: {
			...FIXTURE,
			results: FIXTURE.results.filter((work) =>
				asked.dois.includes(work.doi.replace("https://doi.org/", "")),
			),
		},
	}),
) {
	const asked: Asked[] = [];
	const base = await serve(
		(incoming: IncomingMessage, outgoing: ServerResponse) => {
			const url = new URL(incoming.url ?? "/", "http://stand-in");
			const filter = url.searchParams.get("filter") ?? "";
			const request: Asked = {
				method: incoming.method ?? "",
				path: url.pathname,
				query: url.searchParams,
				headers: incoming.headers,
				dois: filter
					.replace(/^doi:/, "")
					.split("|")
					.map((doi) => doi.toLowerCase()),
			};
			asked.push(request);
			const given = answer(request, asked.length);
			if (given === null) {
				return;
			}
			outgoing.writeHead(given.status ?? 200, {
				"content-type": "application/json",
			});
			outgoing.end(
				typeof given.body === "string"
					? given.body
					: JSON.stringify(given.body),
			);
		},
	);
	return { base: base, asked: asked };
}

type Day = { date: string; entries: Json[] };

// topics.ts on a digests file with these days, against a stand-in; what it printed, the file before and after.
async function run(
	days: Day[],
	base: string,
	args: string[] = [],
	env: Record<string, string> = {},
) {
	const file = join(tempFolder("liminal-unit-openalex-"), "digests.js");
	const before = `${days.map((day) => digestText(day.date, day.entries)).join("\n")}\n`;
	writeFileSync(file, before);
	const ran = await runScript(SCRIPT, [file, ...args], {
		LIMINAL_TODAY: TODAY,
		OPENALEX_API: base,
		OPENALEX_PAUSE_MS: "0",
		...env,
	});
	const after = readFileSync(file, "utf8");
	return {
		...ran,
		before: before,
		after: after,
		entries: after
			.trim()
			.split("\n")
			.map((line) => entriesOfLine(line)),
	};
}

const today = (...entries: Json[]): Day[] => [
	{ date: TODAY, entries: entries },
];

test("An arXiv paper is asked for by the DOI arXiv registers for it", async () => {
	const stand = await openAlex();
	await run(today(ATTENTION_PAPER), stand.base);
	expect(stand.asked.map((request) => request.dois)).toEqual([
		["10.48550/arxiv.1706.03762"],
	]);
	expect(stand.asked[0]?.query.get("filter")).toBe(
		"doi:10.48550/arXiv.1706.03762",
	);
});

test("An answer that carries the published version's DOI is matched back to the paper by its arXiv address", () => {
	const published: Work = {
		...ATTENTION_WORK,
		doi: "https://doi.org/10.1000/x.2017",
	};
	const found = topicsFromAnswer(
		[
			{
				id: "arxiv:1706.03762",
				title: ATTENTION,
				doi: "10.48550/arXiv.1706.03762",
			},
		],
		{ results: [published] },
	);
	expect([...found.keys()]).toEqual(["arxiv:1706.03762"]);
});

test("A paper with a DOI of its own is asked for by that DOI", async () => {
	const own = paper("doi:10.1038/nature14539", "Deep learning", {
		url: "https://doi.org/10.1038/nature14539",
	});
	const stand = await openAlex(() => ({
		body: {
			results: [
				{
					...ATTENTION_WORK,
					doi: "https://doi.org/10.1038/nature14539",
					title: "Deep learning",
					locations: [],
				},
			],
		},
	}));
	const ran = await run(today(own), stand.base);
	expect(stand.asked.map((request) => request.dois)).toEqual([
		["10.1038/nature14539"],
	]);
	expect(ran.entries[0]?.[0]?.openalex).toBeDefined();
});

test("News, articles and reports are never asked for", async () => {
	const stand = await openAlex();
	const others = ["news", "article", "report"].map((type) => ({
		id: "doi:10.48550/arXiv.1706.03762",
		type: type,
		title: ATTENTION,
		published: "2026-11-20",
		source: "A Source",
		url: "https://example.com/post",
	}));
	const ran = await run(today(...others), stand.base);
	expect(stand.asked).toEqual([]);
	expect(ran.after).toBe(ran.before);
});

test("A matched paper gets OpenAlex's topics, with their field and score, and its keywords", async () => {
	const stand = await openAlex();
	const ran = await run(
		today(ATTENTION_PAPER, MONITORABILITY_PAPER),
		stand.base,
	);
	expect(ran.code).toBe(0);
	expect(ran.entries[0]?.[0]?.openalex).toEqual({
		topics: [
			{
				name: "Natural Language Processing Techniques",
				field: "Computer Science",
				score: 0.7822,
			},
			{ name: "Topic Modeling", field: "Computer Science", score: 0.1945 },
			{
				name: "Speech Recognition and Synthesis",
				field: "Computer Science",
				score: 0.0053,
			},
		],
		keywords: [
			"transformer models",
			"attention mechanism",
			"machine translation",
		],
	});
	expect(ran.entries[0]?.[1]?.openalex).toMatchObject({
		topics: [
			{ name: "Ethics and Social Impacts of AI", score: 0.96 },
			{ field: "Engineering" },
		],
	});
});

test("A paper whose OpenAlex title differs from its own, once case, TeX, HTML and punctuation are set aside, gets nothing and is named on stderr", async () => {
	const same = [
		"attention is all you need",
		"<i>Attention</i> Is All You Need.",
		"$Attention$ Is All You {Need}",
		"Attention Is All—You Need",
	];
	for (const title of same) {
		const found = topicsFromAnswer(
			[
				{
					id: "arxiv:1706.03762",
					title: title,
					doi: "10.48550/arXiv.1706.03762",
				},
			],
			{ results: [ATTENTION_WORK] },
		);
		expect(found.size, title).toBe(1);
	}
	const stand = await openAlex();
	const ran = await run(
		today(paper("arxiv:1706.03762", "Attention Is Not All You Need")),
		stand.base,
	);
	expect(ran.entries[0]?.[0]?.openalex).toBeUndefined();
	expect(ran.stderr).toContain("arxiv:1706.03762");
});

test("A paper OpenAlex has not classified gets no openalex field, so a later run fills it", async () => {
	const unclassified: Work = {
		...ATTENTION_WORK,
		primary_topic: null,
		topics: [],
		keywords: [],
	};
	const bare = await openAlex(() => ({ body: { results: [unclassified] } }));
	const first = await run(today(ATTENTION_PAPER), bare.base);
	expect(first.after).not.toContain("openalex");
	const classified = await openAlex();
	const file = join(tempFolder("liminal-unit-openalex-"), "digests.js");
	writeFileSync(file, first.after);
	await runScript(SCRIPT, [file], {
		LIMINAL_TODAY: TODAY,
		OPENALEX_API: classified.base,
		OPENALEX_PAUSE_MS: "0",
	});
	expect(readFileSync(file, "utf8")).toContain('"openalex"');
});

test("A paper that already has an openalex field is not asked for again", async () => {
	const kept = {
		topics: [{ name: "Kept", field: "Kept field", score: 0.5 }],
		keywords: [],
	};
	const stand = await openAlex();
	const ran = await run(
		today({ ...ATTENTION_PAPER, openalex: kept }, MONITORABILITY_PAPER),
		stand.base,
	);
	expect(stand.asked.flatMap((request) => request.dois)).toEqual([
		"10.48550/arxiv.2507.11473",
	]);
	expect(ran.entries[0]?.[0]?.openalex).toEqual(kept);
});

test("Only papers from the last 30 days are asked for, unless --all is given", async () => {
	const days: Day[] = [
		{ date: "2026-10-24", entries: [ATTENTION_PAPER] },
		{ date: "2026-10-25", entries: [MONITORABILITY_PAPER] },
	];
	const recent = await openAlex();
	await run(days, recent.base);
	expect(recent.asked.flatMap((request) => request.dois)).toEqual([
		"10.48550/arxiv.2507.11473",
	]);
	const everything = await openAlex();
	await run(days, everything.base, ["--all"]);
	expect(everything.asked.flatMap((request) => request.dois).sort()).toEqual([
		"10.48550/arxiv.1706.03762",
		"10.48550/arxiv.2507.11473",
	]);
});

test("One request asks for at most 50 papers", async () => {
	const many = Array.from({ length: 120 }, (_, n) =>
		paper(`arxiv:2601.${String(n).padStart(5, "0")}`, `Paper ${n}`),
	);
	const stand = await openAlex(() => ({ body: { results: [] } }));
	await run(today(...many), stand.base);
	expect(stand.asked.map((request) => request.dois.length)).toEqual([
		50, 50, 20,
	]);
});

test("OpenAlex failing or not answering in time leaves the digests file as it was and exits 1", async () => {
	const many = Array.from({ length: 60 }, (_, n) =>
		paper(`arxiv:2601.${String(n).padStart(5, "0")}`, `Paper ${n}`),
	);
	const failures: Array<
		[string, (asked: Asked, count: number) => Answer | null]
	> = [
		["budget spent", () => ({ status: 429, body: { error: "Rate limited" } })],
		["server error", () => ({ status: 500, body: "boom" })],
		["no answer", () => null],
		[
			"second request fails",
			(_asked, count) =>
				count === 1
					? { body: { results: [ATTENTION_WORK] } }
					: { status: 503, body: "" },
		],
	];
	for (const [name, answer] of failures) {
		const stand = await openAlex(answer);
		const ran = await run(today(...many, ATTENTION_PAPER), stand.base, [], {
			OPENALEX_TIMEOUT_MS: "300",
		});
		expect(ran.code, name).toBe(1);
		expect(ran.after, name).toBe(ran.before);
		await closeServers();
	}
});

test("privacy: a request names no email, name or address of the owner", async () => {
	const stand = await openAlex();
	await run(
		today(
			{ ...ATTENTION_PAPER, authors: ["Ada Example"] },
			MONITORABILITY_PAPER,
		),
		stand.base,
	);
	expect(stand.asked.length).toBeGreaterThan(0);
	for (const request of stand.asked) {
		expect([request.method, request.path]).toEqual(["GET", "/works"]);
		expect([...request.query.keys()].sort()).toEqual([
			"filter",
			"per_page",
			"select",
		]);
		const sent = JSON.stringify([request.query.toString(), request.headers]);
		expect(sent).not.toMatch(
			/@|api_key|mailto|email|Ada Example|authorization|cookie/i,
		);
		expect(request.headers["user-agent"]).toBe(CONSTANTS.userAgent);
	}
});

test("security: an answer over the size cap, or not JSON, changes no paper", async () => {
	const answers: Answer[] = [
		{ body: JSON.stringify({ results: [], pad: "x".repeat(6 * 1024 * 1024) }) },
		{ body: "<html>not JSON</html>" },
		{ body: JSON.stringify("results") },
		{ body: JSON.stringify({ error: "Invalid query" }) },
	];
	for (const answer of answers) {
		const stand = await openAlex(() => answer);
		const ran = await run(today(ATTENTION_PAPER), stand.base);
		expect(ran.code).toBe(1);
		expect(ran.after).toBe(ran.before);
		await closeServers();
	}
});

test("A request asks OpenAlex for 50 results a page, so none is dropped", async () => {
	const stand = await openAlex();
	await run(today(ATTENTION_PAPER), stand.base);
	expect(stand.asked[0]?.query.get("per_page")).toBe("50");
});
