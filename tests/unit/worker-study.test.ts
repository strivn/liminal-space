// What the Worker's study route stores (worker/src/study.ts): a study replaces the entry's earlier one, a study that
// doesn't fit its stored entry is refused, and the route's token and size checks, run on the real code over a SQLite
// database with the real migrations.
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, test } from "vitest";
import type { JsonObject } from "../../shared/narrow.ts";
import {
	MAX_STUDY_BYTES,
	type Study,
	type StudyAnswer,
	type StudyWord,
} from "../../shared/study-protocol.ts";
import {
	type Access,
	loadWorker,
	migratedDatabase,
	ownerRequest,
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
type StudyModule = {
	answerStudyPush(
		request: Request,
		env: unknown,
		ctx: unknown,
		log: Log,
	): Promise<Response>;
};

const STUDY_URL = "https://ivan.wiryadi.com/liminal-space/api/sync/study";
const ENTRY_ID = "url:http://www.geekpark.net/news/374282";

let route: StudyModule;
let access: Access;

beforeAll(async () => {
	route = await workerModule<StudyModule>("study.ts");
	access = await startAccess();
});

afterAll(async () => {
	await access.close();
});

function word(text: string, syllables: string[], meaning: string): StudyWord {
	return {
		text: text,
		syllables: syllables,
		meaning: meaning,
		meaningFrom: "dictionary",
		name: false,
		inDictionary: true,
		pinyinChecked: true,
	};
}

const ENTRY: JsonObject = {
	id: ENTRY_ID,
	type: "news",
	title: "苹果发布新手机",
	description: "了解更多。",
};

// A study of ENTRY whose first title word has this meaning.
function studyOf(firstMeaning = "apple"): Study {
	return {
		id: ENTRY_ID,
		title: [
			word("苹果", ["píng", "guǒ"], firstMeaning),
			word("发布", ["fā", "bù"], "to release"),
			word("新", ["xīn"], "new"),
			word("手机", ["shǒu", "jī"], "mobile phone"),
		],
		description: [
			word("了解", ["liǎo", "jiě"], "to understand"),
			word("更多", ["gèng", "duō"], "more"),
			{ text: "。" },
		],
	};
}

// A migrated database holding ENTRY, and the Worker's D1 over it.
function site() {
	const sqlite = migratedDatabase();
	sqlite
		.prepare(
			"INSERT INTO entries (id, date, seq, json, updated) VALUES (?, ?, 1, ?, ?)",
		)
		.run(ENTRY_ID, "2026-11-21", JSON.stringify(ENTRY), "2026-11-21T00:00:00Z");
	return { sqlite: sqlite, env: workerEnv(access, sqlite) };
}

function send(env: unknown, body: BodyInit): Promise<Response> {
	const log: Log = {
		method: "POST",
		path: "/liminal-space/api/sync/study",
		status: 0,
		queries: 0,
		rowsRead: 0,
		rowsWritten: 0,
	};
	const request = new Request(STUDY_URL, { method: "POST", body: body });
	return route.answerStudyPush(request, env, {}, log);
}

async function posted(env: unknown, body: BodyInit) {
	const response = await send(env, body);
	return {
		status: response.status,
		answer: (await response.json()) as StudyAnswer,
	};
}

function stored(sqlite: DatabaseSync) {
	return sqlite.prepare("SELECT id, json, updated FROM study").all();
}

test("a study the Worker accepts replaces the entry's earlier study", async () => {
	const { sqlite, env } = site();
	const first = await posted(env, JSON.stringify({ study: studyOf("apple") }));
	assert.deepEqual(first.answer, { id: ENTRY_ID, outcome: "stored" });
	const second = await posted(
		env,
		JSON.stringify({ study: studyOf("Apple Inc.") }),
	);
	assert.deepEqual(second.answer, { id: ENTRY_ID, outcome: "stored" });
	const rows = stored(sqlite);
	assert.equal(rows.length, 1);
	assert.deepEqual(JSON.parse(String(rows[0]?.json)), studyOf("Apple Inc."));
});

test("a study for an entry the database does not hold is refused", async () => {
	const { sqlite, env } = site();
	const other = { ...studyOf(), id: "url:http://www.geekpark.net/news/1" };
	const { status, answer } = await posted(
		env,
		JSON.stringify({ study: other }),
	);
	assert.equal(status, 200);
	assert.equal(answer.outcome, "refused");
	assert.deepEqual(stored(sqlite), []);
});

test("a study whose words do not join back into the stored entry's text is refused", async () => {
	const { sqlite, env } = site();
	await posted(env, JSON.stringify({ study: studyOf("apple") }));
	const broken = studyOf();
	broken.title = broken.title.slice(0, 2);
	const { answer } = await posted(env, JSON.stringify({ study: broken }));
	assert.equal(answer.outcome, "refused");
	assert.ok(
		answer.outcome === "refused" &&
			answer.problems.some((problem) => problem.includes("do not join")),
	);
	const rows = stored(sqlite);
	assert.equal(rows.length, 1);
	assert.deepEqual(JSON.parse(String(rows[0]?.json)), studyOf("apple"));
});

test("security: a study push without the sync service token is refused", async () => {
	const { sqlite, env } = site();
	const worker = await loadWorker();
	const body = JSON.stringify({ study: studyOf() });
	const noToken = new Request(STUDY_URL, { method: "POST", body: body });
	const ownerToken = await ownerRequest(access, new URL(STUDY_URL).pathname, {
		body: body,
	});
	for (const request of [noToken, ownerToken]) {
		const answer = await worker.fetch(request, env);
		assert.equal(answer.status, 403);
	}
	assert.deepEqual(stored(sqlite), []);
});

test("security: a study push over 200,000 bytes is refused with 413", async () => {
	const { sqlite, env } = site();
	const padded = (size: number) =>
		JSON.stringify({ pad: "x".repeat(size - '{"pad":""}'.length) });
	const atLimit = await send(env, padded(MAX_STUDY_BYTES));
	assert.equal(atLimit.status, 400);
	const over = await send(env, padded(MAX_STUDY_BYTES + 1));
	assert.equal(over.status, 413);
	assert.deepEqual(stored(sqlite), []);
});
