// Tests of scripts/scout/score.ts run as the cloud scout runs it: a pool.json and interests.md in a temp folder, TypeSafe's
// System One API as a stand-in on 127.0.0.1, the exit code and what it prints and writes.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, test } from "vitest";
import { closeServers, serve } from "./local-server.ts";
import {
	removeTempFolders,
	runScript,
	scriptPath,
	tempFolder,
} from "./run-script.ts";

const SCORE = scriptPath("scout/score.ts");
const KEY = "key-9d41c7e2";

afterEach(closeServers);
afterAll(removeTempFolders);

const INTERESTS = (riskWeight: string) =>
	[
		"# Interests",
		"",
		"## Topics, highest priority first",
		`1. Risks of AI (weight ${riskWeight}): honesty, deception`,
		"6. Privacy (weight 0.90): differential privacy",
		"",
		"A paper on none of these topics has weight 0.75.",
		"",
	].join("\n");

function poolRecord(id: string, extra: Record<string, unknown> = {}) {
	return {
		id: id,
		title: `Paper ${id}`,
		abstract: `Abstract of ${id}.`,
		authors: ["Ada Example"],
		published: "2026-10-10",
		note: null,
		topics: [1],
		firstSeen: "2026-10-11",
		...extra,
	};
}

type Run = { folder: string; cache: string; interests: string };

// A folder with interests.md and a cache folder whose pool.json holds these records.
function setup(records: Record<string, unknown>[], riskWeight = "1.00"): Run {
	const folder = tempFolder("liminal-unit-score-");
	const cache = join(folder, "cache");
	mkdirSync(cache);
	const pool: Record<string, unknown> = {};
	for (const record of records) {
		pool[String(record.id)] = record;
	}
	writeFileSync(join(cache, "pool.json"), JSON.stringify(pool));
	const interests = join(folder, "interests.md");
	writeFileSync(interests, INTERESTS(riskWeight));
	return { folder: folder, cache: cache, interests: interests };
}

function poolOf(run: Run): Record<string, Record<string, unknown>> {
	return JSON.parse(readFileSync(join(run.cache, "pool.json"), "utf8"));
}

type Seen = {
	headers: Record<string, string | string[] | undefined>;
	body: Record<string, unknown>;
	raw: string;
};

// What Jev answers: relevance score and confidence, and the topic probabilities.
type Verdict = {
	score: number;
	confidence: number;
	topic: Record<string, number>;
};

const SOLID: Verdict = {
	score: 3,
	confidence: 0.9,
	topic: { t1: 0.5, t6: 0.5, none: 0 },
};

// A System One stand-in that answers every request `answer` says and records each: headers, body, and the most open at
// once. A request is held `holdMs` before it answers, so that requests of one batch overlap.
async function serveJev(
	answer: (seen: Seen, index: number) => { status: number; body: string },
	holdMs = 0,
) {
	const seen: Seen[] = [];
	const state = { open: 0, mostOpen: 0 };
	const base = await serve((incoming, response) => {
		state.open += 1;
		state.mostOpen = Math.max(state.mostOpen, state.open);
		const chunks: Buffer[] = [];
		incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
		incoming.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			const record: Seen = {
				headers: incoming.headers,
				body: JSON.parse(raw),
				raw: raw,
			};
			seen.push(record);
			const reply = answer(record, seen.length - 1);
			setTimeout(() => {
				state.open -= 1;
				response.writeHead(reply.status, {
					"content-type": "application/json",
				});
				response.end(reply.body);
			}, holdMs);
		});
	});
	return { base: base, seen: seen, state: state };
}

function verdictBody(verdict: Verdict): string {
	return JSON.stringify({
		answers: {
			relevance: { score: verdict.score, confidence: verdict.confidence },
			topic: { probabilities: verdict.topic },
		},
	});
}

function runScore(run: Run, base: string, env: Record<string, string> = {}) {
	return runScript(SCORE, [], {
		TYPESAFE_API: `${base}/v1/systemone`,
		TYPESAFE_AI_KEY: KEY,
		INTERESTS_FILE: run.interests,
		LIMINAL_CACHE: run.cache,
		LIMINAL_TODAY: "2026-10-12",
		...env,
	});
}

test("Jev gets one request per paper, with the key as a bearer token, the model, interests.md, the paper, and both questions", async () => {
	const { base, seen } = await serveJev(() => ({
		status: 200,
		body: verdictBody(SOLID),
	}));
	const run = setup([poolRecord("2610.00001")]);
	const ran = await runScore(run, base);
	assert.equal(ran.code, 0, ran.stderr);
	assert.equal(ran.stdout, "scored 1 of 1 unscored candidates\n");
	assert.equal(seen.length, 1);
	const [request] = seen;
	assert.ok(request);
	assert.equal(request.headers.authorization, `Bearer ${KEY}`);
	assert.equal(request.body.model, "jev-latest");
	const state = request.body.state as Record<string, unknown>;
	assert.equal(state.interests, INTERESTS("1.00"));
	assert.deepEqual(state.paper, {
		title: "Paper 2610.00001",
		abstract: "Abstract of 2610.00001.",
	});
	const questions = request.body.questions as Record<
		string,
		Record<string, unknown>
	>;
	assert.equal(questions.relevance?.type, "score");
	const levels = questions.relevance?.criteria;
	assert.ok(Array.isArray(levels));
	assert.match(String(levels[0]), /^Unrelated to every listed topic/);
	assert.match(
		String(levels.at(-1)),
		/^Likely to change how people in the field/,
	);
	assert.equal(questions.topic?.type, "choice");
	assert.deepEqual(questions.topic?.criteria, {
		t1: "Risks of AI",
		t6: "Privacy",
		none: "None of the listed topics",
	});
});

test("A scored paper's pool record keeps Jev's score, confidence and topic probabilities, the day, and the weighted score", async () => {
	const { base } = await serveJev(() => ({
		status: 200,
		body: verdictBody(SOLID),
	}));
	const run = setup([poolRecord("2610.00001")]);
	await runScore(run, base);
	const record = poolOf(run)["2610.00001"];
	assert.equal(record?.score, 3);
	assert.equal(record?.confidence, 0.9);
	assert.deepEqual(record?.topicProbabilities, SOLID.topic);
	assert.equal(record?.scoredOn, "2026-10-12");
	// 3 x (0.5 x 1.00 + 0.5 x 0.90) = 2.85
	assert.ok(Math.abs(Number(record?.weighted) - 2.85) < 1e-9);
});

test("limit: Requests go 4 at a time", async () => {
	const { base, state, seen } = await serveJev(
		() => ({ status: 200, body: verdictBody(SOLID) }),
		150,
	);
	const records = Array.from({ length: 10 }, (_, n) =>
		poolRecord(`2610.${String(n + 10).padStart(5, "0")}`),
	);
	const run = setup(records);
	const ran = await runScore(run, base);
	assert.equal(ran.code, 0, ran.stderr);
	assert.equal(seen.length, 10);
	assert.equal(state.mostOpen, 4);
});

test("A run without TYPESAFE_AI_KEY sends no request, scores nothing, names the missing key and exits non-zero", async () => {
	const { base, seen } = await serveJev(() => ({
		status: 200,
		body: verdictBody(SOLID),
	}));
	const run = setup([poolRecord("2610.00001")]);
	const ran = await runScore(run, base, { TYPESAFE_AI_KEY: "" });
	assert.notEqual(ran.code, 0);
	assert.match(ran.stderr, /TYPESAFE_AI_KEY is not set/);
	assert.deepEqual(seen, []);
	assert.equal("score" in (poolOf(run)["2610.00001"] ?? {}), false);
});

test("privacy: A refused key stops the run after one batch, and nothing printed repeats the key even when the API's answer does", async () => {
	const { base, seen } = await serveJev((request) => ({
		status: 401,
		body: JSON.stringify({ error: `bad key ${request.headers.authorization}` }),
	}));
	const records = Array.from({ length: 10 }, (_, n) =>
		poolRecord(`2610.${String(n + 10).padStart(5, "0")}`),
	);
	const run = setup(records);
	const ran = await runScore(run, base);
	assert.notEqual(ran.code, 0);
	assert.ok(seen.length <= 4, `${seen.length} requests`);
	assert.match(ran.stderr, /TypeSafe refused the key/);
	assert.equal((ran.stdout + ran.stderr).includes(KEY), false);
});

test("A request that fails leaves its paper unscored for the next run, and the others are scored", async () => {
	const { base } = await serveJev((request) => {
		const state = request.body.state as { paper: { title: string } };
		if (state.paper.title === "Paper 2610.00002") {
			return { status: 503, body: "" };
		}
		return { status: 200, body: verdictBody(SOLID) };
	});
	const run = setup([poolRecord("2610.00001"), poolRecord("2610.00002")]);
	const ran = await runScore(run, base);
	assert.notEqual(ran.code, 0);
	assert.equal(ran.stdout, "scored 1 of 2 unscored candidates\n");
	assert.match(
		ran.stderr,
		/TypeSafe API answered HTTP 503 for arxiv:2610\.00002/,
	);
	const pool = poolOf(run);
	assert.equal(pool["2610.00001"]?.score, 3);
	assert.equal("scoredOn" in (pool["2610.00002"] ?? {}), false);
});

test("A paper scored earlier is re-weighed from interests.md as it is now, without asking Jev again", async () => {
	const { base, seen } = await serveJev(() => ({
		status: 200,
		body: verdictBody(SOLID),
	}));
	const run = setup(
		[
			poolRecord("2610.00001", {
				score: 3,
				confidence: 0.9,
				topicProbabilities: { t1: 1 },
				weighted: 3,
				scoredOn: "2026-10-11",
			}),
		],
		"0.50",
	);
	const ran = await runScore(run, base);
	assert.equal(ran.code, 0, ran.stderr);
	assert.deepEqual(seen, []);
	assert.equal(poolOf(run)["2610.00001"]?.weighted, 1.5);
});
