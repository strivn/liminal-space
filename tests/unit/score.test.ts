// Unit tests for the exports of scripts/scout/score.ts: reading each topic's
// weight from interests.md, and the weighted score. Expected values are worked out by hand in the comments.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { topicWeights } from "../../scripts/scout/plan/pool.ts";
import { weightedScore } from "../../scripts/scout/score.ts";

// The repo's own interests.md, as the owner wrote it on 2026-10-27.
const INTERESTS = readFileSync(
	new URL("../../interests.md", import.meta.url),
	"utf8",
);

test("The repository's interests.md gives each topic its weight, and a weight for papers on none of them", () => {
	const weights = topicWeights(INTERESTS);
	assert.ok(weights !== null);
	assert.deepEqual(
		weights.topics.map((topic) => [topic.key, topic.weight]),
		[
			["t1", 1],
			["t2", 1],
			["t3", 0.97],
			["t4", 0.97],
			["t5", 0.94],
			["t6", 0.9],
			["t7", 0.9],
			["t8", 0.9],
		],
	);
	assert.equal(weights.none, 0.75);
});

test("A topic's name is the text before its weight", () => {
	const weights = topicWeights(INTERESTS);
	assert.ok(weights !== null);
	assert.equal(weights.topics[0]?.name, "Risks of AI");
	assert.equal(
		weights.topics[6]?.name,
		"Robotics and embodied AI, and voice-native AI",
	);
});

test("A topic listed without a weight leaves the file without weights", () => {
	const markdown = [
		"## Topics, highest priority first",
		"1. Risks of AI (weight 1.00): honesty",
		"2. Privacy: differential privacy",
		"",
		"A paper on none of these topics has weight 0.75.",
	].join("\n");
	assert.equal(topicWeights(markdown), null);
});

test("A file without the weight for papers on none of the topics has no weights", () => {
	const markdown = [
		"## Topics, highest priority first",
		"1. Risks of AI (weight 1.00): honesty",
	].join("\n");
	assert.equal(topicWeights(markdown), null);
});

test("The weighted score is the score times the sum of each topic's probability times its weight", () => {
	const weights = {
		topics: [
			{ key: "t1", name: "Risks of AI", weight: 1 },
			{ key: "t6", name: "Privacy", weight: 0.9 },
		],
		none: 0.75,
	};
	// 3 x (0.5 x 1.00 + 0.3 x 0.90 + 0.2 x 0.75) = 3 x 0.92 = 2.76
	assert.ok(
		Math.abs(
			weightedScore(3, { t1: 0.5, t6: 0.3, none: 0.2 }, weights) - 2.76,
		) < 1e-9,
	);
	// A score of 0 is 0 whatever the topic.
	assert.equal(weightedScore(0, { t1: 1 }, weights), 0);
});
