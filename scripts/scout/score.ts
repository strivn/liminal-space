// Score the candidates of the pool (pool.json in the cache folder, written by scripts/scout/search.ts) that have no score yet,
// with Jev, TypeSafe's System One model: one request per paper, 4 at a time, from its title and abstract against
// interests.md. Each record keeps Jev's score (0 to 4), its confidence, the topic probabilities and the weighted score:
// the score times the sum of each topic's probability times its weight in interests.md. search.ts prints the candidates
// best first.
// Jev's state also holds the papers the owner liked and disliked lately, from feedback.json (scripts/lib/feedback.ts), which
// sync.ts pull --database writes before this step; without it both lists are empty. Each liked paper says whether it
// is an "acceptable" (OK) or a "strong interest" (Like).
// Usage: node scripts/scout/score.ts
// A failed request leaves its paper unscored for the next run; a refused key (HTTP 401 or 403) stops the run after
// that batch. Papers scored earlier are re-weighed with the weights as they are now, without asking Jev again.
// Environment: TYPESAFE_AI_KEY (the key, never printed); TYPESAFE_API, INTERESTS_FILE and LIMINAL_CACHE (stand-ins and
// temp folders for tests); LIMINAL_TODAY (tests only).
// API: https://docs.typesafe.ai/primitives/score.md and https://docs.typesafe.ai/primitives/choice.md

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { errorCode, isJsonObject } from "../../shared/narrow.ts";
import { type Fail, failer, REPO } from "../lib/cli.ts";
import type { FeedbackFile } from "../lib/feedback.ts";
import { readFeedback } from "../lib/feedback.ts";
import { request as httpRequest } from "../lib/http.ts";
import { jakartaToday } from "../lib/run-date.ts";
import type { Pool, PoolRecord, Weights } from "./plan/pool.ts";
import { readPool, topicWeights, writePool } from "./plan/pool.ts";

const fail: Fail = failer("score.ts");

const API = process.env.TYPESAFE_API || "https://api.typesafe.ai/v1/systemone";
const INTERESTS_FILE = process.env.INTERESTS_FILE || join(REPO, "interests.md");
const MODEL = "jev-latest";
// Requests in flight at once; each batch waits for the one before.
const AT_ONCE = 4;

// The relevance question: a Score over five levels, low to high, that split the on-topic papers (with three levels,
// 12 of 20 test papers scored 9.3 to 9.9 of 10).
const RELEVANCE = {
	type: "score",
	instructions:
		"How much would the reader whose interests file is `state.interests` want `state.paper` in today's reading list? Judge from the title and abstract only.",
	criteria: [
		"Unrelated to every listed topic, or shares only a word with one",
		"On a listed topic, but thin: a position paper, a small study, or the topic is secondary to another focus",
		"Solid work on a listed topic: a concrete but incremental contribution",
		"Strong contribution to a listed topic: a new method, a striking result, or a major evaluation",
		"Likely to change how people in the field work or think",
	],
};
const TOPIC_INSTRUCTIONS =
	"Which topic in `state.interests` is `state.paper` mainly about?";

// Jev's score (0 to 4) times the sum of each topic's probability times its weight; "none" weighs weights.none, and an
// option interests.md doesn't name weighs nothing.
export function weightedScore(
	score: number,
	probabilities: Record<string, number>,
	weights: Weights,
): number {
	let sum = 0;
	for (const [key, probability] of Object.entries(probabilities)) {
		if (key === "none") {
			sum += probability * weights.none;
		}
		for (const topic of weights.topics) {
			if (topic.key === key) {
				sum += probability * topic.weight;
			}
		}
	}
	return score * sum;
}

// What Jev said about one paper, as the record keeps it.
type JevScore = {
	score: number;
	confidence: number;
	topicProbabilities: Record<string, number>;
};

// Jev's answer as the API documents it (answers.relevance: score, confidence; answers.topic: probabilities); null when
// the body isn't that.
function jevScoreOf(body: unknown): JevScore | null {
	if (!isJsonObject(body) || !isJsonObject(body.answers)) {
		return null;
	}
	const relevance = body.answers.relevance;
	const topic = body.answers.topic;
	if (
		!isJsonObject(relevance) ||
		typeof relevance.score !== "number" ||
		typeof relevance.confidence !== "number" ||
		!isJsonObject(topic) ||
		!isJsonObject(topic.probabilities)
	) {
		return null;
	}
	const probabilities: Record<string, number> = {};
	for (const [key, value] of Object.entries(topic.probabilities)) {
		if (typeof value !== "number") {
			return null;
		}
		probabilities[key] = value;
	}
	return {
		score: relevance.score,
		confidence: relevance.confidence,
		topicProbabilities: probabilities,
	};
}

// What Jev is told about one paper: the owner's interests, the paper, and the papers they liked (each with how strongly) and
// disliked lately.
export function jevState(
	interests: string,
	feedback: FeedbackFile,
	record: PoolRecord,
) {
	return {
		interests: interests,
		paper: { title: record.title, abstract: record.abstract },
		liked: feedback.liked.map((paper) => ({
			title: paper.title,
			abstract: paper.abstract,
			interest: paper.interest,
		})),
		disliked: feedback.disliked.map((paper) => ({
			title: paper.title,
			abstract: paper.abstract,
		})),
	};
}

// Ask Jev about one paper. Returns its score, or what went wrong in words that finish "TypeSafe API ...". The key goes
// only in the Authorization header, and nothing the API answers is quoted, since an error body may repeat the key.
async function askJev(
	key: string,
	interests: string,
	weights: Weights,
	feedback: FeedbackFile,
	record: PoolRecord,
): Promise<JevScore | string> {
	const criteria: Record<string, string> = {};
	for (const topic of weights.topics) {
		criteria[topic.key] = topic.name;
	}
	criteria.none = "None of the listed topics";
	const request = {
		model: MODEL,
		state: jevState(interests, feedback, record),
		questions: {
			relevance: RELEVANCE,
			topic: {
				type: "choice",
				instructions: TOPIC_INSTRUCTIONS,
				criteria: criteria,
			},
		},
	};
	const response = await httpRequest(API, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${key}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(request),
		userAgent: null,
	});
	if ("problem" in response) {
		return response.problem;
	}
	if (!response.ok) {
		return `answered HTTP ${response.status}`;
	}
	let body: unknown = null;
	try {
		body = JSON.parse(response.text());
	} catch {
		// named below, like a body that parses but isn't an answer
	}
	const scored = jevScoreOf(body);
	if (scored === null) {
		return "answered with something that isn't a Jev answer";
	}
	return scored;
}

// A pool record's id as the digests write it: "arxiv:" before an arXiv id; a proceedings paper's "doi:" or "url:" id
// as it is.
function paperName(id: string) {
	if (id.startsWith("doi:") || id.startsWith("url:")) {
		return id;
	}
	return `arxiv:${id}`;
}

// interests.md's text and the topic weights it gives; stops when the file can't be read or a weight is missing.
function readInterestsWeights() {
	let interests: string;
	try {
		interests = readFileSync(INTERESTS_FILE, "utf8");
	} catch (error) {
		fail(`can't read ${INTERESTS_FILE} (${errorCode(error)})`);
	}
	const weights = topicWeights(interests);
	if (weights === null) {
		fail(
			`${INTERESTS_FILE} gives no weight to every topic, or has no "A paper on none of these topics has weight" line`,
		);
	}
	return { interests: interests, weights: weights };
}

// Papers scored on an earlier run take interests.md's weights as they are now, without asking Jev again.
function reweighScored(pool: Pool, weights: Weights) {
	for (const record of Object.values(pool)) {
		if (record.score !== undefined && record.topicProbabilities !== undefined) {
			record.weighted = weightedScore(
				record.score,
				record.topicProbabilities,
				weights,
			);
		}
	}
}

async function main(): Promise<void> {
	const key = process.env.TYPESAFE_AI_KEY;
	if (!key) {
		fail("TYPESAFE_AI_KEY is not set; nothing scored");
	}
	const { interests, weights } = readInterestsWeights();
	const today = jakartaToday();
	// Liked and disliked papers, as the pull wrote them.
	const feedback = readFeedback();
	const pool = readPool();
	reweighScored(pool, weights);
	const unscored = Object.values(pool).filter(
		(record) => record.scoredOn === undefined,
	);
	let scored = 0;
	let refused = false;
	for (let at = 0; at < unscored.length && !refused; at += AT_ONCE) {
		const batch = unscored.slice(at, at + AT_ONCE);
		// biome-ignore lint/performance/noAwaitInLoops: one batch of 4 at a time keeps 4 requests in flight at most
		const answers = await Promise.all(
			batch.map((record) => askJev(key, interests, weights, feedback, record)),
		);
		for (const [index, answer] of answers.entries()) {
			const record = batch[index];
			if (record === undefined) {
				continue;
			}
			if (typeof answer === "string") {
				// A refused key refuses every later request too.
				if (answer === "answered HTTP 401" || answer === "answered HTTP 403") {
					refused = true;
				}
				console.error(
					`score.ts: TypeSafe API ${answer} for ${paperName(record.id)}`,
				);
				continue;
			}
			record.score = answer.score;
			record.confidence = answer.confidence;
			record.topicProbabilities = answer.topicProbabilities;
			record.weighted = weightedScore(
				answer.score,
				answer.topicProbabilities,
				weights,
			);
			record.scoredOn = today;
			scored += 1;
		}
		// After each batch, so a run that is stopped keeps what it scored.
		writePool(pool);
	}
	writePool(pool);
	console.log(`scored ${scored} of ${unscored.length} unscored candidates`);
	if (refused) {
		console.error(
			"score.ts: TypeSafe refused the key; stopped after that batch, so the rest stay unscored",
		);
	}
	if (scored < unscored.length) {
		console.error(
			`score.ts: ${unscored.length - scored} candidates left unscored; the next run asks again`,
		);
		process.exitCode = 1;
	}
}

// Run only when called as a script, not when imported.
if (import.meta.main) {
	await main();
}
