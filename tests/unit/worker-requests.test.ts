// What add.yml reads and reports through the Worker's sync routes for add requests (worker/src/requests.ts), on the real
// code over a SQLite database with the real migrations.
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, test } from "vitest";
import {
	type Access,
	migratedDatabase,
	startAccess,
	workerEnv,
} from "../fixtures/worker-in-node.ts";
import { workerModule } from "./owner-worker.ts";

type Log = {
	method: string;
	path: string;
	status: number;
	reason?: string;
	queries: number;
	rowsRead: number;
	rowsWritten: number;
};
type RequestsModule = {
	answerQueued(
		request: Request,
		env: unknown,
		ctx: unknown,
		log: Log,
	): Promise<Response>;
	answerRequestUpdate(
		request: Request,
		env: unknown,
		ctx: unknown,
		log: Log,
	): Promise<Response>;
};

let requests: RequestsModule;
let access: Access;

beforeAll(async () => {
	requests = await workerModule<RequestsModule>("requests.ts");
	access = await startAccess();
});

afterAll(async () => {
	await access.close();
});

function site() {
	const sqlite = migratedDatabase();
	return { sqlite: sqlite, env: workerEnv(access, sqlite) };
}

function emptyLog(): Log {
	return {
		method: "GET",
		path: "/liminal-space/api/sync/requests",
		status: 0,
		queries: 0,
		rowsRead: 0,
		rowsWritten: 0,
	};
}

function insert(
	sqlite: DatabaseSync,
	id: string,
	status: string,
	created: string,
) {
	sqlite
		.prepare(
			"INSERT INTO add_requests (id, kind, payload, status, created) VALUES (?, 'papers', ?, ?, ?)",
		)
		.run(id, JSON.stringify({ papers: ["2507.11473"] }), status, created);
}

// What add.yml's report to the route does: the answer's status and text.
async function report(env: unknown, body: unknown) {
	const log = emptyLog();
	const answer = await requests.answerRequestUpdate(
		new Request("https://ivan.wiryadi.com/liminal-space/api/sync/requests", {
			method: "POST",
			body: JSON.stringify(body),
		}),
		env,
		{},
		log,
	);
	return { status: answer.status, text: await answer.text() };
}

test("the list add.yml reads holds the queued and running requests, oldest first, and leaves out finished ones", async () => {
	const { sqlite, env } = site();
	insert(sqlite, "newer", "queued", "2026-10-28T02:00:00.000Z");
	insert(sqlite, "done", "done", "2026-10-28T00:30:00.000Z");
	insert(sqlite, "older", "queued", "2026-10-28T01:00:00.000Z");
	insert(sqlite, "left-running", "running", "2026-10-28T00:10:00.000Z");
	insert(sqlite, "failed", "failed", "2026-10-28T00:40:00.000Z");
	const answer = await requests.answerQueued(
		new Request("https://ivan.wiryadi.com/liminal-space/api/sync/requests"),
		env,
		{},
		emptyLog(),
	);
	const listed: { requests: { id: string }[] } = await answer.json();
	assert.deepEqual(
		listed.requests.map((request) => request.id),
		["left-running", "older", "newer"],
	);
});

test("add.yml marks a request running, then done with what happened to each id", async () => {
	const { sqlite, env } = site();
	insert(sqlite, "r1", "queued", "2026-10-28T01:00:00.000Z");
	assert.equal(
		(await report(env, { id: "r1", status: "running" })).status,
		200,
	);
	const running = sqlite.prepare("SELECT status FROM add_requests").get();
	assert.equal(running?.status, "running");
	const result = {
		items: [
			{ id: "2507.11473", outcome: "already there" },
			{ id: "2610.00001", outcome: "failed", reason: "arXiv doesn't know it" },
		],
	};
	assert.equal(
		(await report(env, { id: "r1", status: "done", result: result })).status,
		200,
	);
	const row = sqlite
		.prepare("SELECT status, finished, result FROM add_requests")
		.get();
	assert.equal(row?.status, "done");
	assert.ok(row?.finished, "the finishing time is kept");
	assert.deepEqual(JSON.parse(String(row?.result)), result);
});

test("a report for a request the database doesn't hold is refused with 404", async () => {
	const { env } = site();
	const answer = await report(env, { id: "nope", status: "running" });
	assert.equal(answer.status, 404);
	assert.equal(answer.text, "no such request");
});

test("a report with a missing id, an unknown status or a malformed result is refused with 400 naming the problem, and changes nothing", async () => {
	const { sqlite, env } = site();
	insert(sqlite, "r1", "queued", "2026-10-28T01:00:00.000Z");
	const bad: Record<string, [unknown, string]> = {
		"a body that isn't an object": [["r1"], "body is not an object"],
		"no id": [{ status: "running" }, "id must be a request id"],
		"a status that isn't one": [
			{ id: "r1", status: "paused" },
			'status must be "running", "done" or "failed"',
		],
		"a result without its items": [
			{ id: "r1", status: "done", result: {} },
			'result must hold a list of "items"',
		],
		"an outcome that isn't one": [
			{
				id: "r1",
				status: "done",
				result: { items: [{ id: "x", outcome: "maybe" }] },
			},
			'a result item\'s outcome must be "added", "already there" or "failed"',
		],
		"a reason that isn't text": [
			{
				id: "r1",
				status: "done",
				result: {
					items: [{ id: "x", outcome: "failed", reason: 5 }],
				},
			},
			"a result item's reason must be text",
		],
	};
	for (const [name, [body, reason]] of Object.entries(bad)) {
		const answer = await report(env, body);
		assert.equal(answer.status, 400, name);
		assert.equal(answer.text, reason, name);
	}
	const row = sqlite.prepare("SELECT status, result FROM add_requests").get();
	assert.equal(row?.status, "queued");
	assert.equal(row?.result, null);
});
