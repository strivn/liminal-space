// What the Worker's push route stores (worker/src/push.ts): new entries, fills, refusals and races, run on the real code
// over a SQLite database with the real migrations.
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, test } from "vitest";
import { FIELD_CAPS } from "../../shared/entry-checks.ts";
import type { JsonObject } from "../../shared/narrow.ts";
import {
	type Access,
	migratedDatabase,
	startAccess,
	workerEnv,
} from "../fixtures/worker-in-node.ts";
import { workerModule } from "./owner-worker.ts";

type Result =
	| { id: string; outcome: "added" | "already there" }
	| { id: string; outcome: "filled"; fields: string[] }
	| { id: string | null; outcome: "refused"; problems: string[] };
type Item = { date: string; entry: JsonObject };
type Cost = { rowsRead: number; rowsWritten: number };
type Log = {
	method: string;
	path: string;
	status: number;
	reason?: string;
	queries: number;
	rowsRead: number;
	rowsWritten: number;
};
type PushModule = {
	push(
		db: unknown,
		items: Item[],
		count: (cost: Cost) => void,
	): Promise<{ results: Result[] }>;
	answerPush(
		request: Request,
		env: unknown,
		ctx: unknown,
		log: Log,
	): Promise<Response>;
};

let pushing: PushModule;
let access: Access;

beforeAll(async () => {
	pushing = await workerModule<PushModule>("push.ts");
	access = await startAccess();
});

afterAll(async () => {
	await access.close();
});

// A paper as arxiv.ts writes it, without a figure.
function paper(id: string, more: JsonObject = {}): JsonObject {
	return {
		id: `arxiv:${id}`,
		type: "paper",
		title: `Paper ${id}`,
		authors: ["A. Author"],
		published: "2026-10-20",
		source: "arXiv",
		url: `https://arxiv.org/abs/${id}`,
		abstract: "An abstract.",
		...more,
	};
}

function item(entry: JsonObject, date = "2026-10-20"): Item {
	return { date: date, entry: entry };
}

// A migrated database, the Worker's D1 over it, and what a push wrote into it.
function site() {
	const sqlite = migratedDatabase();
	const env = workerEnv(access, sqlite);
	let written = 0;
	let statements = 0;
	return {
		sqlite: sqlite,
		db: env.DB,
		env: env,
		push: (items: Item[]) =>
			pushing.push(env.DB, items, (cost) => {
				statements += 1;
				written += cost.rowsWritten;
			}),
		written: () => written,
		statements: () => statements,
	};
}

function stored(sqlite: DatabaseSync, id: string) {
	const row = sqlite
		.prepare("SELECT date, seq, json FROM entries WHERE id = ?")
		.get(id);
	assert.ok(row, `${id} is stored`);
	return {
		date: String(row.date),
		seq: Number(row.seq),
		json: JSON.parse(String(row.json)),
	};
}

test("a new entry is stored under its date and placed after every stored entry", async () => {
	const { sqlite, push } = site();
	const answer = await push([
		item(paper("2610.00001")),
		item(paper("2610.00002"), "2026-10-21"),
	]);
	assert.deepEqual(
		answer.results.map((result) => result.outcome),
		["added", "added"],
	);
	assert.equal(stored(sqlite, "arxiv:2610.00001").seq, 1);
	assert.equal(stored(sqlite, "arxiv:2610.00002").seq, 2);
	assert.equal(stored(sqlite, "arxiv:2610.00002").date, "2026-10-21");
});

test("pushing a stored entry again fills a field it lacks, and keeps its stored fields and date", async () => {
	const { sqlite, push } = site();
	await push([item(paper("2610.00001"))]);
	const answer = await push([
		item(
			paper("2610.00001", { title: "A new title", award: "Best paper" }),
			"2026-11-01",
		),
	]);
	assert.deepEqual(answer.results, [
		{ id: "arxiv:2610.00001", outcome: "filled", fields: ["award"] },
	]);
	const entry = stored(sqlite, "arxiv:2610.00001");
	assert.equal(entry.json.title, "Paper 2610.00001");
	assert.equal(entry.json.award, "Best paper");
	assert.equal(entry.date, "2026-10-20");
});

test("an entry the site already has, with nothing to fill, is reported and not written", async () => {
	const { push, written } = site();
	await push([item(paper("2610.00001"))]);
	const writtenBefore = written();
	const answer = await push([item(paper("2610.00001"))]);
	assert.deepEqual(answer.results, [
		{ id: "arxiv:2610.00001", outcome: "already there" },
	]);
	assert.equal(written(), writtenBefore);
});

test("a stored field holding null is not filled", async () => {
	const { sqlite, push } = site();
	await push([item(paper("2610.00001", { venue: null }))]);
	const answer = await push([item(paper("2610.00001", { venue: "NeurIPS" }))]);
	assert.deepEqual(answer.results, [
		{ id: "arxiv:2610.00001", outcome: "already there" },
	]);
	assert.equal(stored(sqlite, "arxiv:2610.00001").json.venue, null);
});

test("the same id twice in one push is stored once, and the second fills what the first lacked", async () => {
	const { sqlite, push } = site();
	const answer = await push([
		item(paper("2610.00001")),
		item(paper("2610.00001", { award: "Best paper" })),
	]);
	assert.deepEqual(
		answer.results.map((result) => result.outcome),
		["added", "filled"],
	);
	const count = sqlite.prepare("SELECT COUNT(*) AS n FROM entries").get();
	assert.equal(count?.n, 1);
	assert.equal(stored(sqlite, "arxiv:2610.00001").json.award, "Best paper");
});

test("an entry that fails the entry checks is refused with its id and problems, and the others are stored", async () => {
	const { sqlite, push } = site();
	const bad = paper("2610.00002", { title: undefined });
	const answer = await push([item(paper("2610.00001")), item(bad)]);
	assert.equal(answer.results[0]?.outcome, "added");
	const refused = answer.results[1];
	assert.equal(refused?.outcome, "refused");
	assert.equal(refused?.id, "arxiv:2610.00002");
	assert.ok(refused && "problems" in refused && refused.problems.length > 0);
	const rows = sqlite.prepare("SELECT id FROM entries").all();
	assert.deepEqual(
		rows.map((row) => row.id),
		["arxiv:2610.00001"],
	);
});

test("an item that isn't an object, or has a date that isn't a real day, is refused, and the others are stored", async () => {
	const { sqlite, push } = site();
	const answer = await push([
		"text" as unknown as Item,
		item(paper("2610.00001"), "2026-02-30"),
		item(paper("2610.00002")),
	]);
	assert.deepEqual(
		answer.results.map((result) => result.outcome),
		["refused", "refused", "added"],
	);
	const rows = sqlite.prepare("SELECT id FROM entries").all();
	assert.deepEqual(
		rows.map((row) => row.id),
		["arxiv:2610.00002"],
	);
});

test("security: a field named __proto__ is stored as a field and changes no object's prototype", async () => {
	const { sqlite, push } = site();
	await push([item(paper("2610.00001"))]);
	const hostile = JSON.parse(
		JSON.stringify(paper("2610.00001")).replace(
			/}$/,
			',"__proto__":{"polluted":true}}',
		),
	);
	const answer = await push([item(hostile)]);
	assert.deepEqual(answer.results, [
		{ id: "arxiv:2610.00001", outcome: "filled", fields: ["__proto__"] },
	]);
	assert.equal(({} as Record<string, unknown>).polluted, undefined);
	const entry = stored(sqlite, "arxiv:2610.00001").json;
	assert.equal(Object.hasOwn(entry, "__proto__"), true);
	assert.equal(entry.polluted, undefined);
});

test("two pushes at once that each fill a different field lose neither field", async () => {
	const { sqlite, push } = site();
	await push([item(paper("2610.00001"))]);
	await Promise.all([
		push([item(paper("2610.00001", { award: "Best paper" }))]),
		push([item(paper("2610.00001", { venue: "NeurIPS" }))]),
	]);
	const entry = stored(sqlite, "arxiv:2610.00001").json;
	assert.equal(entry.award, "Best paper");
	assert.equal(entry.venue, "NeurIPS");
});

test("two pushes at once of the same new entry store it once and report one added", async () => {
	const { sqlite, push } = site();
	const answers = await Promise.all([
		push([item(paper("2610.00001"))]),
		push([item(paper("2610.00001"))]),
	]);
	const count = sqlite.prepare("SELECT COUNT(*) AS n FROM entries").get();
	assert.equal(count?.n, 1);
	const outcomes = answers.map((answer) => answer.results[0]?.outcome).sort();
	assert.deepEqual(outcomes, ["added", "already there"]);
});

test("a push of 24 new entries runs within 50 database statements", async () => {
	const { push, statements } = site();
	const items = Array.from({ length: 24 }, (_, k) =>
		item(paper(`2610.${String(10000 + k)}`)),
	);
	const answer = await push(items);
	assert.equal(answer.results.length, 24);
	assert.ok(statements() <= 50, `${statements()} statements`);
});

// ---- the route's body ----

// POST /liminal-space/api/sync/push with this body, answered by the Worker's handler.
async function posted(env: unknown, body: BodyInit, chunked = false) {
	const log: Log = {
		method: "POST",
		path: "/liminal-space/api/sync/push",
		status: 0,
		queries: 0,
		rowsRead: 0,
		rowsWritten: 0,
	};
	const init: RequestInit & { duplex?: "half" } = {
		method: "POST",
		body: body,
	};
	if (chunked) {
		init.duplex = "half";
	}
	const answer = await pushing.answerPush(
		new Request("https://ivan.wiryadi.com/liminal-space/api/sync/push", init),
		env,
		{},
		log,
	);
	return { status: answer.status, text: await answer.text(), log: log };
}

test("security: a push of 24 entries is taken and 25 is refused with 413, and nothing of the 25 is stored", async () => {
	const { sqlite, env } = site();
	const entries = (count: number) =>
		Array.from({ length: count }, (_, k) =>
			item(paper(`2610.${String(10000 + k)}`)),
		);
	const taken = await posted(env, JSON.stringify({ entries: entries(24) }));
	assert.equal(taken.status, 200);
	const refused = await posted(env, JSON.stringify({ entries: entries(25) }));
	assert.equal(refused.status, 413);
	const count = sqlite.prepare("SELECT COUNT(*) AS n FROM entries").get();
	assert.equal(count?.n, 24);
});

// The bytes of a JSON body of exactly `size` bytes with an empty entries list, sent in 64 KB chunks and no
// Content-Length.
function chunkedBody(size: number): ReadableStream<Uint8Array> {
	const prefix = '{"entries":[],"pad":"';
	const text = `${prefix}${"x".repeat(size - prefix.length - 2)}"}`;
	const bytes = new TextEncoder().encode(text);
	assert.equal(bytes.length, size);
	let offset = 0;
	return new ReadableStream({
		pull(controller) {
			if (offset >= bytes.length) {
				controller.close();
				return;
			}
			controller.enqueue(bytes.slice(offset, offset + 65_536));
			offset += 65_536;
		},
	});
}

test("security: a body sent in chunks with no Content-Length is counted as it arrives: 1,000,000 bytes are taken, 1,000,001 refused", async () => {
	const { env } = site();
	const atLimit = await posted(env, chunkedBody(1_000_000), true);
	assert.equal(atLimit.status, 200);
	const over = await posted(env, chunkedBody(1_000_001), true);
	assert.equal(over.status, 413);
});

test("a pushed entry with a field over its cap is refused", async () => {
	const { sqlite, push } = site();
	const answer = await push([
		item(paper("2610.00001", { title: "x".repeat(FIELD_CAPS.title) })),
		item(paper("2610.00002", { title: "x".repeat(FIELD_CAPS.title + 1) })),
		item(
			paper("2610.00003", { abstract: "x".repeat(FIELD_CAPS.abstract + 1) }),
		),
	]);
	assert.deepEqual(
		answer.results.map((result) => result.outcome),
		["added", "refused", "refused"],
	);
	const [, longTitle, longAbstract] = answer.results;
	assert.ok(longTitle && "problems" in longTitle);
	assert.match(longTitle.problems.join("; "), /title is over/);
	assert.ok(longAbstract && "problems" in longAbstract);
	assert.match(longAbstract.problems.join("; "), /abstract is over/);
	const count = sqlite.prepare("SELECT COUNT(*) AS n FROM entries").get();
	assert.equal(count?.n, 1);
});
