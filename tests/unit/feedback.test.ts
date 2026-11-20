// Dislike, OK and Like tests.

import assert from "node:assert/strict";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, test } from "vitest";
import { databaseFeedback } from "../../scripts/deploy/sync.ts";
import type { FeedbackRow } from "../../scripts/lib/feedback.ts";
import { feedbackFileOf, readFeedback } from "../../scripts/lib/feedback.ts";
import type { PoolRecord } from "../../scripts/scout/plan/pool.ts";
import { jevState } from "../../scripts/scout/score.ts";

// A paper's entry as the database stores it.
function paperEntry(n: number) {
	return {
		id: `arxiv:2609.0000${n}`,
		type: "paper",
		title: `Paper ${n}`,
		abstract: `Abstract ${n}.`,
		authors: ["Ada Example"],
	};
}

// ---- feedbackFileOf ----

test("feedback.json keeps only papers, with liked and disliked papers in separate lists, newest first", () => {
	const rows: FeedbackRow[] = [
		{ mark: "dislike", date: "2026-09-20", entry: paperEntry(1) },
		{ mark: "like", date: "2026-09-21", entry: paperEntry(2) },
		{ mark: "dislike", date: "2026-09-25", entry: paperEntry(3) },
		{
			mark: "dislike",
			date: "2026-09-26",
			entry: { id: "news:x", type: "news", title: "A news story" },
		},
	];
	assert.deepEqual(feedbackFileOf(rows), {
		liked: [
			{
				id: "arxiv:2609.00002",
				title: "Paper 2",
				abstract: "Abstract 2.",
				date: "2026-09-21",
				interest: "strong interest",
			},
		],
		disliked: [
			{
				id: "arxiv:2609.00003",
				title: "Paper 3",
				abstract: "Abstract 3.",
				date: "2026-09-25",
			},
			{
				id: "arxiv:2609.00001",
				title: "Paper 1",
				abstract: "Abstract 1.",
				date: "2026-09-20",
			},
		],
	});
});

test("feedback.json keeps only the 10 newest liked papers", () => {
	const rows: FeedbackRow[] = [];
	for (let n = 1; n <= 9; n++) {
		rows.push({ mark: "like", date: `2026-09-0${n}`, entry: paperEntry(n) });
	}
	for (let n = 10; n <= 12; n++) {
		rows.push({
			mark: "like",
			date: `2026-09-${n}`,
			entry: Object.assign(paperEntry(n), { id: `arxiv:2609.000${n}` }),
		});
	}
	const liked = feedbackFileOf(rows).liked;
	assert.equal(liked.length, 10);
	assert.equal(liked[0]?.date, "2026-09-12");
	assert.equal(liked[9]?.date, "2026-09-03");
});

test("feedback.json leaves out a paper without an abstract and an entry that is not an object", () => {
	const rows: FeedbackRow[] = [
		{
			mark: "like",
			date: "2026-09-20",
			entry: { id: "arxiv:2609.00001", type: "paper", title: "No abstract" },
		},
		{ mark: "like", date: "2026-09-20", entry: "not an object" },
	];
	assert.deepEqual(feedbackFileOf(rows), { liked: [], disliked: [] });
});

// ---- readFeedback ----

let cache = "";
beforeEach(() => {
	cache = mkdtempSync(join(tmpdir(), "liminal-feedback-unit-"));
	process.env.LIMINAL_CACHE = cache;
});
afterEach(() => {
	delete process.env.LIMINAL_CACHE;
	rmSync(cache, { recursive: true, force: true });
});

test("a missing feedback.json reads as empty lists", () => {
	assert.deepEqual(readFeedback(), { liked: [], disliked: [] });
});

test("A feedback.json that isn't JSON reads as empty lists", () => {
	writeFileSync(join(cache, "feedback.json"), "{not json");
	assert.deepEqual(readFeedback(), { liked: [], disliked: [] });
});

test("feedback.json is read as pull wrote it", () => {
	const file = {
		liked: [
			{
				id: "arxiv:2609.00002",
				title: "Paper 2",
				abstract: "Abstract 2.",
				date: "2026-09-21",
			},
		],
		disliked: [],
	};
	writeFileSync(join(cache, "feedback.json"), JSON.stringify(file));
	assert.deepEqual(readFeedback(), file);
});

// ---- jevState ----

test("Jev is told each disliked paper's title and abstract, and each liked paper's with how strongly", () => {
	const candidate: PoolRecord = {
		id: "2610.00001",
		title: "A candidate",
		abstract: "Its abstract.",
		authors: ["Ada Example"],
		published: "2026-10-06",
		note: null,
		topics: [1],
		firstSeen: "2026-10-06",
	};
	const state = jevState(
		"Interests.",
		{
			liked: [
				{
					id: "arxiv:2609.00002",
					title: "A liked paper",
					abstract: "Liked abstract.",
					date: "2026-10-02",
					interest: "strong interest",
				},
			],
			disliked: [
				{
					id: "arxiv:2609.00001",
					title: "A note on sycophancy",
					abstract: "We note something.",
					date: "2026-10-03",
				},
			],
		},
		candidate,
	);
	assert.deepEqual(state.disliked, [
		{ title: "A note on sycophancy", abstract: "We note something." },
	]);
	assert.deepEqual(state.liked, [
		{
			title: "A liked paper",
			abstract: "Liked abstract.",
			interest: "strong interest",
		},
	]);
});

// ---- the site's marks: worker/src/owner/ and migration 0007, on a real SQLite database ----

const ROOT = join(import.meta.dirname, "..", "..");
// The Worker's modules, loaded by their paths at run time: a static import would make the tests' type check read the
// Worker's files, which use Cloudflare's runtime types (as worker-routes.test.ts loads index.ts).
const OWNER_CHECKS = pathToFileURL(
	join(ROOT, "worker", "src", "owner", "checks.ts"),
).href;
const OWNER_STORE = pathToFileURL(
	join(ROOT, "worker", "src", "owner", "store.ts"),
).href;

type Change = { id: string; mark: string | null; date: string };
type OwnerModule = {
	feedbackChangeOf: (body: unknown) => Change;
	saveFeedback: (
		db: unknown,
		change: Change,
		count: (cost: unknown) => void,
	) => Promise<void>;
};

async function ownerModule(): Promise<OwnerModule> {
	const checks = await import(OWNER_CHECKS);
	const store = await import(OWNER_STORE);
	return { ...checks, ...store };
}

// An empty database that has run these migration files in order, as `wrangler d1 migrations apply` does.
function databaseAfter(migrations: string[]): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	for (const name of migrations) {
		db.exec(readFileSync(join(ROOT, "worker", "migrations", name), "utf8"));
	}
	return db;
}

// The feedback table's rows as {entry id: mark}.
function marksIn(db: DatabaseSync): Record<string, string> {
	const marks: Record<string, string> = {};
	for (const row of db.prepare("SELECT entry_id, mark FROM feedback").all()) {
		marks[String(row.entry_id)] = String(row.mark);
	}
	return marks;
}

// The part of D1's binding saveFeedback uses (prepare, bind, run), over a SQLite database that runs the real statements.
function d1Over(db: DatabaseSync) {
	return {
		prepare(sql: string) {
			const statement = db.prepare(sql);
			let values: (string | number | null)[] = [];
			const bound = {
				bind(...given: (string | number | null)[]) {
					values = given;
					return bound;
				},
				async run() {
					const result = statement.run(...values);
					return {
						results: [],
						meta: {
							rows_read: 0,
							rows_written: Number(result.changes),
							changes: Number(result.changes),
						},
					};
				},
			};
			return bound;
		},
	};
}

test("saving a mark replaces the entry's earlier mark, and saving no mark removes it", async () => {
	const { saveFeedback } = await ownerModule();
	const db = databaseAfter(["0003_feedback.sql"]);
	const site = d1Over(db);
	const save = (mark: string | null) =>
		saveFeedback(
			site,
			{ id: "arxiv:2609.00001", mark: mark, date: "2026-09-27" },
			() => {},
		);
	await save("ok");
	assert.deepEqual(marksIn(db), { "arxiv:2609.00001": "ok" });
	await save("like");
	assert.deepEqual(marksIn(db), { "arxiv:2609.00001": "like" });
	await save("dislike");
	assert.deepEqual(marksIn(db), { "arxiv:2609.00001": "dislike" });
	await save(null);
	assert.deepEqual(marksIn(db), {});
});

test('the site refuses a mark other than "dislike", "ok", "like" or null, saying which it takes', async () => {
	const { feedbackChangeOf } = await ownerModule();
	const body = (mark: unknown) => ({
		id: "arxiv:2609.00001",
		mark: mark,
		date: "2026-09-27",
	});
	for (const taken of ["dislike", "ok", "like", null]) {
		assert.equal(feedbackChangeOf(body(taken)).mark, taken);
	}
	for (const refused of ["love", "OK", "liked", "", 1, undefined]) {
		assert.throws(
			() => feedbackChangeOf(body(refused)),
			/mark must be "dislike", "ok", "like" or null/,
			`the mark ${String(refused)}`,
		);
	}
});

test("migration 0007 turns every saved like into ok and keeps every dislike and every mark's date", () => {
	const db = databaseAfter(["0003_feedback.sql"]);
	const insert = db.prepare(
		"INSERT INTO feedback (entry_id, mark, date) VALUES (?, ?, ?)",
	);
	insert.run("arxiv:2609.00001", "like", "2026-09-20");
	insert.run("arxiv:2609.00002", "dislike", "2026-09-21");
	insert.run("arxiv:2609.00003", "like", "2026-09-22");
	db.exec(
		readFileSync(
			join(ROOT, "worker", "migrations", "0007_feedback_ok.sql"),
			"utf8",
		),
	);
	assert.deepEqual(marksIn(db), {
		"arxiv:2609.00001": "ok",
		"arxiv:2609.00002": "dislike",
		"arxiv:2609.00003": "ok",
	});
	// The days the marks were pressed are kept.
	const dates = db
		.prepare("SELECT date FROM feedback ORDER BY entry_id")
		.all()
		.map((row) => row.date);
	assert.deepEqual(dates, ["2026-09-20", "2026-09-21", "2026-09-22"]);
});

test("pull --database reads an OK mark and passes it on as liked", async () => {
	const db = databaseAfter(["0001_init.sql", "0003_feedback.sql"]);
	db.prepare(
		"INSERT INTO entries (id, date, seq, json, updated) VALUES (?, ?, ?, ?, ?)",
	).run(
		"arxiv:2609.00001",
		"2026-10-01",
		1,
		JSON.stringify(paperEntry(1)),
		"2026-10-01T00:00:00.000Z",
	);
	db.prepare(
		"INSERT INTO feedback (entry_id, mark, date) VALUES (?, ?, ?)",
	).run("arxiv:2609.00001", "ok", "2026-10-05");
	process.env.LIMINAL_TODAY = "2026-10-06";
	try {
		const { databaseFeedback } = await import("../../scripts/deploy/sync.ts");
		const rows = await databaseFeedback(async (sql, params) =>
			db.prepare(sql).all(...params),
		);
		const file = feedbackFileOf(rows);
		assert.deepEqual(
			file.liked.map((paper) => paper.title),
			["Paper 1"],
		);
		assert.deepEqual(file.disliked, []);
	} finally {
		delete process.env.LIMINAL_TODAY;
	}
});

// ---- what pull and score pass on ----

// A database with every migration applied, holding these entries (JSON as a digests line holds it) and these marks.
function databaseWith(
	entries: { id: string; type: string; title: string }[],
	marks: { id: string; mark: string; date: string }[],
): DatabaseSync {
	const migrations = readdirSync(join(ROOT, "worker", "migrations"))
		.filter((name) => name.endsWith(".sql"))
		.sort();
	const db = databaseAfter(migrations);
	let seq = 0;
	for (const entry of entries) {
		seq++;
		db.prepare(
			"INSERT INTO entries (id, date, seq, json, updated) VALUES (?, ?, ?, ?, ?)",
		).run(
			entry.id,
			"2026-10-01",
			seq,
			JSON.stringify({ ...entry, abstract: `Abstract of ${entry.title}.` }),
			"2026-10-01T00:00:00.000Z",
		);
	}
	for (const mark of marks) {
		db.prepare(
			"INSERT INTO feedback (entry_id, mark, date) VALUES (?, ?, ?)",
		).run(mark.id, mark.mark, mark.date);
	}
	return db;
}

// pull --database's read of the marks, from a database of the real tables, as of `today`.
async function pulledFeedback(db: DatabaseSync, today: string) {
	process.env.LIMINAL_TODAY = today;
	try {
		const rows = await databaseFeedback(async (sql, params) =>
			db.prepare(sql).all(...params),
		);
		return feedbackFileOf(rows);
	} finally {
		delete process.env.LIMINAL_TODAY;
	}
}

test("pull --database passes on marks on papers with their abstracts, and none on news, articles or reports", async () => {
	const db = databaseWith(
		[
			{ id: "paper:1", type: "paper", title: "A liked paper" },
			{ id: "paper:2", type: "paper", title: "A disliked paper" },
			{ id: "news:1", type: "news", title: "A liked news item" },
			{ id: "article:1", type: "article", title: "An OK article" },
			{ id: "report:1", type: "report", title: "A disliked report" },
		],
		[
			{ id: "paper:1", mark: "like", date: "2026-10-05" },
			{ id: "paper:2", mark: "dislike", date: "2026-10-04" },
			{ id: "news:1", mark: "like", date: "2026-10-05" },
			{ id: "article:1", mark: "ok", date: "2026-10-05" },
			{ id: "report:1", mark: "dislike", date: "2026-10-05" },
		],
	);
	const file = await pulledFeedback(db, "2026-10-06");
	assert.deepEqual(file, {
		liked: [
			{
				id: "paper:1",
				title: "A liked paper",
				abstract: "Abstract of A liked paper.",
				date: "2026-10-05",
				interest: "strong interest",
			},
		],
		disliked: [
			{
				id: "paper:2",
				title: "A disliked paper",
				abstract: "Abstract of A disliked paper.",
				date: "2026-10-04",
			},
		],
	});
});

test("feedback.json lists OK papers as acceptable and Like papers as a strong interest, in one liked list, newest first", () => {
	const rows: FeedbackRow[] = [
		{ mark: "like", date: "2026-09-20", entry: paperEntry(1) },
		{ mark: "ok", date: "2026-09-25", entry: paperEntry(2) },
		{ mark: "like", date: "2026-09-22", entry: paperEntry(3) },
	];
	assert.deepEqual(
		feedbackFileOf(rows).liked.map((paper) => [
			paper.title,
			paper.interest,
			paper.date,
		]),
		[
			["Paper 2", "acceptable", "2026-09-25"],
			["Paper 3", "strong interest", "2026-09-22"],
			["Paper 1", "strong interest", "2026-09-20"],
		],
	);
});

test("feedback.json keeps the 10 newest liked papers, OK and Like together, and the 10 newest disliked papers", () => {
	const rows: FeedbackRow[] = [];
	// 6 Likes and 6 OKs, one a day, and 12 dislikes, one a day.
	for (let n = 1; n <= 12; n++) {
		const day = `2026-09-${String(n).padStart(2, "0")}`;
		const liked = n % 2 === 0 ? "like" : "ok";
		const entry = (kind: string) => ({
			...paperEntry(1),
			id: `arxiv:${kind}${n}`,
			title: `${kind} ${n}`,
		});
		rows.push({ mark: liked, date: day, entry: entry("liked") });
		rows.push({ mark: "dislike", date: day, entry: entry("disliked") });
	}
	const file = feedbackFileOf(rows);
	assert.deepEqual(
		file.liked.map((paper) => paper.date),
		["12", "11", "10", "09", "08", "07", "06", "05", "04", "03"].map(
			(day) => `2026-09-${day}`,
		),
	);
	assert.deepEqual(
		new Set(file.liked.map((paper) => paper.interest)),
		new Set(["acceptable", "strong interest"]),
	);
	assert.deepEqual(
		file.disliked.map((paper) => paper.date),
		["12", "11", "10", "09", "08", "07", "06", "05", "04", "03"].map(
			(day) => `2026-09-${day}`,
		),
	);
});

test("a dislike of 30 days ago is still passed on", async () => {
	const db = databaseWith(
		[{ id: "paper:1", type: "paper", title: "A note on sycophancy" }],
		[{ id: "paper:1", mark: "dislike", date: "2026-09-06" }],
	);
	const file = await pulledFeedback(db, "2026-10-06");
	assert.deepEqual(
		file.disliked.map((paper) => paper.title),
		["A note on sycophancy"],
	);
});

test("a dislike of 31 days ago is no longer passed on", async () => {
	const db = databaseWith(
		[{ id: "paper:1", type: "paper", title: "A note on sycophancy" }],
		[{ id: "paper:1", mark: "dislike", date: "2026-09-05" }],
	);
	const file = await pulledFeedback(db, "2026-10-06");
	assert.deepEqual(file.disliked, []);
});

test("without feedback.json Jev gets empty lists", () => {
	const none = readFeedback();
	const candidate: PoolRecord = {
		id: "2610.00001",
		title: "A candidate",
		abstract: "Its abstract.",
		authors: ["Ada Example"],
		published: "2026-10-06",
		note: null,
		topics: [1],
		firstSeen: "2026-10-06",
	};
	const state = jevState("Interests.", none, candidate);
	assert.deepEqual(state.liked, []);
	assert.deepEqual(state.disliked, []);
});
