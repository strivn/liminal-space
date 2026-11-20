// How the site stores threads, comments and highlights, run against the Worker's code and a local D1.
import assert from "node:assert/strict";
import { afterAll, beforeAll, beforeEach, describe, test } from "vitest";
import type {
	PageComment,
	SiteThread,
	ThreadPlace,
} from "../../shared/owner-protocol.ts";
import { usableThreads } from "../../site/page/comments.ts";
import { requestLogs } from "../support/cloud.ts";
import { postToSite } from "../support/owner.ts";
import {
	type BodyProblem,
	emptyComments,
	ignoreCost,
	type OwnerWorker,
	startOwnerWorker,
	startWorkerBefore,
	workerModule,
} from "./owner-worker.ts";

const MIGRATION_0005 = "0005_thread_highlight.sql";

const ENTRY = "arxiv:2601.00001";
const PASSAGE = "steering vectors fail";
const CREATED = "2026-11-05T01:00:00.000Z";

let worker: OwnerWorker;

// One Worker and its D1 for the file; each test starts from an empty site.
beforeAll(async () => {
	worker = await startOwnerWorker();
});
afterAll(async () => {
	await worker.stop();
});
beforeEach(async () => {
	await emptyComments(worker.db);
});

// A thread on a passage of the abstract, as the page names it.
function passageThread(id: string): ThreadPlace {
	return { id: id, field: "abstract", passage: PASSAGE, occurrence: 1 };
}

// A thread on the whole entry.
function wholeEntryThread(id: string): ThreadPlace {
	return { id: id, field: null, passage: null, occurrence: null };
}

function commentOf(id: string): PageComment {
	return { id: id, text: `text of ${id}`, created: CREATED, edited: null };
}

// A body as the page posts it to the comments route, checked and saved by the Worker's own code.
async function save(body: {
	entryId?: string;
	thread: ThreadPlace;
	save?: PageComment[];
	delete?: string[];
	highlight?: boolean;
}): Promise<void> {
	const change = worker.owner.commentsChangeOf({
		entryId: body.entryId || ENTRY,
		thread: body.thread,
		save: body.save || [],
		delete: body.delete || [],
		highlight: body.highlight,
	});
	await worker.owner.saveComments(worker.db, change, ignoreCost);
}

// The threads the site holds for an entry, as GET state reads them.
async function threadsOf(entryId: string): Promise<SiteThread[]> {
	const state = await worker.owner.readState(worker.db, ignoreCost);
	return state.comments[entryId] || [];
}

// The refusal the Worker's code throws for `body`, or a failure when it takes the body.
function refusalOf(body: unknown): BodyProblem {
	try {
		worker.owner.commentsChangeOf(body);
	} catch (error) {
		assert.ok(
			error instanceof worker.respond.BodyProblem,
			`a refusal, not ${String(error)}`,
		);
		return error;
	}
	throw new Error("the Worker took the body");
}

describe("highlights", () => {
	test("a highlight with no comment is stored and read back with no comments", async () => {
		await save({ thread: passageThread("t1"), highlight: true });
		assert.deepEqual(await threadsOf(ENTRY), [
			{ ...passageThread("t1"), highlight: true, comments: [] },
		]);
	});

	test("a highlighted thread with no comments reads the same on the owner's page and through the connector", async () => {
		await save({ thread: passageThread("t1"), highlight: true });
		const notes = await worker.owner.notesFor(worker.db, [ENTRY], ignoreCost);
		assert.deepEqual(notes.get(ENTRY)?.threads, await threadsOf(ENTRY));
		assert.deepEqual(notes.get(ENTRY)?.threads, [
			{ ...passageThread("t1"), highlight: true, comments: [] },
		]);
	});

	test("deleting the last comment of a highlight keeps the thread", async () => {
		await save({
			thread: passageThread("t1"),
			save: [commentOf("c1")],
			highlight: true,
		});
		await save({ thread: passageThread("t1"), delete: ["c1"] });
		assert.deepEqual(await threadsOf(ENTRY), [
			{ ...passageThread("t1"), highlight: true, comments: [] },
		]);
	});

	test("deleting the last comment of a thread that isn't a highlight removes the thread", async () => {
		await save({ thread: passageThread("t2"), save: [commentOf("c2")] });
		await save({ thread: passageThread("t2"), delete: ["c2"] });
		assert.deepEqual(await threadsOf(ENTRY), []);
	});

	test("removing the highlight from a thread with no comments removes the thread", async () => {
		await save({ thread: passageThread("t1"), highlight: true });
		await save({ thread: passageThread("t1"), highlight: false });
		assert.deepEqual(await threadsOf(ENTRY), []);
	});

	test("a change with no comment to save or delete and no highlight flag is refused", () => {
		const refusal = refusalOf({
			entryId: ENTRY,
			thread: passageThread("t1"),
			save: [],
			delete: [],
		});
		assert.equal(refusal.status, 400);
		assert.equal(refusal.message, "save or delete must hold a comment");
	});

	test("a highlight on the whole entry is refused", () => {
		const refusal = refusalOf({
			entryId: ENTRY,
			thread: wholeEntryThread("t1"),
			save: [],
			delete: [],
			highlight: true,
		});
		assert.equal(refusal.status, 400);
		assert.equal(refusal.message, "only a passage can be highlighted");
	});

	// The Worker starts on the migrations before 0005 and holds the thread; the later migrations then run, as a deploy
	// applies them.
	test("threads stored before highlights existed read as no highlight", async () => {
		const before = await startWorkerBefore(MIGRATION_0005);
		try {
			const db = before.db;
			await db.batch([
				db
					.prepare(
						"INSERT INTO threads (id, entry_id, field, passage, occurrence, created) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
					)
					.bind("t3", ENTRY, "abstract", PASSAGE, 1, CREATED),
				db
					.prepare(
						"INSERT INTO comments (id, thread_id, text, created, edited) VALUES (?1, ?2, ?3, ?4, NULL)",
					)
					.bind("t3-comment-1", "t3", "Contradicts Table 3", CREATED),
			]);
			await before.applyRest();
			const state = await worker.owner.readState(db, ignoreCost);
			const threads = state.comments[ENTRY] || [];
			assert.equal(threads.length, 1);
			assert.equal(threads[0]?.id, "t3");
			assert.equal(threads[0]?.highlight, false);
			assert.deepEqual(
				threads[0]?.comments.map((comment) => comment.id),
				["t3-comment-1"],
			);
		} finally {
			await before.stop();
		}
	});

	test("the page keeps an empty stored thread only when it is a highlight", () => {
		const stored = [
			{ ...passageThread("a"), highlight: true, comments: [] },
			{ ...passageThread("b"), comments: [] },
		];
		assert.deepEqual(
			usableThreads(stored).map((thread) => thread.id),
			["a"],
		);
	});
});

describe("threads", () => {
	test("comments saved under a thread id that belongs to another entry are refused and change nothing", async () => {
		await save({ thread: wholeEntryThread("t1"), save: [commentOf("c1")] });
		await assert.rejects(
			save({
				entryId: "arxiv:2601.00002",
				thread: wholeEntryThread("t1"),
				save: [commentOf("c2")],
			}),
			(error: unknown) => {
				assert.ok(error instanceof worker.respond.BodyProblem);
				assert.equal(error.status, 400);
				assert.match(error.message, /belongs to another entry/);
				return true;
			},
		);
		const first = await threadsOf(ENTRY);
		assert.deepEqual(
			first.map((thread) => thread.comments.map((comment) => comment.id)),
			[["c1"]],
		);
		assert.deepEqual(await threadsOf("arxiv:2601.00002"), []);
	});

	test("security: saving or deleting a comment id that belongs to another thread is refused any effect: its text and thread stay", async () => {
		await save({ thread: wholeEntryThread("t1"), save: [commentOf("c1")] });
		await save({
			thread: wholeEntryThread("t2"),
			save: [{ ...commentOf("c1"), text: "taken over", edited: CREATED }],
		});
		await save({ thread: wholeEntryThread("t2"), delete: ["c1"] });
		assert.deepEqual(
			(await threadsOf(ENTRY)).map((thread) => [
				thread.id,
				thread.comments.map((comment) => [comment.id, comment.text]),
			]),
			[["t1", [["c1", "text of c1"]]]],
		);
	});

	test("a reply saved on another device survives an edit of the first comment made without seeing it", async () => {
		await save({ thread: wholeEntryThread("t1"), save: [commentOf("c1")] });
		// The other device adds a reply; this page hasn't read the state since.
		await save({ thread: wholeEntryThread("t1"), save: [commentOf("c2")] });
		await save({
			thread: wholeEntryThread("t1"),
			save: [{ ...commentOf("c1"), text: "c1, edited", edited: CREATED }],
		});
		const [thread] = await threadsOf(ENTRY);
		assert.deepEqual(
			thread?.comments.map((comment) => [comment.id, comment.text]),
			[
				["c1", "c1, edited"],
				["c2", "text of c2"],
			],
		);
	});

	test("deleting a thread here deletes only the comments this page knew, so a reply added on another device stays", async () => {
		await save({ thread: wholeEntryThread("t1"), save: [commentOf("c1")] });
		await save({ thread: wholeEntryThread("t1"), save: [commentOf("c2")] });
		await save({ thread: wholeEntryThread("t1"), delete: ["c1"] });
		const [thread] = await threadsOf(ENTRY);
		assert.deepEqual(
			thread?.comments.map((comment) => comment.id),
			["c2"],
		);
	});

	test("setting or clearing one tag keeps the other tag that another device set", async () => {
		const store = await workerModule<{
			saveTags(
				db: unknown,
				change: { id: string; tag: string; on: boolean },
				count: typeof ignoreCost,
			): Promise<void>;
		}>("owner/store.ts");
		await store.saveTags(
			worker.db,
			{ id: ENTRY, tag: "learnFirst", on: true },
			ignoreCost,
		);
		await store.saveTags(
			worker.db,
			{ id: ENTRY, tag: "toRead", on: true },
			ignoreCost,
		);
		const state = await worker.owner.readState(worker.db, ignoreCost);
		assert.deepEqual(state.tags[ENTRY], { toRead: true, learnFirst: true });
		await store.saveTags(
			worker.db,
			{ id: ENTRY, tag: "toRead", on: false },
			ignoreCost,
		);
		const after = await worker.owner.readState(worker.db, ignoreCost);
		assert.deepEqual(after.tags[ENTRY], { learnFirst: true });
	});

	test("a read mark saved again at another depth replaces the stored depth and date", async () => {
		const store = await workerModule<{
			saveRead(
				db: unknown,
				change: { id: string; depth: string; date: string },
				count: typeof ignoreCost,
			): Promise<void>;
		}>("owner/store.ts");
		try {
			await store.saveRead(
				worker.db,
				{ id: ENTRY, depth: "abstract", date: "2026-11-05" },
				ignoreCost,
			);
			await store.saveRead(
				worker.db,
				{ id: ENTRY, depth: "paper", date: "2026-11-06" },
				ignoreCost,
			);
			const state = await worker.owner.readState(worker.db, ignoreCost);
			assert.deepEqual(state.read[ENTRY], {
				depth: "paper",
				date: "2026-11-06",
			});
		} finally {
			await worker.db.prepare("DELETE FROM read_state").run();
		}
	});
});

describe("cost", () => {
	test("saving a read mark reads at most 5 database rows, however many read marks and tags the site holds", async () => {
		// 5,000 read marks and 2,000 tags, each written by one recursive statement.
		const rows = (
			table: string,
			columns: string,
			values: string,
			count: number,
		) =>
			worker.db
				.prepare(
					`INSERT INTO ${table} (${columns}) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count}) SELECT ${values} FROM n`,
				)
				.run();
		await rows(
			"read_state",
			"entry_id, depth, date",
			"'seed-' || i, 'abstract', '2026-10-20'",
			5000,
		);
		await rows(
			"tags",
			"entry_id, to_read, learn_first",
			"'seed-' || i, 1, 0",
			2000,
		);
		try {
			const before = requestLogs(worker.cloud).length;
			const answer = await postToSite(
				worker.cloud,
				"/liminal-space/api/owner/read",
				{ id: "arxiv:2601.00001", depth: "paper", date: "2026-11-05" },
			);
			assert.equal(answer.status, 200);
			const line = requestLogs(worker.cloud).slice(before)[0];
			assert.ok(line, "the request's log line");
			assert.ok(line.rowsRead <= 5, `${line.rowsRead} rows read`);
		} finally {
			await worker.db.batch([
				worker.db.prepare("DELETE FROM read_state"),
				worker.db.prepare("DELETE FROM tags"),
			]);
		}
	});
});
