// The ask route and Claude's request: what holds that the reader can't see. Every test
// talks to a stand-in for Anthropic's API; none reaches api.anthropic.com.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, test, vi } from "vitest";
import type { JsonObject } from "../../shared/narrow.ts";
import { isJsonObject } from "../../shared/narrow.ts";
import type { PageComment } from "../../shared/owner-protocol.ts";
import {
	type AnthropicAnswer,
	type AnthropicBlock,
	type AnthropicTurn,
	browserHeaders,
	type D1,
	makeGate,
	sendToWorker,
	startCloud,
	startWorker,
	stopCloud,
} from "../support/cloud.ts";
import {
	ASK_PATH,
	COMMENTS_PATH,
	openAsk,
	ownerHeaders,
	ownerToken,
	postToSite,
	readSiteState,
} from "../support/owner.ts";
import {
	emptyComments,
	ignoreCost,
	type OwnerWorker,
	startOwnerWorker,
	startWorkerBefore,
} from "./owner-worker.ts";

const ROOT = path.join(import.meta.dirname, "..", "..");
const run = promisify(execFile);

const ENTRY = "arxiv:2601.00001";
const CREATED = "2026-11-05T01:00:00.000Z";
const PASSAGE = "steering vectors fail";
const PAPER: JsonObject = {
	id: ENTRY,
	type: "paper",
	title: "Steering vectors fail when concepts are spread out",
	authors: ["Yann LeCun", "Geoffrey Hinton"],
	published: "2026-01-02",
	source: "arXiv Machine Learning",
	url: "https://arxiv.org/abs/2601.00001",
	venue: "ICML 2026",
	links: [{ label: "PDF", url: "https://arxiv.org/pdf/2601.00001" }],
	abstract: `We show that ${PASSAGE} when a concept is spread over many directions.`,
};
// A paper from proceedings: no arXiv id, its own PDF link.
const PROCEEDINGS_ENTRY = "url:https://aclanthology.org/2026.acl-long.99/";
const PROCEEDINGS_PAPER: JsonObject = {
	id: PROCEEDINGS_ENTRY,
	type: "paper",
	title: "Probing without arXiv",
	authors: ["Yoshua Bengio"],
	published: "2026-07-01",
	source: "ACL Anthology",
	url: "https://aclanthology.org/2026.acl-long.99/",
	links: [
		{ label: "PDF", url: "https://aclanthology.org/2026.acl-long.99.pdf" },
	],
	abstract: "A probe that needs no arXiv copy.",
};
const QUESTION = "@Claude what does this mean?";

let worker: OwnerWorker;

// The comments a test seeds: who wrote each, in the order they were saved.
type Seed = {
	id: string;
	text: string;
	author: "owner" | "claude";
	created?: string;
};

// Put an entry into the site's entries table.
async function seedEntry(
	db: D1,
	entry: JsonObject,
	seq: number,
): Promise<void> {
	await db
		.prepare(
			"INSERT INTO entries (id, date, seq, json, updated) VALUES (?1, ?2, ?3, ?4, ?5)",
		)
		.bind(entry.id, "2026-01-02", seq, JSON.stringify(entry), CREATED)
		.run();
}

// Put a thread and its comments into the database as they would be after the owner commented and Claude answered.
async function seedThread(
	db: D1,
	threadId: string,
	comments: Seed[],
	entryId: string = ENTRY,
	place: { field: string | null; passage: string | null } = {
		field: "abstract",
		passage: PASSAGE,
	},
): Promise<void> {
	const statements = [
		db
			.prepare(
				"INSERT INTO threads (id, entry_id, field, passage, occurrence, created) VALUES (?1, ?2, ?3, ?4, 1, ?5)",
			)
			.bind(threadId, entryId, place.field, place.passage, CREATED),
	];
	for (const comment of comments) {
		statements.push(
			db
				.prepare(
					"INSERT INTO comments (id, thread_id, text, created, edited, author) VALUES (?1, ?2, ?3, ?4, NULL, ?5)",
				)
				.bind(
					`${threadId}:${comment.id}`,
					threadId,
					comment.text,
					comment.created || CREATED,
					comment.author,
				),
		);
	}
	await db.batch(statements);
}

// A thread whose last comment is the owner's question to Claude.
async function seedQuestion(threadId: string): Promise<void> {
	await seedThread(worker.db, threadId, [
		{ id: `${threadId}-q`, text: QUESTION, author: "owner" },
	]);
}

type Stored = { id: string; text: string; author: string; created: string };

// The comments of a thread, in the order they were saved.
async function storedComments(
	threadId: string,
	db: D1 = worker.db,
): Promise<Stored[]> {
	const answer = await db
		.prepare(
			"SELECT id, text, author, created FROM comments WHERE thread_id = ?1 ORDER BY rowid",
		)
		.bind(threadId)
		.all();
	return answer.results.map((row) => {
		const stored = object(row);
		return {
			id: String(stored.id),
			text: String(stored.text),
			author: String(stored.author),
			created: String(stored.created),
		};
	});
}

// A value that must be a JSON object.
function object(value: unknown): JsonObject {
	if (!isJsonObject(value)) {
		throw new Error(`not an object: ${JSON.stringify(value)}`);
	}
	return value;
}

// Ask Claude about a thread through the route, with the page's headers; `extra` is whatever else a page might send.
function ask(
	threadId: string,
	extra: JsonObject = {},
	entryId: string = ENTRY,
) {
	return postToSite(worker.cloud, ASK_PATH, {
		entryId: entryId,
		threadId: threadId,
		...extra,
	});
}

// Set what the stand-in for Anthropic's API answers next.
function standIn(answer: AnthropicAnswer): void {
	worker.cloud.anthropicAnswer = answer;
}

// The JSON bodies the Worker sent the stand-in for Anthropic's API since the test began.
function sentBodies(): JsonObject[] {
	return worker.cloud.anthropicRequests.map((sent) => object(sent.body));
}

// The one request Claude was sent, which fails when there were none or several.
function sentBody(): JsonObject {
	const [only, ...more] = sentBodies();
	assert.ok(only !== undefined, "Claude was not asked");
	assert.equal(more.length, 0, "Claude was asked more than once");
	return only;
}

// The question's text: the one user message the request holds.
function questionText(body: JsonObject): string {
	assert.ok(Array.isArray(body.messages));
	const message = object(body.messages[0]);
	assert.equal(message.role, "user");
	assert.equal(typeof message.content, "string");
	return String(message.content);
}

// The tool of that name the request gives Claude; the request gives exactly web search and web fetch.
function toolNamed(
	body: JsonObject,
	name: "web_search" | "web_fetch",
): JsonObject {
	assert.ok(Array.isArray(body.tools));
	assert.deepEqual(body.tools.map((tool) => object(tool).name).sort(), [
		"web_fetch",
		"web_search",
	]);
	const found = body.tools.map(object).find((tool) => tool.name === name);
	assert.ok(found !== undefined);
	return found;
}

// The text of a streamed answer, read to its end.
async function readAll(response: Response): Promise<string> {
	return response.text();
}

beforeAll(async () => {
	worker = await startOwnerWorker();
	await seedEntry(worker.db, PAPER, 1);
	await seedEntry(worker.db, PROCEEDINGS_PAPER, 2);
});
afterAll(async () => {
	await worker.stop();
});
// One Worker and its D1 for the file; each test starts from an empty site and a stand-in that answers one reply.
beforeEach(async () => {
	await emptyComments(worker.db);
	worker.cloud.anthropicRequests.length = 0;
	standIn({ kind: "text", pieces: ["The stand-in's reply."], gate: null });
});

// A comment as the page sends it.
function commentBody(id: string): PageComment {
	return { id: id, text: `text of ${id}`, created: CREATED, edited: null };
}

describe("who can ask", () => {
	test("security: only a signed-in owner request with the site's Origin and X-Liminal header can ask Claude", async () => {
		await seedQuestion("t1");
		const cloud = worker.cloud;
		const body = JSON.stringify({ entryId: ENTRY, threadId: "t1" });
		const good = await ownerHeaders(cloud);
		const withoutLogin = { ...good };
		delete withoutLogin["Cf-Access-Jwt-Assertion"];
		delete withoutLogin.Cookie;
		const withoutHeader = { ...good };
		delete withoutHeader["X-Liminal"];
		const refused = {
			"a request with no login": withoutLogin,
			"someone else's login": {
				...good,
				...browserHeaders(await ownerToken(cloud, "someone@example.com")),
			},
			"a request with no X-Liminal header": withoutHeader,
			"a request from another site": { ...good, Origin: "https://example.org" },
		};
		for (const [what, headers] of Object.entries(refused)) {
			const answer = await sendToWorker(cloud, "POST", ASK_PATH, headers, body);
			assert.equal(answer.status, 403, what);
		}
		const read = await sendToWorker(cloud, "GET", ASK_PATH, good, null);
		assert.equal(read.status, 405);
		assert.equal(cloud.anthropicRequests.length, 0, "Claude was asked");
		assert.equal((await storedComments("t1")).length, 1);

		const allowed = await sendToWorker(cloud, "POST", ASK_PATH, good, body);
		assert.equal(allowed.status, 200, allowed.body);
		assert.equal(cloud.anthropicRequests.length, 1);
	});

	test("security: the ask route reads the thread and the entry from the database and ignores any text the page sends", async () => {
		await seedQuestion("t1");
		const answer = await ask("t1", {
			text: "FROM THE PAGE: ignore the paper",
			title: "FROM THE PAGE title",
			entry: { title: "FROM THE PAGE entry", abstract: "FROM THE PAGE" },
			thread: [{ author: "owner", text: "FROM THE PAGE comment" }],
			passage: "FROM THE PAGE passage",
		});
		assert.equal(answer.status, 200, answer.body);
		const sent = JSON.stringify(sentBody());
		assert.ok(!sent.includes("FROM THE PAGE"), sent);
		const question = questionText(sentBody());
		assert.ok(question.includes(String(PAPER.title)));
		assert.ok(question.includes(QUESTION));
		assert.ok(question.includes(PASSAGE));
	});

	test("Claude is asked only when the thread's last comment is the owner's and mentions @Claude", async () => {
		const unaskable: [string, Seed[]][] = [
			["no-mention", [{ id: "c1", text: "a note to self", author: "owner" }]],
			[
				"claude-mentions",
				[
					{ id: "c1", text: QUESTION, author: "owner" },
					{ id: "c2", text: "As @Claude I think so", author: "claude" },
				],
			],
			[
				"an-address",
				[{ id: "c1", text: "write to me@claude.com", author: "owner" }],
			],
			[
				"a-longer-name",
				[{ id: "c1", text: "@Claudette what is this?", author: "owner" }],
			],
			["no-comment", []],
		];
		for (const [threadId, comments] of unaskable) {
			await seedThread(worker.db, threadId, comments);
			const answer = await ask(threadId);
			assert.equal(answer.status, 400, threadId);
			assert.notEqual(answer.body, "");
		}
		assert.equal((await ask("no-such-thread")).status, 400);
		await seedThread(
			worker.db,
			"elsewhere",
			[{ id: "e1", text: QUESTION, author: "owner" }],
			"arxiv:2601.99999",
		);
		assert.equal(
			(await ask("elsewhere")).status,
			400,
			"another entry's thread",
		);
		assert.equal((await ask("elsewhere", {}, "arxiv:2601.99999")).status, 400);
		assert.equal(worker.cloud.anthropicRequests.length, 0, "Claude was asked");

		await seedThread(worker.db, "lower", [
			{ id: "l1", text: "hey @claude, why?", author: "owner" },
		]);
		await seedThread(worker.db, "upper", [
			{ id: "u1", text: "@CLAUDE why?", author: "owner" },
		]);
		assert.equal((await ask("lower")).status, 200);
		assert.equal((await ask("upper")).status, 200);
		assert.equal(worker.cloud.anthropicRequests.length, 2);
	});

	test("a question Claude already answered is not sent again", async () => {
		// Claude's reply names @Claude too (it quotes the question), so only its author keeps it from being asked again.
		const quoting = "You asked @Claude what this means: the probe transfers.";
		await seedThread(worker.db, "answered", [
			{ id: "a1", text: QUESTION, author: "owner" },
			{ id: "a2", text: quoting, author: "claude" },
		]);
		assert.equal((await ask("answered")).status, 400);
		assert.equal(worker.cloud.anthropicRequests.length, 0, "Claude was asked");

		standIn({ kind: "text", pieces: [quoting], gate: null });
		await seedQuestion("fresh");
		assert.equal((await ask("fresh")).status, 200);
		const again = await ask("fresh");
		assert.equal(again.status, 400);
		assert.equal(worker.cloud.anthropicRequests.length, 1, "asked twice");
		assert.equal((await storedComments("fresh")).length, 2);
	});

	test("security: the owner's comments route refuses a comment that names an author, so it can't save one as Claude's", async () => {
		for (const author of ["claude", "owner"]) {
			const answer = await postToSite(worker.cloud, COMMENTS_PATH, {
				entryId: ENTRY,
				thread: { id: "t1", field: null, passage: null, occurrence: null },
				save: [{ ...commentBody("c1"), author: author }],
				delete: [],
			});
			assert.equal(answer.status, 400, answer.body);
			assert.match(answer.body, /can't name its author/);
		}
		const state = await readSiteState(worker.cloud);
		assert.deepEqual(state.comments[ENTRY] || [], []);
	});
	test("a comment saved through the comments route is stored as the owner's", async () => {
		const answer = await postToSite(worker.cloud, COMMENTS_PATH, {
			entryId: ENTRY,
			thread: { id: "t2", field: null, passage: null, occurrence: null },
			save: [commentBody("c2")],
			delete: [],
		});
		assert.equal(answer.status, 200, answer.body);
		const threads = (await readSiteState(worker.cloud)).comments[ENTRY] || [];
		assert.deepEqual(
			threads.map((thread) => thread.comments.map((each) => each.author)),
			[["owner"]],
		);
	});
	// The site stored a thread with a comment before migration 0007; the migration then runs, as a deploy does.
	test("comments stored before authors existed read as the owner's", async () => {
		const before = await startWorkerBefore("0007_comment_author.sql");
		try {
			const db = before.db;
			await db.batch([
				db
					.prepare(
						"INSERT INTO threads (id, entry_id, field, passage, occurrence, created) VALUES (?1, ?2, NULL, NULL, NULL, ?3)",
					)
					.bind("t3", ENTRY, CREATED),
				db
					.prepare(
						"INSERT INTO comments (id, thread_id, text, created, edited) VALUES (?1, ?2, ?3, ?4, NULL)",
					)
					.bind("c3", "t3", "Contradicts Table 3", CREATED),
			]);
			await before.applyRest();
			const state = await worker.owner.readState(db, ignoreCost);
			const comments = (state.comments[ENTRY] || []).flatMap(
				(thread) => thread.comments,
			);
			assert.deepEqual(
				comments.map((each) => [each.id, each.author]),
				[["c3", "owner"]],
			);
		} finally {
			await before.stop();
		}
	});
});

describe("limits", () => {
	test("a site without ANTHROPIC_API_KEY refuses every question before Anthropic is asked", async () => {
		const started = await startCloud();
		started.cloud.anthropicKey = null;
		try {
			await startWorker(started.cloud);
			const db = started.cloud.db;
			assert.ok(db !== null);
			await seedEntry(db, PAPER, 1);
			await seedThread(db, "t1", [
				{ id: "q1", text: QUESTION, author: "owner" },
			]);
			const answered = await postToSite(started.cloud, ASK_PATH, {
				entryId: ENTRY,
				threadId: "t1",
			});
			assert.equal(answered.status, 503);
			assert.equal(answered.body, "notSetUp");
			const unknown = await postToSite(started.cloud, ASK_PATH, {
				entryId: ENTRY,
				threadId: "no-such-thread",
			});
			assert.equal(unknown.status, 503);
			assert.equal(started.cloud.anthropicRequests.length, 0);
			assert.equal((await storedComments("t1", db)).length, 1);
		} finally {
			await stopCloud(started.cloud, started.server);
		}
	});

	// A dropped comments table makes the ask route's one read batch fail, as a D1 outage does.
	test("a database failure while asking is refused with 502 and Claude is not asked", async () => {
		const started = await startCloud();
		try {
			await startWorker(started.cloud);
			const db = started.cloud.db;
			assert.ok(db !== null);
			await db.prepare("DROP TABLE comments").run();
			const answered = await postToSite(started.cloud, ASK_PATH, {
				entryId: ENTRY,
				threadId: "t1",
			});
			assert.equal(answered.status, 502);
			assert.equal(answered.body, "failed");
			assert.equal(started.cloud.anthropicRequests.length, 0);
		} finally {
			await stopCloud(started.cloud, started.server);
		}
	});
});

describe("what Claude is sent", () => {
	test("the request asks Sonnet 5.5 at high effort for at most 2,000 output tokens, streamed", async () => {
		await seedQuestion("t1");
		assert.equal((await ask("t1")).status, 200);
		const body = sentBody();
		assert.equal(body.model, "claude-sonnet-5-5");
		assert.deepEqual(body.output_config, { effort: "high" });
		assert.equal(body.max_tokens, 2000);
		assert.equal(body.stream, true);
	});

	test("the question holds the entry's title, authors, venue and abstract, the commented passage and the whole thread, oldest first", async () => {
		await seedThread(worker.db, "t1", [
			{ id: "c1", text: "an earlier worry about the proof", author: "owner" },
			{ id: "c2", text: "an earlier answer about the proof", author: "claude" },
			{ id: "c3", text: "@Claude and in the figures?", author: "owner" },
		]);
		assert.equal((await ask("t1")).status, 200);
		const question = questionText(sentBody());
		for (const part of [
			String(PAPER.title),
			"Yann LeCun",
			"Geoffrey Hinton",
			"ICML 2026",
			String(PAPER.abstract),
			PASSAGE,
			"abstract",
		]) {
			assert.ok(question.includes(part), `the question lacks: ${part}`);
		}
		const places = [
			"an earlier worry about the proof",
			"an earlier answer about the proof",
			"@Claude and in the figures?",
		].map((text) => question.indexOf(text));
		assert.ok(places.every((place) => place >= 0));
		assert.deepEqual(
			places,
			[...places].sort((a, b) => a - b),
		);
	});

	test("security: the question names the paper's arXiv HTML and PDF addresses, and the request holds no other address", async () => {
		await seedQuestion("t1");
		assert.equal((await ask("t1")).status, 200);
		const body = sentBody();
		const question = questionText(body);
		assert.ok(question.includes("https://arxiv.org/html/2601.00001"));
		assert.ok(question.includes("https://arxiv.org/pdf/2601.00001"));
		// Every address anywhere in the request is one of the paper's two.
		const everything = `${JSON.stringify(body.system)}\n${question}`;
		const addresses = everything.match(/https?:\/\/[^\s"\\]+/g) || [];
		assert.deepEqual(
			[...new Set(addresses)].sort(),
			[
				"https://arxiv.org/html/2601.00001",
				"https://arxiv.org/pdf/2601.00001",
			].sort(),
		);
	});

	test("limit: web fetch may reach any public host, at most four times a question and at most 50,000 tokens of a page", async () => {
		await seedQuestion("t1");
		assert.equal((await ask("t1")).status, 200);
		const tool = toolNamed(sentBody(), "web_fetch");
		assert.equal(tool.max_uses, 4);
		assert.equal(tool.max_content_tokens, 50_000);
		assert.equal(tool.allowed_domains, undefined);
		assert.equal(tool.blocked_domains, undefined);
	});

	test("limit: web search may run at most twice a question", async () => {
		await seedQuestion("t1");
		assert.equal((await ask("t1")).status, 200);
		assert.equal(toolNamed(sentBody(), "web_search").max_uses, 2);
	});

	test("security: web fetch may open the paper's addresses and the pages web search returned", async () => {
		await seedQuestion("t1");
		assert.equal((await ask("t1")).status, 200);
		const sources = object(toolNamed(sentBody(), "web_fetch").url_sources);
		assert.deepEqual(sources.user_input, { type: "all" });
		assert.deepEqual(sources.server_tool_results, {
			type: "only",
			tools: [{ type: "tool_reference", name: "web_search" }],
		});
	});

	test("security: web fetch may not follow an address it read in a fetched page", async () => {
		await seedQuestion("t1");
		assert.equal((await ask("t1")).status, 200);
		const sources = object(toolNamed(sentBody(), "web_fetch").url_sources);
		// Addresses in a page web fetch read, or in any other tool's output, are never opened.
		assert.deepEqual(sources.client_tool_results, { type: "none" });
		assert.deepEqual(sources.server_tool_results, {
			type: "only",
			tools: [{ type: "tool_reference", name: "web_search" }],
		});
	});

	test("the question about a paper from proceedings gives its own PDF link and no arXiv address", async () => {
		await seedThread(
			worker.db,
			"t1",
			[{ id: "p1", text: QUESTION, author: "owner" }],
			PROCEEDINGS_ENTRY,
			{ field: null, passage: null },
		);
		assert.equal((await ask("t1", {}, PROCEEDINGS_ENTRY)).status, 200);
		const question = questionText(sentBody());
		assert.ok(
			question.includes("https://aclanthology.org/2026.acl-long.99.pdf"),
		);
		assert.ok(!question.includes("arxiv.org/html"));
		assert.ok(!question.includes("arxiv.org/pdf"));
	});
});

// The pieces of a reply sent in three, as the stand-in streams them.
const PIECES = ["First part. ", "Second part. ", "Third part."];

describe("the answer", () => {
	test("Claude's text pieces join without a break, but a tool call between two pieces starts a new paragraph", async () => {
		await seedQuestion("t1");
		const text = (text: string): AnthropicBlock => ({
			type: "text",
			text: text,
		});
		standIn({
			kind: "turns",
			turns: [
				{
					blocks: [
						text("First "),
						text("part."),
						{ type: "server_tool_use", name: "web_fetch" },
						text("Second part."),
					],
					stopReason: "end_turn",
				},
			],
		});
		const response = await openAsk(worker.cloud, {
			entryId: ENTRY,
			threadId: "t1",
		});
		assert.equal(await readAll(response), "First part.\n\nSecond part.");
		const reply = (await storedComments("t1")).at(-1);
		assert.equal(reply?.text, "First part.\n\nSecond part.");
	});

	test("limit: an answer the API pauses is resumed with what Claude wrote so far, at most twice, then fails", async () => {
		await seedQuestion("t1");
		const paused = (text: string): AnthropicTurn => ({
			blocks: [
				{ type: "text", text: text },
				{ type: "server_tool_use", name: "web_fetch" },
			],
			stopReason: "pause_turn",
		});
		const finished: AnthropicTurn = {
			blocks: [{ type: "text", text: "The rest." }],
			stopReason: "end_turn",
		};

		// Paused twice, then finished: three requests, each carrying what the one before wrote.
		standIn({
			kind: "turns",
			turns: [paused("Reading. "), paused("Still reading. "), finished],
		});
		const resumed = await openAsk(worker.cloud, {
			entryId: ENTRY,
			threadId: "t1",
		});
		assert.equal(
			await readAll(resumed),
			"Reading. \n\nStill reading. \n\nThe rest.",
		);
		const bodies = sentBodies();
		assert.equal(bodies.length, 3);
		for (const [asked, body] of bodies.entries()) {
			assert.ok(Array.isArray(body.messages));
			assert.equal(body.messages.length, 1 + asked);
		}
		const lastMessages = bodies[2]?.messages;
		assert.ok(Array.isArray(lastMessages));
		const lastAssistant = object(lastMessages[2]);
		assert.equal(lastAssistant.role, "assistant");
		assert.ok(Array.isArray(lastAssistant.content));
		const [text, call] = lastAssistant.content.map(object);
		assert.equal(text?.type, "text");
		assert.equal(text?.text, "Still reading. ");
		assert.equal(call?.type, "server_tool_use");
		assert.equal(call?.name, "web_fetch");

		// Paused a third time: no fourth request, and the answer fails.
		worker.cloud.anthropicRequests.length = 0;
		await seedQuestion("t2");
		standIn({ kind: "turns", turns: [paused("Reading. ")] });
		const failed = await openAsk(worker.cloud, {
			entryId: ENTRY,
			threadId: "t2",
		});
		assert.equal(failed.status, 200);
		await assert.rejects(readAll(failed));
		assert.equal(sentBodies().length, 3);
		assert.equal((await storedComments("t2")).length, 1);
	});

	test("each piece of Claude's text reaches the page as it arrives", async () => {
		await seedQuestion("t1");
		const gate = makeGate(1);
		standIn({ kind: "text", pieces: PIECES, gate: gate });
		const response = await openAsk(worker.cloud, {
			entryId: ENTRY,
			threadId: "t1",
		});
		assert.equal(response.status, 200);
		assert.ok(response.body !== null);
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		// The stand-in holds back everything after the first piece, so this piece reached the page before the answer ended.
		const first = await reader.read();
		assert.equal(decoder.decode(first.value), PIECES[0]);
		gate.release();
		let rest = "";
		for (;;) {
			const piece = await reader.read();
			if (piece.done) {
				break;
			}
			rest += decoder.decode(piece.value, { stream: true });
		}
		assert.equal(rest, PIECES.slice(1).join(""));
	});

	test("the whole reply is saved as one Claude comment in the thread when the answer ends", async () => {
		await seedQuestion("t1");
		standIn({ kind: "text", pieces: PIECES, gate: null });
		const response = await openAsk(worker.cloud, {
			entryId: ENTRY,
			threadId: "t1",
		});
		assert.equal(await readAll(response), PIECES.join(""));
		const saved = await storedComments("t1");
		assert.equal(saved.length, 2);
		const [question, reply] = saved;
		assert.equal(question?.author, "owner");
		assert.equal(reply?.author, "claude");
		assert.equal(reply?.text, PIECES.join(""));
		assert.match(String(reply?.id), /^[0-9a-f-]{36}$/);
		assert.notEqual(reply?.id, question?.id);
		// Saved as UTC time, a moment ago.
		const created = String(reply?.created);
		assert.equal(new Date(created).toISOString(), created);
		assert.ok(Date.now() - Date.parse(created) < 60_000);
		const threads = (await readSiteState(worker.cloud)).comments[ENTRY] || [];
		assert.deepEqual(
			threads.flatMap((thread) => thread.comments.map((each) => each.author)),
			["owner", "claude"],
		);
	});

	test("a reply is still saved when the page leaves before the answer ends", async () => {
		await seedQuestion("t1");
		const gate = makeGate(1);
		standIn({ kind: "text", pieces: PIECES, gate: gate });
		const leaving = new AbortController();
		const response = await openAsk(
			worker.cloud,
			{ entryId: ENTRY, threadId: "t1" },
			leaving.signal,
		);
		assert.ok(response.body !== null);
		const reader = response.body.getReader();
		await reader.read();
		leaving.abort();
		gate.release();
		await vi.waitFor(
			async () => {
				assert.equal((await storedComments("t1")).length, 2);
			},
			{ timeout: 10_000, interval: 50 },
		);
		const reply = (await storedComments("t1"))[1];
		assert.equal(reply?.author, "claude");
		assert.equal(reply?.text, PIECES.join(""));
	});

	test("an answer that fails or is refused saves no comment and tells the page it failed", async () => {
		const failures: [string, AnthropicAnswer][] = [
			[
				"a server error",
				{ kind: "error", status: 500, type: "api_error", message: "boom" },
			],
			[
				"an overloaded API",
				{
					kind: "error",
					status: 529,
					type: "overloaded_error",
					message: "Overloaded",
				},
			],
			[
				"a refused request",
				{
					kind: "error",
					status: 403,
					type: "permission_error",
					message: "no access",
				},
			],
			["an answer with no text", { kind: "text", pieces: [], gate: null }],
		];
		for (const [what, answer] of failures) {
			const threadId = `t-${what.replaceAll(" ", "-")}`;
			await seedQuestion(threadId);
			standIn(answer);
			const told = await ask(threadId);
			assert.equal(told.status, 502, what);
			assert.equal(told.body, "failed", what);
			assert.equal((await storedComments(threadId)).length, 1, what);
		}

		// An answer that breaks after some text ends the page's stream in an error and saves nothing.
		await seedQuestion("t-cut");
		const gate = makeGate(1);
		standIn({ kind: "cut", pieces: ["Half an ans"], gate: gate });
		const response = await openAsk(worker.cloud, {
			entryId: ENTRY,
			threadId: "t-cut",
		});
		assert.equal(response.status, 200);
		assert.ok(response.body !== null);
		const reader = response.body.getReader();
		// The page has the half answer before the API fails.
		assert.equal(
			new TextDecoder().decode((await reader.read()).value),
			"Half an ans",
		);
		gate.release();
		let broke = false;
		try {
			for (;;) {
				const piece = await reader.read();
				if (piece.done) {
					break;
				}
			}
		} catch {
			broke = true;
		}
		assert.ok(broke, "the stream ended as if the answer were whole");
		assert.equal((await storedComments("t-cut")).length, 1);
	});

	test("Anthropic's spend-limit refusal reaches the page as 402 'budget', and other refusals as 502 'failed'", async () => {
		const budget: AnthropicAnswer[] = [
			{
				kind: "error",
				status: 400,
				type: "invalid_request_error",
				message:
					"You have reached your specified workspace API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.",
			},
			{
				kind: "error",
				status: 400,
				type: "invalid_request_error",
				message:
					"You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.",
			},
			{
				kind: "error",
				status: 429,
				type: "rate_limit_error",
				message:
					"You have reached your API usage limits: your organization has crossed its monthly API usage threshold. You will regain access on 2026-12-01 at 00:00 UTC.",
				code: "enforced_spend_limit_reached",
			},
		];
		// Other refusals of a request are a failed answer, not a used-up budget.
		const failed: AnthropicAnswer[] = [
			{
				kind: "error",
				status: 400,
				type: "invalid_request_error",
				message: "max_tokens: 5000 > 2000, which is the maximum allowed",
			},
			{
				kind: "error",
				status: 429,
				type: "rate_limit_error",
				message: "This request would exceed your per-minute rate limit.",
			},
		];
		const cases: [AnthropicAnswer, number, string][] = [
			...budget.map((answer): [AnthropicAnswer, number, string] => [
				answer,
				402,
				"budget",
			]),
			...failed.map((answer): [AnthropicAnswer, number, string] => [
				answer,
				502,
				"failed",
			]),
		];
		for (const [index, [answer, status, name]] of cases.entries()) {
			const threadId = `t${index}`;
			await seedQuestion(threadId);
			standIn(answer);
			const told = await ask(threadId);
			assert.equal(told.status, status, JSON.stringify(answer));
			assert.equal(told.body, name, JSON.stringify(answer));
			assert.equal((await storedComments(threadId)).length, 1);
		}
	});
});

describe("the API key", () => {
	test("privacy: the API key never appears in a log line, an answer to the page or an error message", async () => {
		const key = worker.cloud.anthropicKey;
		assert.ok(key !== null);
		// Anthropic's refusals can quote the key they were sent; the stand-in does.
		const echoing = (status: number, type: string): AnthropicAnswer => ({
			kind: "error",
			status: status,
			type: type,
			message: `invalid x-api-key: ${key}`,
		});
		const answers: AnthropicAnswer[] = [
			{ kind: "text", pieces: PIECES, gate: null },
			echoing(401, "authentication_error"),
			echoing(500, "api_error"),
			{ kind: "cut", pieces: ["Half an ans"], gate: null },
		];
		const seen: string[] = [];
		for (const [index, answer] of answers.entries()) {
			const threadId = `t${index}`;
			await seedQuestion(threadId);
			standIn(answer);
			const response = await openAsk(worker.cloud, {
				entryId: ENTRY,
				threadId: threadId,
			});
			seen.push(String(response.status), ...response.headers.values());
			try {
				seen.push(await readAll(response));
			} catch (error) {
				// A broken stream is the page's error; what it says is part of what the page sees.
				seen.push(String(error), String((error as Error).cause));
			}
		}
		const logs = (worker.cloud.harness?.getLogs() || []).map((log) =>
			String(log.message),
		);
		assert.ok(
			logs.some((line) => line.includes('"claude":"failed"')),
			"no failure was logged, so the check would pass on silence",
		);
		for (const text of [...seen, ...logs]) {
			assert.ok(!text.includes(key), "the key appears in a log or an answer");
		}
	});

	test("privacy: no test request reaches api.anthropic.com", async () => {
		// The Worker is given the stand-in's address as Anthropic's API, and Claude is asked through it.
		const env = await worker.cloud.harness?.getWorker().getEnv();
		assert.equal(env?.ANTHROPIC_API, worker.cloud.accessUrl);
		assert.match(worker.cloud.accessUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
		await seedQuestion("t1");
		assert.equal((await ask("t1")).status, 200);
		assert.equal(worker.cloud.anthropicRequests.length, 1);

		// Code asked to reach Anthropic's real address in a test is stopped by the network guard.
		const guarded = await run(
			process.execPath,
			[
				"--import",
				"./tests/fixtures/no-network.ts",
				"tests/fixtures/ask-real-address.ts",
			],
			{ cwd: ROOT },
		);
		assert.match(
			guarded.stderr,
			/no-network\.ts: blocked fetch https:\/\/api\.anthropic\.com\/v1\/messages/,
		);
		const lines = guarded.stdout.trim().split("\n");
		assert.deepEqual(JSON.parse(String(lines.at(-1))), {
			ok: false,
			refusal: "failed",
		});
	});
});
