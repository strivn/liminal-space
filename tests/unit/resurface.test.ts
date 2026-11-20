// Unit tests for resurfacing unread papers: the scores search.ts keeps, the read
// marks pull reads, and which papers the shelf lists.
// Run the process in a zone far from Jakarta so date logic that leans on the machine's zone fails.
process.env.TZ = "America/Los_Angeles";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import type * as Sync from "../../scripts/deploy/sync.ts";
import type * as PoolModule from "../../scripts/scout/plan/pool.ts";
import { type ShelfPaper, waitingPapers } from "../../site/page/shelf.ts";
import type { ReadState } from "../../site/page/types.ts";

const POOL = new URL("../../scripts/scout/plan/pool.ts", import.meta.url);
const SYNC = new URL("../../scripts/deploy/sync.ts", import.meta.url);

// The pool module sets up its cache folder on import: point it at a fresh folder, deleted when the tests end.
const TEST_TMPDIR = mkdtempSync(join(tmpdir(), "liminal-unit-resurface-"));
process.env.TMPDIR = TEST_TMPDIR;
process.env.LIMINAL_CACHE = join(TEST_TMPDIR, "cache");
afterAll(() => {
	rmSync(TEST_TMPDIR, { recursive: true, force: true });
});

const TODAY = "2026-10-27";

// ---- The scores search.ts keeps ----

test("A scored paper from the pool that is now in the digests has its weighted score saved, and scores saved earlier stay", async () => {
	const { keepScores }: typeof PoolModule = await import(POOL.href);
	const record = (id: string, weighted?: number) => {
		const value: PoolModule.PoolRecord = {
			id: id,
			title: `Paper ${id}`,
			abstract: "",
			authors: [],
			published: "2026-10-01",
			note: null,
			topics: [1],
			firstSeen: "2026-10-01",
		};
		if (weighted !== undefined) value.weighted = weighted;
		return value;
	};
	const pool: PoolModule.Pool = {
		"2610.00001": record("2610.00001", 3.5),
		"2610.00002": record("2610.00002"),
		"2610.00003": record("2610.00003", 1.0),
	};
	const kept: Record<string, unknown> = { "2609.00009": 2.0 };
	keepScores(pool, new Set(["2610.00001", "2610.00002"]), kept);
	// Only the scored paper now in the digests; the earlier one stays.
	assert.deepEqual(kept, { "2609.00009": 2.0, "2610.00001": 3.5 });
});

// ---- The read marks pull reads ----

test("A pull from the database lists every entry with a read mark, sorted by id", async () => {
	const { readMarkIds }: typeof Sync = await import(SYNC.href);
	const asked: string[] = [];
	const ids = await readMarkIds(async (sql) => {
		asked.push(sql);
		return [{ entry_id: "arxiv:2610.00003" }, { entry_id: "arxiv:2610.00001" }];
	});
	assert.deepEqual(ids, ["arxiv:2610.00001", "arxiv:2610.00003"]);
	assert.deepEqual(asked, ["SELECT entry_id FROM read_state"]);
});

// ---- The page ----

// A paper the shelf may list.
function shelfPaper(n: number, date: string): ShelfPaper {
	return { id: `p${n}`, date: date, month: date.slice(0, 7), title: null };
}

test("The shelf lists unread papers 10 days or older, oldest first, at most 10", () => {
	const state: ReadState = Object.create(null);
	state.p2 = { depth: "abstract", date: TODAY };
	const papers = [
		shelfPaper(1, "2026-10-17"),
		shelfPaper(2, "2026-10-01"),
		shelfPaper(3, "2026-10-18"),
		shelfPaper(4, "2026-09-15"),
	];
	assert.deepEqual(
		waitingPapers(papers, state, TODAY).map((each) => each.id),
		["p4", "p1"],
	);
	const many = Array.from({ length: 12 }, (_, i) =>
		shelfPaper(i + 10, `2026-09-${String(i + 10).padStart(2, "0")}`),
	);
	const listed = waitingPapers(many, Object.create(null), TODAY);
	assert.equal(listed.length, 10);
	assert.equal(listed[0]?.id, "p10");
});
