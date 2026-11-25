// The owner's standouts: marking a paper that shaped their thinking, and its public note, through the owner API.
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, test } from "vitest";
import {
	OWNER_TEXT_CHARS,
	type OwnerState,
} from "../../shared/owner-protocol.ts";
import {
	type Access,
	loadWorker,
	migratedDatabase,
	type OwnerRequest,
	ownerRequest,
	startAccess,
	workerEnv,
} from "../fixtures/worker-in-node.ts";

const ENTRY = "arxiv:2610.00001";
const OTHER = "arxiv:2610.00002";
const STORED = "2026-09-27T15:00:00.000Z";
const PATH = "/liminal-space/api/owner/standouts";

let access: Access;

beforeAll(async () => {
	access = await startAccess();
});
afterAll(async () => {
	await access.close();
});

// A database holding two entries.
function databaseWithEntries(): DatabaseSync {
	const db = migratedDatabase();
	for (const [seq, id] of [ENTRY, OTHER].entries()) {
		db.prepare(
			"INSERT INTO entries (id, date, seq, json, updated) VALUES (?, '2026-09-27', ?, ?, ?)",
		).run(id, seq + 1, JSON.stringify({ id: id, title: "A paper" }), STORED);
	}
	return db;
}

// POST to the standouts route.
async function post(
	db: DatabaseSync,
	body: unknown,
	options: OwnerRequest = {},
) {
	const worker = await loadWorker();
	return worker.fetch(
		await ownerRequest(access, PATH, {
			body: JSON.stringify(body),
			...options,
		}),
		workerEnv(access, db),
	);
}

// The owner's state.
async function stateOf(db: DatabaseSync): Promise<OwnerState> {
	const worker = await loadWorker();
	const answer = await worker.fetch(
		await ownerRequest(access, "/liminal-space/api/owner/state", {
			method: "GET",
		}),
		workerEnv(access, db),
	);
	assert.equal(answer.status, 200);
	return await answer.json();
}

function mark(id: string, date = "2026-11-24") {
	return { id: id, marked: true, date: date };
}

test("A mark is saved with its day and read back in the owner's state", async () => {
	const db = databaseWithEntries();
	const answer = await post(db, mark(ENTRY));
	assert.equal(answer.status, 200);
	assert.deepEqual((await stateOf(db)).standouts, {
		[ENTRY]: { date: "2026-11-24", note: "" },
	});
});

test("Unmarking a paper clears its mark day and keeps it in the owner's state", async () => {
	const db = databaseWithEntries();
	await post(db, mark(ENTRY));
	const answer = await post(db, {
		id: ENTRY,
		marked: false,
		date: "2026-11-25",
	});
	assert.equal(answer.status, 200);
	assert.deepEqual((await stateOf(db)).standouts, {
		[ENTRY]: { date: null, note: "" },
	});
});

test("A note on a marked paper is saved and read back", async () => {
	const db = databaseWithEntries();
	await post(db, mark(ENTRY));
	const answer = await post(db, {
		id: ENTRY,
		note: "Changed how I read evals",
	});
	assert.equal(answer.status, 200);
	assert.deepEqual((await stateOf(db)).standouts, {
		[ENTRY]: { date: "2026-11-24", note: "Changed how I read evals" },
	});
});

test("Unmarking a paper keeps its note for when it is marked again", async () => {
	const db = databaseWithEntries();
	await post(db, mark(ENTRY));
	await post(db, { id: ENTRY, note: "Changed how I read evals" });
	await post(db, { id: ENTRY, marked: false, date: "2026-11-25" });
	assert.deepEqual((await stateOf(db)).standouts, {
		[ENTRY]: { date: null, note: "Changed how I read evals" },
	});
	await post(db, mark(ENTRY, "2026-11-26"));
	assert.deepEqual((await stateOf(db)).standouts, {
		[ENTRY]: { date: "2026-11-26", note: "Changed how I read evals" },
	});
});

test("A note on a paper that is not marked is refused", async () => {
	const db = databaseWithEntries();
	const neverMarked = await post(db, { id: ENTRY, note: "Not yet" });
	assert.equal(neverMarked.status, 400);
	assert.match(await neverMarked.text(), /the paper is not marked/);

	await post(db, mark(OTHER));
	await post(db, { id: OTHER, marked: false, date: "2026-11-25" });
	const unmarked = await post(db, { id: OTHER, note: "Not now" });
	assert.equal(unmarked.status, 400);
	assert.equal(
		db.prepare("SELECT count(*) AS n FROM standouts WHERE note != ''").get()?.n,
		0,
	);
});

test("A note longer than the owner's text limit is refused", async () => {
	const db = databaseWithEntries();
	await post(db, mark(ENTRY));
	const tooLong = await post(db, {
		id: ENTRY,
		note: "x".repeat(OWNER_TEXT_CHARS + 1),
	});
	assert.equal(tooLong.status, 400);
	assert.deepEqual((await stateOf(db)).standouts[ENTRY]?.note, "");
	const longest = await post(db, {
		id: ENTRY,
		note: "x".repeat(OWNER_TEXT_CHARS),
	});
	assert.equal(longest.status, 200);
});

test("A mark on an id that is not a stored entry is refused", async () => {
	const db = databaseWithEntries();
	const answer = await post(db, mark("arxiv:2601.99999"));
	assert.equal(answer.status, 400);
	assert.match(await answer.text(), /no stored entry has that id/);
	assert.equal(db.prepare("SELECT count(*) AS n FROM standouts").get()?.n, 0);
});

test("security: a standout change without the owner's sign-in, email, the site's Origin or X-Liminal is refused", async () => {
	const unsent: [string, OwnerRequest][] = [
		["the sign-in and email", { email: null }],
		["an email that is not the owner's", { email: "someone@example.com" }],
		["the site's Origin", { origin: null }],
		["another site's Origin", { origin: "https://evil.example" }],
		["the X-Liminal header", { liminal: null }],
	];
	for (const [name, options] of unsent) {
		const db = databaseWithEntries();
		const answer = await post(db, mark(ENTRY), options);
		assert.ok(
			answer.status === 401 || answer.status === 403,
			`${name}: status ${answer.status}`,
		);
		assert.equal(
			db.prepare("SELECT count(*) AS n FROM standouts").get()?.n,
			0,
			name,
		);
	}
});
