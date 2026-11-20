// Unit tests for scripts/scout/plan/jev-samples.ts's samplesPart: which candidates a topic samples, and the limits that keep the
// samples well inside the log's size limit. The interests
// text and today are fixed here, so an edit to the owner's topics or the date the tests run on changes nothing.
// Rules:
// - The samples come from the candidate pool as the run leaves it: a topic's candidates are the scored pool records
//   search.ts offers for that topic (found by its searches, first submitted in the 60 days ending today or on a
//   conference list), ranked by Jev alone (weighted score, then confidence).
// - The samples stay well inside the log's size limit: sync.ts log refuses a log over 65,536 bytes, which loses the
//   whole run's log, and a day can hold two runs. So a title is cut to 90 characters and a topic lists at most 10
//   doubtful candidates, then says how many more there are.

import assert from "node:assert/strict";
import { test } from "vitest";
import { samplesPart } from "../../scripts/scout/plan/jev-samples.ts";
import type { Pool, PoolRecord } from "../../scripts/scout/plan/pool.ts";

const TODAY = "2026-11-02";
const YESTERDAY = "2026-11-01";
// Eight topics with their weights, as many as interests.md has, written as its "Topics" section writes them.
const INTERESTS = [
	"## Topics, highest priority first",
	"1. Risks of AI (weight 1.00): honesty, deception",
	"2. Indonesian (weight 0.97): Indonesian language models",
	"3. Topic three (weight 0.90): more",
	"4. Topic four (weight 0.90): more",
	"5. Topic five (weight 0.90): more",
	"6. Topic six (weight 0.90): more",
	"7. Topic seven (weight 0.90): more",
	"8. Topic eight (weight 0.90): more",
	"",
	"A paper on none of these topics has weight 0.75.",
	"",
].join("\n");

// One scored candidate of topic 1 at `rank` (1 = highest): each next rank 0.05 lower; confidence 0.9 unless given.
function candidate(rank: number, fields: Partial<PoolRecord> = {}): PoolRecord {
	return Object.assign(
		{
			id: `2610.01${String(rank).padStart(3, "0")}`,
			title: `Risks of AI paper ${rank}`,
			abstract: "An abstract.",
			authors: ["Yann LeCun"],
			published: TODAY,
			note: null,
			topics: [1],
			firstSeen: TODAY,
			score: 4,
			confidence: 0.9,
			topicProbabilities: { t1: 1 },
			weighted: Math.round((4 - rank * 0.05) * 100) / 100,
			scoredOn: TODAY,
		},
		fields,
	);
}

// A pool of the given candidates, by id.
function poolOf(records: PoolRecord[]): Pool {
	const pool: Pool = {};
	for (const record of records) {
		pool[record.id] = record;
	}
	return pool;
}

// Ranks 1 to `count`.
function ranks(count: number): number[] {
	return Array.from({ length: count }, (_, index) => index + 1);
}

// The samples part's lines of one topic, from its "#### <topic>:" heading up to the next topic.
function topicLines(part: string, topic: string): string[] {
	const lines = part.split("\n").filter((line) => line.trim() !== "");
	const start = lines.findIndex((line) => line.startsWith(`#### ${topic}:`));
	assert.notEqual(start, -1, `a "#### ${topic}:" heading in:\n${part}`);
	const found = [lines[start] as string];
	for (const line of lines.slice(start + 1)) {
		if (line.startsWith("#### ")) {
			break;
		}
		found.push(line);
	}
	return found;
}

// The titles of the sample lines under one label ("Highest:", "Lowest:", ...), and any "- and N more" line as it is.
function under(lines: string[], label: string): string[] {
	const start = lines.indexOf(label);
	assert.notEqual(start, -1, `a "${label}" line in:\n${lines.join("\n")}`);
	const found: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (!line.startsWith("- ")) {
			break;
		}
		const match = line.match(/: (.+)$/);
		if (line.startsWith("- and ") || match === null) {
			found.push(line);
		} else {
			found.push(match[1] as string);
		}
	}
	return found;
}

test("Candidates scored on earlier days still give samples", () => {
	const pool = poolOf(
		ranks(12).map((rank) =>
			candidate(rank, { scoredOn: YESTERDAY, firstSeen: YESTERDAY }),
		),
	);
	const lines = topicLines(
		samplesPart(pool, INTERESTS, new Set(), TODAY),
		"Risks of AI",
	);
	assert.equal(lines[0], "#### Risks of AI: 12 scored");
	assert.deepEqual(under(lines, "Highest:"), [
		"Risks of AI paper 1",
		"Risks of AI paper 2",
		"Risks of AI paper 3",
	]);
	assert.deepEqual(under(lines, "Lowest:"), [
		"Risks of AI paper 10",
		"Risks of AI paper 11",
		"Risks of AI paper 12",
	]);
});

// Rank 13 scores lowest of all, so "Lowest" would show it if it counted. 2026-09-02 is 61 days before TODAY, past
// search.ts's 60 days; a paper of that date on a conference list still counts.
test("A paper submitted more than 60 days ago is left out of the samples, and one of the same date on a conference list stays", () => {
	const old = candidate(13, {
		published: "2026-09-02",
		title: "Risks of AI paper submitted 61 days ago",
	});
	const listed = candidate(14, {
		published: "2026-09-02",
		title: "Risks of AI paper on a conference list",
		listed: "AIES 2026",
	});
	const pool = poolOf(
		ranks(12)
			.map((rank) => candidate(rank))
			.concat([old, listed]),
	);
	const lines = topicLines(
		samplesPart(pool, INTERESTS, new Set(), TODAY),
		"Risks of AI",
	);
	assert.equal(lines[0], "#### Risks of AI: 13 scored");
	assert.deepEqual(under(lines, "Lowest:"), [
		"Risks of AI paper 11",
		"Risks of AI paper 12",
		"Risks of AI paper on a conference list",
	]);
});

test("A topic with few scored candidates shows each once, with its score, confidence and whether the scout picked it", () => {
	const pool = poolOf(ranks(4).map((rank) => candidate(rank)));
	const lines = topicLines(
		samplesPart(pool, INTERESTS, new Set(["2610.01002"]), TODAY),
		"Risks of AI",
	);
	assert.equal(lines[0], "#### Risks of AI: 4 scored");
	for (const rank of ranks(4)) {
		const shown = lines.filter((line) =>
			line.endsWith(`: Risks of AI paper ${rank}`),
		);
		assert.equal(
			shown.length,
			1,
			`paper ${rank} once in:\n${lines.join("\n")}`,
		);
	}
	assert.ok(
		lines.includes(
			"- score 3.90, confidence 0.90, picked: Risks of AI paper 2",
		),
		lines.join("\n"),
	);
	assert.ok(
		lines.includes(
			"- score 3.95, confidence 0.90, not picked: Risks of AI paper 1",
		),
		lines.join("\n"),
	);
});

test("A run whose scoring failed says so in place of the samples", () => {
	// Candidates search.ts found that Jev has not scored: no score, confidence, weighted score or day.
	const unscored = ranks(2).map((rank) => {
		const record = candidate(rank);
		delete record.weighted;
		delete record.scoredOn;
		delete record.score;
		delete record.confidence;
		delete record.topicProbabilities;
		return record;
	});
	const part = samplesPart(poolOf(unscored), INTERESTS, new Set(), TODAY);
	assert.match(
		part,
		/Scoring failed: Jev scored none of the 2 unscored candidates today/,
	);
	assert.equal(part.includes("####"), false, "no topic samples");
});

test("A topic with no scored candidate says so", () => {
	const pool = poolOf(ranks(4).map((rank) => candidate(rank)));
	const part = samplesPart(pool, INTERESTS, new Set(), TODAY);
	assert.deepEqual(topicLines(part, "Indonesian"), [
		"#### Indonesian: no scored candidate",
	]);
});

// Ranks 10 to 24 are doubtful: neither among the 3 highest nor the 3 lowest of 40.
test("A topic with 15 doubtful candidates lists 10 and counts the rest", () => {
	const pool = poolOf(
		ranks(40).map((rank) => {
			if (rank >= 10 && rank <= 24) {
				return candidate(rank, { confidence: 0.3 });
			}
			return candidate(rank);
		}),
	);
	const lines = topicLines(
		samplesPart(pool, INTERESTS, new Set(), TODAY),
		"Risks of AI",
	);
	assert.deepEqual(
		under(lines, "Doubtful, confidence below 0.5:"),
		[10, 11, 12, 13, 14, 15, 16, 17, 18, 19]
			.map((rank) => `Risks of AI paper ${rank}`)
			.concat(["- and 5 more"]),
	);
});

// The worst day the limits allow for: 200 candidates in each topic, every one doubtful, every title 300 characters.
test("A full day of long titles keeps the samples under 20,000 bytes, with each title cut to 90 characters", () => {
	const records: PoolRecord[] = [];
	for (const topic of [1, 2, 3, 4, 5, 6, 7, 8]) {
		for (const rank of ranks(200)) {
			records.push(
				candidate(rank, {
					id: `2610.${topic}${String(rank).padStart(4, "0")}`,
					title: "x".repeat(300),
					topics: [topic],
					confidence: 0.3,
				}),
			);
		}
	}
	const part = samplesPart(poolOf(records), INTERESTS, new Set(), TODAY);
	const bytes = Buffer.byteLength(part);
	assert.ok(bytes < 20000, `${bytes} bytes`);
	for (const line of part
		.split("\n")
		.filter((text) => text.startsWith("- score"))) {
		const title = (line.match(/: (.+)$/) as RegExpMatchArray)[1] as string;
		assert.ok(Array.from(title).length <= 90, line);
	}
});
