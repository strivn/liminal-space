// Unit tests for the pure exports of scripts/scout/hugging-face/hugging-face.ts (rankHuggingFace, latestList), on daily lists in the shape
// Hugging Face's /api/daily_papers gives them (paper.id, title, summary, authors[].name, publishedAt, upvotes).
// Expected values are written out by hand.

import assert from "node:assert/strict";
import { test } from "vitest";
import type * as HuggingFace from "../../scripts/scout/hugging-face/hugging-face.ts";

const SCRIPT = new URL(
	"../../scripts/scout/hugging-face/hugging-face.ts",
	import.meta.url,
);

// One item of a daily list: paper n, first submitted on 2026-10-2<n % 10>, with `upvotes` on the list.
function item(n: number, upvotes: number): unknown {
	return {
		paper: {
			id: `2610.${String(n).padStart(5, "0")}`,
			title: `Paper ${n}`,
			summary: `Abstract ${n}.`,
			authors: [{ name: "Yoshua Bengio" }, { name: "Geoffrey Hinton" }],
			publishedAt: `2026-10-2${n % 10}T00:00:00.000Z`,
			upvotes: upvotes,
		},
		title: `Paper ${n}`,
	};
}

// Paper n as the module gives it, listed on `listed` with `upvotes`.
function paper(
	n: number,
	listed: string,
	upvotes: number,
	fromList: boolean,
): HuggingFace.HuggingFacePaper {
	return {
		id: `2610.${String(n).padStart(5, "0")}`,
		title: `Paper ${n}`,
		abstract: `Abstract ${n}.`,
		authors: ["Yoshua Bengio", "Geoffrey Hinton"],
		published: `2026-10-2${n % 10}`,
		listed: listed,
		upvotes: upvotes,
		fromList: fromList,
	};
}

// Twelve papers over two days, list counts 1 to 12: papers 1 and 2 have the fewest and fall outside the 10.
function twelvePapers(): Record<string, unknown[]> {
	const first = [];
	const second = [];
	for (let n = 1; n <= 6; n++) {
		first.push(item(n, n));
		second.push(item(n + 6, n + 6));
	}
	return { "2026-10-29": first, "2026-10-30": second };
}

test("The 10 papers with the most upvotes on the daily lists come back with their details, ranked by each paper's own upvote count", async () => {
	const { rankHuggingFace }: typeof HuggingFace = await import(SCRIPT.href);
	const live: Record<string, number> = {};
	for (let n = 3; n <= 12; n++) {
		live[`2610.${String(n).padStart(5, "0")}`] = 100 - n;
	}
	const ranked = rankHuggingFace(twelvePapers(), live);
	assert.deepEqual(
		ranked.map((entry) => entry.id),
		[3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(
			(n) => `2610.${String(n).padStart(5, "0")}`,
		),
	);
	assert.deepEqual(ranked[0], paper(3, "2026-10-29", 97, false));
});

test("A paper whose own record can't be read keeps the upvote count from the list", async () => {
	const { rankHuggingFace }: typeof HuggingFace = await import(SCRIPT.href);
	const ranked = rankHuggingFace(
		{ "2026-10-30": [item(1, 40), item(2, 30)] },
		{
			"2610.00002": 50,
		},
	);
	assert.deepEqual(ranked, [
		paper(2, "2026-10-30", 50, false),
		paper(1, "2026-10-30", 40, true),
	]);
});

test("A paper listed on two days appears once, with its first listing date and its highest upvote count from the lists", async () => {
	const { rankHuggingFace }: typeof HuggingFace = await import(SCRIPT.href);
	const ranked = rankHuggingFace(
		{ "2026-10-29": [item(1, 5)], "2026-10-30": [item(1, 9)] },
		{},
	);
	assert.deepEqual(ranked, [paper(1, "2026-10-29", 9, true)]);
});

test("An item without a paper id is left out", async () => {
	const { rankHuggingFace }: typeof HuggingFace = await import(SCRIPT.href);
	const ranked = rankHuggingFace(
		{
			"2026-10-30": [{ paper: { title: "No id" } }, "not an item", item(1, 3)],
		},
		{},
	);
	assert.deepEqual(ranked, [paper(1, "2026-10-30", 3, true)]);
});

test("The latest list comes from the newest day that has papers, in that list's own order", async () => {
	const { latestList }: typeof HuggingFace = await import(SCRIPT.href);
	const lists = {
		"2026-10-30": [item(1, 3), item(2, 8)],
		"2026-10-31": [],
		"2026-11-01": [],
	};
	assert.deepEqual(latestList(lists), [
		paper(1, "2026-10-30", 3, true),
		paper(2, "2026-10-30", 8, true),
	]);
});

test("Lists that are all empty have no latest list", async () => {
	const { latestList }: typeof HuggingFace = await import(SCRIPT.href);
	assert.deepEqual(latestList({ "2026-10-31": [], "2026-11-01": [] }), []);
});
