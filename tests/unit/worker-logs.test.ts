// How the Worker stores and lists the scout's run logs (worker/src/logs.ts), on the real code over a SQLite database with
// the real migrations.
import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "vitest";
import {
	type Access,
	migratedDatabase,
	startAccess,
	workerEnv,
} from "../fixtures/worker-in-node.ts";
import { ignoreCost, workerModule } from "./owner-worker.ts";

type Log = {
	method: string;
	path: string;
	status: number;
	reason?: string;
	queries: number;
	rowsRead: number;
	rowsWritten: number;
};
type Run = { id: string; date: string; log: string };
type LogsModule = {
	logOf(body: unknown): Run;
	saveLog(db: unknown, run: Run, count: typeof ignoreCost): Promise<void>;
	readLogs(
		db: unknown,
		count: typeof ignoreCost,
	): Promise<{ logs: (Run & { updated: string })[] }>;
	answerLogs(
		request: Request,
		env: unknown,
		ctx: unknown,
		log: Log,
	): Promise<Response>;
};

let logs: LogsModule;
let access: Access;

beforeAll(async () => {
	logs = await workerModule<LogsModule>("logs.ts");
	access = await startAccess();
});

afterAll(async () => {
	await access.close();
});

function site() {
	const sqlite = migratedDatabase();
	return { sqlite: sqlite, env: workerEnv(access, sqlite) };
}

// POST one body to the logs route as the sync step does.
async function post(env: unknown, body: unknown) {
	const log: Log = {
		method: "POST",
		path: "/liminal-space/api/sync/logs",
		status: 0,
		queries: 0,
		rowsRead: 0,
		rowsWritten: 0,
	};
	const answer = await logs.answerLogs(
		new Request("https://ivan.wiryadi.com/liminal-space/api/sync/logs", {
			method: "POST",
			body: JSON.stringify(body),
		}),
		env,
		{},
		log,
	);
	return { status: answer.status, text: await answer.text(), log: log };
}

const RUN = { id: "40591364970-1", date: "2026-10-28", log: "Scout run done" };

test("a run's log is stored, and the same run sent again replaces its log", async () => {
	const { sqlite, env } = site();
	assert.equal((await post(env, RUN)).status, 200);
	assert.equal(
		(await post(env, { ...RUN, log: "x".repeat(3000) })).status,
		200,
	);
	const rows = sqlite.prepare("SELECT id, date, log FROM scout_logs").all();
	assert.equal(rows.length, 1);
	assert.equal(rows[0]?.id, RUN.id);
	assert.equal(rows[0]?.date, RUN.date);
	assert.equal(String(rows[0]?.log).length, 3000);
});

test("security: a log of 65,536 bytes is stored and one of 65,537 bytes is refused with 413, saying why, and nothing is stored", async () => {
	const { sqlite, env } = site();
	const atLimit = await post(env, { ...RUN, log: "x".repeat(65_536) });
	assert.equal(atLimit.status, 200);
	const over = await post(env, { ...RUN, id: "2", log: "x".repeat(65_537) });
	assert.equal(over.status, 413);
	assert.match(over.text, /larger than 65536 bytes/);
	const count = sqlite.prepare("SELECT COUNT(*) AS n FROM scout_logs").get();
	assert.equal(count?.n, 1);
});

test("security: the log's size is counted in bytes, not characters", async () => {
	const { env } = site();
	// 21,846 three-byte characters are 65,538 bytes.
	const answer = await post(env, { ...RUN, log: "€".repeat(21_846) });
	assert.equal(answer.status, 413);
});

test("a body the Worker can't read as a run is refused with 400 and stores nothing", async () => {
	const { sqlite, env } = site();
	const bodies: Record<string, unknown> = {
		"not an object": [RUN],
		"an id with a slash": { ...RUN, id: "4059/1" },
		"an empty id": { ...RUN, id: "" },
		"an id of 65 characters": { ...RUN, id: "a".repeat(65) },
		"a date that isn't a day": { ...RUN, date: "2026-02-30" },
		"a date written another way": { ...RUN, date: "28 October 2026" },
		"a log that isn't text": { ...RUN, log: 5 },
	};
	for (const [name, body] of Object.entries(bodies)) {
		const answer = await post(env, body);
		assert.equal(answer.status, 400, name);
	}
	const count = sqlite.prepare("SELECT COUNT(*) AS n FROM scout_logs").get();
	assert.equal(count?.n, 0);
});

test("security: a run id of 64 characters is accepted", () => {
	assert.doesNotThrow(() => logs.logOf({ ...RUN, id: "a".repeat(64) }));
});

test("storing a log removes the logs dated more than 30 days before it", async () => {
	const { sqlite, env } = site();
	await post(env, { ...RUN, id: "old", date: "2026-09-20" });
	await post(env, { ...RUN, id: "edge", date: "2026-09-28" });
	await post(env, { ...RUN, id: "kept", date: "2026-09-29" });
	await post(env, RUN);
	const ids = sqlite
		.prepare("SELECT id FROM scout_logs ORDER BY date")
		.all()
		.map((row) => row.id);
	assert.deepEqual(ids, ["edge", "kept", RUN.id]);
});

test("the stored runs are listed newest date first, and runs on the same date with the last stored first", async () => {
	const { env } = site();
	await post(env, { ...RUN, id: "a", date: "2026-10-27" });
	await post(env, { ...RUN, id: "b", date: "2026-10-28" });
	await post(env, { ...RUN, id: "c", date: "2026-10-28" });
	const listed = await logs.readLogs(env.DB, ignoreCost);
	assert.deepEqual(
		listed.logs.map((run) => run.id),
		["c", "b", "a"],
	);
	assert.equal(listed.logs[0]?.log, RUN.log);
});
