// How the site stores takeaways: edits, deletes, refusals and the rows each change reads, run against the Worker's own
// code and a local D1, and its answers over a SQLite stand-in for D1.
import assert from "node:assert/strict";
import { afterAll, beforeAll, beforeEach, describe, test } from "vitest";
import { isJsonObject } from "../../shared/narrow.ts";
import {
	MAX_ID_LENGTH,
	OWNER_TEXT_CHARS,
} from "../../shared/owner-protocol.ts";
import {
	type Access,
	loadWorker,
	migratedDatabase,
	ownerRequest,
	startAccess,
	workerEnv,
} from "../fixtures/worker-in-node.ts";
import {
	type BodyProblem,
	type OwnerWorker,
	startOwnerWorker,
	workerModule,
} from "./owner-worker.ts";

const ENTRY = "arxiv:2610.00001";
const OTHER = "arxiv:2610.00002";
const CREATED = "2026-09-27T15:00:00.000Z";
const PAGE_CREATED = "2026-09-27T16:20:00.000Z";
const PAGE_EDITED = "2026-09-27T16:25:00.000Z";

type Cost = { rowsRead: number; rowsWritten: number };
type Change =
	| { entryId: string; save: Record<string, unknown> }
	| { entryId: string; delete: string };
type Checks = { takeawayChangeOf(body: unknown): Change };
type Store = {
	saveTakeaway(
		db: unknown,
		change: Change,
		count: (cost: Cost) => void,
	): Promise<void>;
	proposeTakeaway(
		db: unknown,
		entryId: string,
		text: string,
		question: string,
		source: "claude.ai" | "ChatGPT",
		count: (cost: Cost) => void,
	): Promise<string | null>;
};
type Respond = { BodyProblem: new (message: string) => BodyProblem };

let worker: OwnerWorker;
let checks: Checks;
let store: Store;
let respond: Respond;
let access: Access;

beforeAll(async () => {
	worker = await startOwnerWorker();
	checks = await workerModule<Checks>("owner/checks.ts");
	store = await workerModule<Store>("owner/store.ts");
	respond = await workerModule<Respond>("respond.ts");
	access = await startAccess();
});
afterAll(async () => {
	await worker.stop();
	await access.close();
});
beforeEach(async () => {
	await worker.db.batch([
		worker.db.prepare("DELETE FROM takeaways"),
		worker.db.prepare("DELETE FROM entries"),
	]);
});

// A takeaway as the page saves it, apart from what a test changes.
function pageSave(
	id: string,
	text: string,
	extra: Record<string, unknown> = {},
) {
	return {
		id: id,
		text: text,
		question: null,
		created: PAGE_CREATED,
		edited: PAGE_EDITED,
		...extra,
	};
}

// A takeaway row the connector saved from claude.ai at CREATED.
async function storeTakeaway(
	id: string,
	entryId: string,
	text: string,
	source = "claude.ai",
) {
	await worker.db
		.prepare(
			"INSERT INTO takeaways (id, entry_id, takeaway, recall_question, created, edited, source) VALUES (?1, ?2, ?3, NULL, ?4, NULL, ?5)",
		)
		.bind(id, entryId, text, CREATED, source)
		.run();
}

async function rowsOf(entryId: string) {
	const answer = await worker.db
		.prepare(
			"SELECT id, takeaway, recall_question, created, edited, source FROM takeaways WHERE entry_id = ?1 ORDER BY id",
		)
		.bind(entryId)
		.all();
	return answer.results.filter(isJsonObject);
}

// The refusal the Worker's check throws for `body`, or a failure when it takes the body.
function refusalOf(body: unknown): BodyProblem {
	try {
		checks.takeawayChangeOf(body);
	} catch (error) {
		assert.ok(
			error instanceof respond.BodyProblem,
			`a refusal, not ${String(error)}`,
		);
		return error;
	}
	throw new Error("the check took the body");
}

const ignore = () => {};

describe("an edit changes the words, never where the takeaway came from", () => {
	test("an edit keeps the takeaway's entry, time and source, and sets its edited time", async () => {
		await storeTakeaway("k1", ENTRY, "Monitorability is fragile");
		await store.saveTakeaway(
			worker.db,
			checks.takeawayChangeOf({
				entryId: ENTRY,
				save: pageSave("k1", "Monitorability is fragile under training"),
			}),
			ignore,
		);
		assert.deepEqual(await rowsOf(ENTRY), [
			{
				id: "k1",
				takeaway: "Monitorability is fragile under training",
				recall_question: null,
				created: CREATED,
				edited: PAGE_EDITED,
				source: "claude.ai",
			},
		]);
		assert.deepEqual(await rowsOf(OTHER), []);
	});

	test("an edit naming another entry is refused with 400 and changes nothing", async () => {
		await storeTakeaway("k1", ENTRY, "Monitorability is fragile");
		await assert.rejects(
			store.saveTakeaway(
				worker.db,
				checks.takeawayChangeOf({
					entryId: OTHER,
					save: pageSave("k1", "Overwritten from another entry"),
				}),
				ignore,
			),
			(error: unknown) => {
				assert.ok(error instanceof respond.BodyProblem);
				assert.equal((error as BodyProblem).status, 400);
				assert.equal(error.message, "the takeaway belongs to another entry");
				return true;
			},
		);
		const [row] = await rowsOf(ENTRY);
		assert.equal(row?.takeaway, "Monitorability is fragile");
		assert.equal(row?.edited, null);
		assert.deepEqual(await rowsOf(OTHER), []);
	});

	test('a new takeaway from the page is stored with "page" as its source and the time the page gave', async () => {
		await store.saveTakeaway(
			worker.db,
			checks.takeawayChangeOf({
				entryId: ENTRY,
				save: pageSave("k2", "Mine", { edited: null }),
			}),
			ignore,
		);
		const [row] = await rowsOf(ENTRY);
		assert.equal(row?.source, "page");
		assert.equal(row?.created, PAGE_CREATED);
	});
});

describe("a delete reaches only its own entry's takeaway", () => {
	test("a delete naming another entry deletes nothing", async () => {
		await storeTakeaway("k1", ENTRY, "Monitorability is fragile");
		await store.saveTakeaway(
			worker.db,
			checks.takeawayChangeOf({ entryId: OTHER, delete: "k1" }),
			ignore,
		);
		assert.equal((await rowsOf(ENTRY)).length, 1);
	});

	test("a delete naming its own entry removes the takeaway", async () => {
		await storeTakeaway("k1", ENTRY, "Monitorability is fragile");
		await store.saveTakeaway(
			worker.db,
			checks.takeawayChangeOf({ entryId: ENTRY, delete: "k1" }),
			ignore,
		);
		assert.deepEqual(await rowsOf(ENTRY), []);
	});
});

describe("a takeaway change reads only the rows it touches", () => {
	// 2,000 takeaways on 2,000 other entries, from one statement.
	async function fillTakeaways() {
		await worker.db
			.prepare(
				"WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 1999) " +
					"INSERT INTO takeaways (id, entry_id, takeaway, recall_question, created, edited, source) " +
					"SELECT 'filler-' || i, 'arxiv:2000.' || printf('%05d', i), 'filler', NULL, ?1, NULL, 'page' FROM n",
			)
			.bind(CREATED)
			.run();
	}

	const changes: [string, () => Change][] = [
		[
			"adds a takeaway",
			() => ({
				entryId: ENTRY,
				save: pageSave("new-one", "New", { edited: null }),
			}),
		],
		[
			"edits one of the takeaways",
			() => ({
				entryId: "arxiv:2000.00007",
				save: pageSave("filler-7", "Edited"),
			}),
		],
		[
			"deletes one of the takeaways",
			() => ({ entryId: "arxiv:2000.00008", delete: "filler-8" }),
		],
	];
	for (const [name, build] of changes) {
		test(`a page that ${name} reads at most 5 database rows among 2,000 takeaways`, async () => {
			await fillTakeaways();
			let rowsRead = 0;
			await store.saveTakeaway(
				worker.db,
				checks.takeawayChangeOf(build()),
				(cost) => {
					rowsRead += cost.rowsRead;
				},
			);
			assert.ok(rowsRead <= 5, `read ${rowsRead} rows`);
		});
	}

	test("propose_takeaway among 300 entries and 2,000 takeaways reads at most 5 rows in at most 2 queries", async () => {
		await fillTakeaways();
		await worker.db
			.prepare(
				"WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 299) " +
					"INSERT INTO entries (id, date, seq, json, updated) " +
					"SELECT 'arxiv:2610.' || printf('%05d', i), '2026-09-' || printf('%02d', i % 30 + 1), i + 1, " +
					"json_object('id', 'arxiv:2610.' || printf('%05d', i), 'title', 'Title ' || i), ?1 FROM n",
			)
			.bind(CREATED)
			.run();
		let rowsRead = 0;
		let queries = 0;
		const title = await store.proposeTakeaway(
			worker.db,
			"arxiv:2610.00150",
			"Monitorability is fragile",
			"Why?",
			"claude.ai",
			(cost) => {
				rowsRead += cost.rowsRead;
				queries += 1;
			},
		);
		assert.equal(title, "Title 150");
		assert.ok(rowsRead <= 5, `read ${rowsRead} rows`);
		assert.ok(queries <= 2, `ran ${queries} queries`);
	});

	test("propose_takeaway for an id that no digest holds saves nothing and finds no entry", async () => {
		const title = await store.proposeTakeaway(
			worker.db,
			"arxiv:2601.99999",
			"A takeaway",
			"A question",
			"claude.ai",
			ignore,
		);
		assert.equal(title, null);
		assert.deepEqual(await rowsOf("arxiv:2601.99999"), []);
	});
});

describe("a takeaway change the Worker can't use is refused whole", () => {
	const GOOD = pageSave("k1", "A takeaway", { edited: null });
	const refused: [string, unknown][] = [
		[
			"a text of only spaces",
			{ entryId: ENTRY, save: { ...GOOD, text: "   " } },
		],
		["no id", { entryId: ENTRY, save: { ...GOOD, id: undefined } }],
		["both a save and a delete", { entryId: ENTRY, save: GOOD, delete: "k1" }],
		["neither a save nor a delete", { entryId: ENTRY }],
		[
			"a created time that isn't a UTC time",
			{ entryId: ENTRY, save: { ...GOOD, created: "yesterday" } },
		],
		[
			"a source, which is the site's to set",
			{ entryId: ENTRY, save: { ...GOOD, source: "claude.ai" } },
		],
		[
			"a question that isn't text",
			{ entryId: ENTRY, save: { ...GOOD, question: 7 } },
		],
		["no entry id", { save: GOOD }],
		[
			"an entry id longer than the limit",
			{ entryId: "x".repeat(MAX_ID_LENGTH + 1), save: GOOD },
		],
		[
			"a text longer than the limit",
			{
				entryId: ENTRY,
				save: { ...GOOD, text: "x".repeat(OWNER_TEXT_CHARS + 1) },
			},
		],
		[
			"a question longer than the limit",
			{
				entryId: ENTRY,
				save: { ...GOOD, question: "x".repeat(OWNER_TEXT_CHARS + 1) },
			},
		],
	];
	for (const [name, body] of refused) {
		test(`a takeaway change with ${name} is refused with 400`, () => {
			assert.equal(refusalOf(body).status, 400);
		});
	}

	test("security: a takeaway and a question of exactly 10,000 characters are taken, and an empty question is read as no question", () => {
		const taken = checks.takeawayChangeOf({
			entryId: ENTRY,
			save: { ...GOOD, text: "x".repeat(OWNER_TEXT_CHARS), question: "" },
		});
		assert.ok("save" in taken);
		assert.equal(taken.save.question, null);
	});
});

describe("the owner's takeaways route answers over HTTP", () => {
	const PATH = "/liminal-space/api/owner/takeaways";

	async function post(env: ReturnType<typeof workerEnv>, body: unknown) {
		const worker = await loadWorker();
		return worker.fetch(
			await ownerRequest(access, PATH, { body: JSON.stringify(body) }),
			env,
		);
	}

	test("an edit naming another entry answers 400 and says the takeaway belongs to another entry", async () => {
		const db = migratedDatabase();
		db.prepare(
			"INSERT INTO takeaways (id, entry_id, takeaway, recall_question, created, edited, source) VALUES ('k1', ?, 'Monitorability is fragile', NULL, ?, NULL, 'claude.ai')",
		).run(ENTRY, CREATED);
		const answer = await post(workerEnv(access, db), {
			entryId: OTHER,
			save: pageSave("k1", "Overwritten from another entry"),
		});
		assert.equal(answer.status, 400);
		assert.match(await answer.text(), /the takeaway belongs to another entry/);
		assert.equal(
			db.prepare("SELECT takeaway FROM takeaways WHERE id = 'k1'").get()
				?.takeaway,
			"Monitorability is fragile",
		);
		assert.equal(
			db
				.prepare("SELECT count(*) AS n FROM takeaways WHERE entry_id = ?")
				.get(OTHER)?.n,
			0,
		);
	});

	test("a delete naming another entry answers 200 and deletes nothing", async () => {
		const db = migratedDatabase();
		db.prepare(
			"INSERT INTO takeaways (id, entry_id, takeaway, recall_question, created, edited, source) VALUES ('k1', ?, 'Monitorability is fragile', NULL, ?, NULL, 'claude.ai')",
		).run(ENTRY, CREATED);
		const answer = await post(workerEnv(access, db), {
			entryId: OTHER,
			delete: "k1",
		});
		assert.equal(answer.status, 200);
		assert.equal(db.prepare("SELECT count(*) AS n FROM takeaways").get()?.n, 1);
	});

	test("security: a request without the owner's sign-in saves nothing", async () => {
		const db = migratedDatabase();
		const worker = await loadWorker();
		const request = await ownerRequest(access, PATH, {
			email: null,
			body: JSON.stringify({
				entryId: ENTRY,
				save: pageSave("k1", "Sneaked in", { edited: null }),
			}),
		});
		const answer = await worker.fetch(request, workerEnv(access, db));
		assert.ok(
			answer.status === 401 || answer.status === 403,
			`status ${answer.status}`,
		);
		assert.equal(db.prepare("SELECT count(*) AS n FROM takeaways").get()?.n, 0);
	});

	test("a takeaway of only spaces answers 400 and saves nothing", async () => {
		const db = migratedDatabase();
		const answer = await post(workerEnv(access, db), {
			entryId: ENTRY,
			save: pageSave("k1", "   ", { edited: null }),
		});
		assert.equal(answer.status, 400);
		assert.equal(db.prepare("SELECT count(*) AS n FROM takeaways").get()?.n, 0);
	});
});

describe("propose_takeaway saves from a chat, and caps its text as the owner's route does", () => {
	// One JSON-RPC tools/call to the connector over a SQLite D1 holding the entry arxiv:2610.00001.
	async function propose(args: Record<string, unknown>) {
		const mcp = await workerModule<{
			answerMcp(
				request: Request,
				env: unknown,
				log: Record<string, unknown>,
				count: () => void,
			): Promise<Response>;
		}>("mcp.ts");
		const db = migratedDatabase();
		db.prepare(
			"INSERT INTO entries (id, date, seq, json, updated) VALUES (?, '2026-09-27', 1, ?, ?)",
		).run(ENTRY, JSON.stringify({ id: ENTRY, title: "A paper" }), CREATED);
		const log = {
			method: "POST",
			path: "/liminal-space/mcp",
			status: 0,
			queries: 0,
			rowsRead: 0,
			rowsWritten: 0,
		};
		const request = new Request("https://ivan.wiryadi.com/liminal-space/mcp", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "propose_takeaway",
					arguments: { id: ENTRY, app: "claude.ai", ...args },
				},
			}),
		});
		const answer = await mcp.answerMcp(
			request,
			workerEnv(access, db),
			log,
			ignore,
		);
		const body: {
			result?: { isError?: boolean; content?: { text: string }[] };
			error?: { code: number; message: string };
		} = await answer.json();
		const saved = db
			.prepare("SELECT takeaway, recall_question, source FROM takeaways")
			.all();
		return { body: body, saved: saved };
	}

	const LIMIT = OWNER_TEXT_CHARS;

	test("security: a takeaway and a question of exactly 10,000 characters are saved on the entry, with the app as the source", async () => {
		const { body, saved } = await propose({
			takeaway: "t".repeat(LIMIT),
			question: "q".repeat(LIMIT),
		});
		assert.match(
			body.result?.content?.[0]?.text ?? "",
			/^Saved the takeaway on "A paper"/,
		);
		assert.equal(saved.length, 1);
		assert.equal(saved[0]?.takeaway, "t".repeat(LIMIT));
		assert.equal(saved[0]?.recall_question, "q".repeat(LIMIT));
		assert.equal(saved[0]?.source, "claude.ai");
	});

	for (const [field, args] of [
		["a takeaway", { takeaway: "t".repeat(LIMIT + 1), question: "Why?" }],
		[
			"a recall question",
			{ takeaway: "A takeaway", question: "q".repeat(LIMIT + 1) },
		],
	] as const) {
		test(`security: ${field} of ${LIMIT + 1} characters is refused as invalid params, saying it is too long, and nothing is saved`, async () => {
			const { body, saved } = await propose(args);
			assert.equal(body.error?.code, -32602);
			assert.match(body.error?.message ?? "", /too long/);
			assert.deepEqual(saved, []);
		});
	}

	test("an empty takeaway and a missing question are refused, and nothing is saved", async () => {
		const empty = await propose({ takeaway: "   ", question: "Why?" });
		assert.equal(empty.body.result?.isError, true);
		assert.match(
			empty.body.result?.content?.[0]?.text ?? "",
			/The takeaway is empty/,
		);
		assert.deepEqual(empty.saved, []);
		const noQuestion = await propose({ takeaway: "A takeaway", question: "" });
		assert.equal(noQuestion.body.result?.isError, true);
		assert.match(
			noQuestion.body.result?.content?.[0]?.text ?? "",
			/The question is missing/,
		);
		assert.deepEqual(noQuestion.saved, []);
	});

	test("an app other than claude.ai or ChatGPT is refused", async () => {
		const { body, saved } = await propose({
			takeaway: "A takeaway",
			question: "Why?",
			app: "Bard",
		});
		assert.equal(body.error?.code, -32602);
		assert.deepEqual(saved, []);
	});
});
