// The connector's JSON-RPC answers, read from the real Worker's mcp.ts over a SQLite D1 (tests/fixtures/worker-in-node.ts).
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, test, vi } from "vitest";
import { PROTOCOL_VERSIONS } from "../../shared/connector-protocol.ts";
import type { JsonObject } from "../../shared/narrow.ts";
import {
	type Access,
	loadWorker,
	migratedDatabase,
	startAccess,
	workerEnv,
} from "../fixtures/worker-in-node.ts";
import { ignoreCost, workerModule } from "./owner-worker.ts";

// The request's log line, as worker/src/env.ts's RequestLog states it.
type Log = {
	method: string;
	path: string;
	status: number;
	reason?: string;
	queries: number;
	rowsRead: number;
	rowsWritten: number;
};

// worker/src/mcp.ts as these tests call it, typed here so the tests' type check doesn't read Cloudflare's types.
type McpModule = {
	answerMcp(
		request: Request,
		env: unknown,
		log: Log,
		count: typeof ignoreCost,
	): Promise<Response>;
};

// worker/src/mcp-tools.ts's registry as these tests read it.
type ToolsModule = {
	TOOLS: {
		name: string;
		description: string;
		inputSchema: { type?: unknown; additionalProperties?: unknown };
		run: unknown;
	}[];
};

// A JSON-RPC answer: a result or an error, as the connector sends it.
type RpcAnswer = {
	status: number;
	log: Log;
	body: {
		id: unknown;
		result?: {
			tools?: Record<string, unknown>[];
			content?: { type: string; text: string }[];
			isError?: boolean;
		};
		error?: { code: number; message: string };
	};
};

const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

let access: Access;
let mcp: McpModule;
let tools: ToolsModule;

beforeAll(async () => {
	access = await startAccess();
	mcp = await workerModule<McpModule>("mcp.ts");
	tools = await workerModule<ToolsModule>("mcp-tools.ts");
});

afterAll(async () => {
	await access.close();
});

// Send one JSON-RPC request the way the connector does and read the answer and the log line it filled in.
async function rpc(
	env: unknown,
	method: string,
	params: unknown,
): Promise<RpcAnswer> {
	const log: Log = {
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
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params }),
	});
	const answer = await mcp.answerMcp(request, env, log, ignoreCost);
	return { status: answer.status, log: log, body: await answer.json() };
}

// A tools/call for one tool, in an empty migrated database unless a test gives its own.
function callTool(name: string, args: unknown, env = freshEnv()) {
	return rpc(env, "tools/call", { name: name, arguments: args });
}

function freshEnv() {
	return workerEnv(access, migratedDatabase());
}

// The text a tool answered.
function textOf(answer: RpcAnswer): string {
	const content = answer.body.result?.content?.[0];
	assert.ok(content, JSON.stringify(answer.body));
	return content.text;
}

test("the connector offers add_papers and add_links, and no add_status", async () => {
	const answer = await rpc(freshEnv(), "tools/list", {});
	const names = answer.body.result?.tools?.map((tool) => tool.name);
	assert.ok(names);
	assert.ok(names.includes("add_papers"), String(names));
	assert.ok(names.includes("add_links"), String(names));
	assert.equal(names.includes("add_status"), false, String(names));
	const status = await callTool("add_status", {});
	assert.equal(status.body.error?.code, INVALID_PARAMS);
});

test("every tool has a description, an object inputSchema with additionalProperties false, and a run function", () => {
	for (const tool of tools.TOOLS) {
		assert.ok(tool.description.length > 0, tool.name);
		assert.equal(tool.inputSchema.type, "object", tool.name);
		assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
		assert.equal(typeof tool.run, "function", tool.name);
	}
});

test("tools/list answers each tool's name, description and inputSchema only", async () => {
	const answer = await rpc(freshEnv(), "tools/list", {});
	const tools = answer.body.result?.tools;
	assert.ok(tools && tools.length > 0);
	for (const tool of tools) {
		assert.deepEqual(Object.keys(tool).sort(), [
			"description",
			"inputSchema",
			"name",
		]);
	}
});

test("tools/call runs the named tool's handler", async () => {
	const papers = await callTool("add_papers", { ids: ["not an id"] });
	assert.match(textOf(papers), /^Not an arXiv id: "not an id"\./);
	const links = await callTool("add_links", { links: [] });
	assert.equal(textOf(links), "Give at least one link.");
	const found = await callTool("search", { query: "steering" });
	assert.equal(textOf(found), 'No entry matches "steering".');
	const digest = await callTool("get_digest", {});
	assert.equal(textOf(digest), "There are no digests yet.");
	const takeaway = await callTool("propose_takeaway", {
		id: "arxiv:2507.11473",
		takeaway: "a takeaway",
		question: "a question",
		app: "claude.ai",
	});
	assert.match(textOf(takeaway), /^No entry in the digests has the id /);
	assert.equal(takeaway.body.result?.isError, true);
});

test("tools/call with arguments of the wrong shape answers invalid params and logs the reason", async () => {
	const answer = await callTool("add_papers", { ids: "2507.11473" });
	assert.equal(answer.status, 200);
	assert.equal(answer.body.error?.code, INVALID_PARAMS);
	assert.equal(answer.body.error?.message, "ids must be a list of arXiv ids");
	assert.equal(answer.log.reason, "ids must be a list of arXiv ids");
});

test("tools/call with an unknown tool answers -32602 unknown tool", async () => {
	const answer = await callTool("delete_everything", {});
	assert.equal(answer.body.error?.code, INVALID_PARAMS);
	assert.equal(answer.body.error?.message, "unknown tool");
});

test("a database failure in a tool answers -32603 asking to try again, not invalid params", async () => {
	const db = migratedDatabase();
	db.exec("DROP TABLE entries");
	const answer = await callTool("get_digest", {}, workerEnv(access, db));
	assert.equal(answer.body.error?.code, INTERNAL_ERROR);
	assert.equal(answer.body.error?.message, "the database failed; try again");
	assert.match(answer.log.reason ?? "", /^the database failed: /);
});

// ---- The connector's protocol, its add tools and its read tools, as the old connector scenarios checked them ----

// The stand-in for GitHub's API: it records every request it is asked and answers `status` with `body`.
type Github = {
	origin: string;
	asked: { path: string; body: string; authorization: string | undefined }[];
	answerWith: (status: number, body?: string) => void;
	close: () => Promise<void>;
};

async function startGithub(): Promise<Github> {
	const github: Github = {
		origin: "",
		asked: [],
		answerWith: (status, body = "") => {
			answer = status;
			answerBody = body;
		},
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
			}),
	};
	let answer = 204;
	let answerBody = "";
	const server = http.createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			github.asked.push({
				path: request.url ?? "",
				body: Buffer.concat(chunks).toString(),
				authorization: request.headers.authorization,
			});
			response.statusCode = answer;
			response.end(answerBody);
		});
	});
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	github.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return github;
}

let github: Github;

beforeAll(async () => {
	github = await startGithub();
});

afterAll(async () => {
	await github.close();
});

beforeEach(() => {
	github.asked.length = 0;
	github.answerWith(204);
});

// A migrated database and the Worker's settings with GitHub's API at the stand-in.
function siteWith() {
	const db = migratedDatabase();
	return { db: db, env: workerEnv(access, db, { GITHUB_API: github.origin }) };
}

// Send one body the way a caller could, with these headers, and read what came back.
async function post(
	body: string,
	headers: Record<string, string>,
	env = freshEnv(),
) {
	const log: Log = {
		method: "POST",
		path: "/liminal-space/mcp",
		status: 0,
		queries: 0,
		rowsRead: 0,
		rowsWritten: 0,
	};
	const request = new Request("https://ivan.wiryadi.com/liminal-space/mcp", {
		method: "POST",
		headers: headers,
		body: body,
	});
	const answer = await mcp.answerMcp(request, env, log, ignoreCost);
	return {
		status: answer.status,
		contentType: answer.headers.get("Content-Type"),
		text: await answer.text(),
		log: log,
	};
}

const JSON_HEADERS = { "Content-Type": "application/json" };

function message(method: string, params: unknown = {}): string {
	return JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params });
}

test("initialize answers the client's protocol version when the Worker speaks it", async () => {
	for (const version of PROTOCOL_VERSIONS) {
		const answer = await post(
			message("initialize", { protocolVersion: version }),
			JSON_HEADERS,
		);
		const body = JSON.parse(answer.text);
		assert.equal(body.result.protocolVersion, version);
		assert.equal(body.result.serverInfo.name, "liminal-space");
		assert.ok(body.result.capabilities.tools);
		assert.equal(answer.contentType?.split(";")[0], "application/json");
	}
});

test("initialize with a protocol version the Worker doesn't speak answers one it does", async () => {
	const answer = await post(
		message("initialize", { protocolVersion: "2099-01-01" }),
		JSON_HEADERS,
	);
	const version = JSON.parse(answer.text).result.protocolVersion;
	assert.ok(PROTOCOL_VERSIONS.includes(version), version);
});

test("a notification gets an empty 202, and so does a client's answer to a request", async () => {
	for (const body of [
		JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
		JSON.stringify({ jsonrpc: "2.0", id: 7, result: {} }),
	]) {
		const answer = await post(body, JSON_HEADERS);
		assert.equal(answer.status, 202);
		assert.equal(answer.text, "");
	}
});

test("a body that isn't JSON, a batch, and an unknown method each get their own JSON-RPC error code", async () => {
	const notJson = await post("{not json", JSON_HEADERS);
	assert.equal(notJson.status, 400);
	assert.equal(JSON.parse(notJson.text).error.code, -32700);

	const batch = await post(
		JSON.stringify([JSON.parse(message("ping"))]),
		JSON_HEADERS,
	);
	assert.equal(JSON.parse(batch.text).error.code, -32600);

	const unknown = await post(message("resources/list"), JSON_HEADERS);
	assert.equal(unknown.status, 200);
	assert.equal(JSON.parse(unknown.text).error.code, -32601);
});

test("security: a request with an Origin header or without a JSON content type is refused with 403 and queues nothing", async () => {
	const queued = siteWith();
	const body = message("tools/call", {
		name: "add_papers",
		arguments: { ids: ["2507.11473"] },
	});
	const pageRequests: Record<string, Record<string, string>> = {
		"an Origin": { ...JSON_HEADERS, Origin: "https://example.com" },
		"a text/plain body": { "Content-Type": "text/plain" },
		"no content type": {},
	};
	for (const [name, headers] of Object.entries(pageRequests)) {
		const answer = await post(body, headers, queued.env);
		assert.equal(answer.status, 403, name);
	}
	const rows = queued.db
		.prepare("SELECT COUNT(*) AS n FROM add_requests")
		.get();
	assert.equal(rows?.n, 0);
	assert.deepEqual(github.asked, []);
});

test("application/json with a charset is taken as JSON", async () => {
	const answer = await post(message("ping"), {
		"Content-Type": "application/json; charset=utf-8",
	});
	assert.equal(answer.status, 200);
});

test("a ping with an MCP-Protocol-Version the Worker doesn't speak is refused with -32600, and one it speaks is answered", async () => {
	const answer = await post(message("ping"), {
		...JSON_HEADERS,
		"MCP-Protocol-Version": "2099-01-01",
	});
	assert.equal(JSON.parse(answer.text).error.code, -32600);
	const spoken = await post(message("ping"), {
		...JSON_HEADERS,
		"MCP-Protocol-Version": PROTOCOL_VERSIONS[0] ?? "",
	});
	assert.deepEqual(JSON.parse(spoken.text).result, {});
});

// ---- add_papers ----

// The add_requests rows, as the Worker stored them.
function requestRows(db: DatabaseSync) {
	return db
		.prepare(
			"SELECT id, kind, payload, status FROM add_requests ORDER BY rowid",
		)
		.all();
}

test("add_papers queues the ids and asks GitHub to run add.yml on main", async () => {
	const { db, env } = siteWith();
	await callTool(
		"add_papers",
		{ ids: ["2507.11473", "arxiv:2610.00001"] },
		env,
	);
	const rows = requestRows(db);
	assert.equal(rows.length, 1);
	const row = rows[0];
	assert.equal(row?.kind, "papers");
	assert.equal(row?.status, "queued");
	assert.deepEqual(JSON.parse(String(row?.payload)), {
		papers: ["2507.11473", "arxiv:2610.00001"],
	});
	assert.equal(github.asked.length, 1);
	const asked = github.asked[0];
	assert.equal(
		asked?.path,
		"/repos/strivn/liminal-space/actions/workflows/add.yml/dispatches",
	);
	assert.deepEqual(JSON.parse(asked?.body ?? ""), { ref: "main" });
	assert.equal(asked?.authorization, "Bearer test-dispatch-token");
});

test("each daily cron asks GitHub to run scout.yml on main, once", async () => {
	const worker = await loadWorker();
	for (const cron of ["0 22 * * *", "0 23 * * *"]) {
		github.asked.length = 0;
		await worker.scheduled(
			{ cron: cron, scheduledTime: Date.now() },
			siteWith().env,
		);
		assert.deepEqual(
			github.asked.map((asked) => [asked.path, asked.body]),
			[
				[
					"/repos/strivn/liminal-space/actions/workflows/scout.yml/dispatches",
					'{"ref":"main"}',
				],
			],
			cron,
		);
	}
});

test("security: add_papers refuses a value that isn't an arXiv id, or more than 10 ids, names the problem, and queues nothing", async () => {
	const tooMany = Array.from({ length: 11 }, (_, k) => `2507.${10000 + k}`);
	const refused: [string[], string][] = [
		[["2507.11473", "not-an-id"], '"not-an-id"'],
		[
			["https://arxiv.org/abs/2507.11473"],
			'"https://arxiv.org/abs/2507.11473"',
		],
		[["2507.11473", "--/1234567"], '"--/1234567"'],
		[tooMany, "more than 10 ids in one call"],
	];
	for (const [ids, named] of refused) {
		const { db, env } = siteWith();
		const answer = await callTool("add_papers", { ids: ids }, env);
		assert.equal(answer.body.result?.isError, true, named);
		assert.ok(textOf(answer).includes(named), textOf(answer));
		assert.deepEqual(requestRows(db), [], named);
	}
	assert.deepEqual(github.asked, []);
});

test("add_papers accepts ten ids, and queues an id given twice only once", async () => {
	const ten = Array.from({ length: 10 }, (_, k) => `2507.${10000 + k}`);
	const { db, env } = siteWith();
	await callTool("add_papers", { ids: ten }, env);
	await callTool("add_papers", { ids: ["2507.11473", "2507.11473"] }, env);
	const rows = requestRows(db);
	assert.equal(JSON.parse(String(rows[0]?.payload)).papers.length, 10);
	assert.deepEqual(JSON.parse(String(rows[1]?.payload)), {
		papers: ["2507.11473"],
	});
});

// ---- add_links ----

const NEWS: JsonObject = {
	type: "news",
	title: "Hinton wins award",
	published: "2026-10-16",
	source: "Example News",
	url: "https://example.com/hinton",
};

test("add_links queues a link and asks GitHub to run add.yml", async () => {
	const { db, env } = siteWith();
	await callTool("add_links", { links: [NEWS] }, env);
	const rows = requestRows(db);
	assert.equal(rows.length, 1);
	assert.equal(rows[0]?.kind, "links");
	assert.deepEqual(JSON.parse(String(rows[0]?.payload)), { links: [NEWS] });
	assert.equal(github.asked.length, 1);
});

test("add_papers and add_links answer that the request is queued and to check the page in a few minutes", async () => {
	const { env } = siteWith();
	const papers = await callTool(
		"add_papers",
		{ ids: ["2507.11473", "2610.00001"] },
		env,
	);
	assert.equal(
		textOf(papers),
		"Queued 2 papers. Tell the user to check the page in a few minutes.",
	);
	const links = await callTool("add_links", { links: [NEWS] }, env);
	assert.equal(
		textOf(links),
		"Queued 1 link. Tell the user to check the page in a few minutes.",
	);
});

test("security: add_links refuses a link without a title, with a javascript: or local url, or with a field only the add run sets, and queues nothing", async () => {
	const refused: Record<string, [JsonObject, string]> = {
		"a link without a title": [{ ...NEWS, title: undefined }, "title"],
		"a javascript: url": [{ ...NEWS, url: "javascript:alert(1)" }, "url"],
		"a description": [
			{ ...NEWS, description: "written in the chat" },
			'"description"',
		],
		ad_hoc: [{ ...NEWS, ad_hoc: true }, '"ad_hoc"'],
		"a local address": [
			{ ...NEWS, url: "http://127.0.0.1:8787/admin" },
			"127.0.0.1",
		],
	};
	for (const [name, [item, named]] of Object.entries(refused)) {
		const { db, env } = siteWith();
		const answer = await callTool("add_links", { links: [item] }, env);
		assert.equal(answer.body.result?.isError, true, name);
		assert.ok(textOf(answer).includes(named), `${name}: ${textOf(answer)}`);
		assert.ok(textOf(answer).endsWith("Nothing was queued."), name);
		assert.deepEqual(requestRows(db), [], name);
	}
	assert.deepEqual(github.asked, []);
});

test("security: add_links queues a link given twice in one call only once, and accepts five links but refuses six", async () => {
	const { db, env } = siteWith();
	await callTool("add_links", { links: [NEWS, NEWS] }, env);
	assert.deepEqual(JSON.parse(String(requestRows(db)[0]?.payload)), {
		links: [NEWS],
	});

	const links = Array.from({ length: 6 }, (_, k) => ({
		...NEWS,
		url: `https://example.com/story-${k}`,
	}));
	const five = await callTool("add_links", { links: links.slice(0, 5) }, env);
	assert.match(textOf(five), /^Queued 5 links\./);
	const six = await callTool("add_links", { links: links }, env);
	assert.equal(six.body.result?.isError, true);
	assert.match(textOf(six), /at most 5 links a call/);
	assert.equal(requestRows(db).length, 2);
});

// ---- the queue's limits and retries ----

const NOW = new Date().toISOString();

function insertRequest(
	db: DatabaseSync,
	id: string,
	status: string,
	created: string = NOW,
) {
	db.prepare(
		"INSERT INTO add_requests (id, kind, payload, status, created) VALUES (?, 'papers', ?, ?, ?)",
	).run(id, JSON.stringify({ papers: ["2507.11473"] }), status, created);
}

test("security: at most 30 requests wait at once: the 31st is refused and nothing is added", async () => {
	const { db, env } = siteWith();
	for (let k = 0; k < 30; k++) {
		insertRequest(db, `waiting-${k}`, "queued");
	}
	const answer = await callTool("add_papers", { ids: ["2507.11473"] }, env);
	assert.equal(answer.body.result?.isError, true);
	assert.match(textOf(answer), /30 requests are already waiting/);
	assert.equal(requestRows(db).length, 30);
	assert.deepEqual(github.asked, []);
});

test("two calls racing for the last place in the queue get one place between them", async () => {
	const { db, env } = siteWith();
	for (let k = 0; k < 29; k++) {
		insertRequest(db, `waiting-${k}`, "queued");
	}
	const [first, second] = await Promise.all([
		callTool("add_papers", { ids: ["2507.11473"] }, env),
		callTool("add_papers", { ids: ["2507.11473"] }, env),
	]);
	const refused = [first, second].filter(
		(answer) => answer.body.result?.isError === true,
	);
	assert.equal(refused.length, 1);
	assert.match(
		textOf(refused[0] as RpcAnswer),
		/30 requests are already waiting/,
	);
	assert.equal(requestRows(db).length, 30);
});

test("a request whose run couldn't start says so, and the 15-minute cron starts it again", async () => {
	const { db, env } = siteWith();
	github.answerWith(503);
	const answer = await callTool("add_papers", { ids: ["2507.11473"] }, env);
	assert.match(
		textOf(answer),
		/^Queued 1 paper\. The add run couldn't start yet; it will be retried within 15 minutes\. Tell the user to check the page in about 20 minutes\.$/,
	);
	assert.equal(requestRows(db).length, 1);
	github.answerWith(204);
	github.asked.length = 0;
	const requests = await workerModule<{
		retryAdds(cron: string, env: unknown): Promise<void>;
	}>("requests.ts");
	const logged = vi.spyOn(console, "log").mockImplementation(() => {});
	await requests.retryAdds("*/15 * * * *", env);
	logged.mockRestore();
	assert.equal(github.asked.length, 1);
	assert.match(
		github.asked[0]?.path ?? "",
		/\/workflows\/add\.yml\/dispatches$/,
	);
});

test("security: when GitHub refuses or can't be reached, the tool's answer and the crons' log lines are given without the dispatch token", async () => {
	const secret = `dispatch-${crypto.randomUUID()}`;
	const requests = await workerModule<{
		retryAdds(cron: string, env: unknown): Promise<void>;
	}>("requests.ts");
	const schedule = await workerModule<{
		runSchedule(cron: string, env: unknown): Promise<void>;
	}>("schedule.ts");
	// GitHub refusing with a body that quotes the token; a token holding a line break, which makes fetch throw with the
	// header's value in its message; and GitHub out of reach.
	github.answerWith(
		401,
		JSON.stringify({ message: "Bad credentials", secret }),
	);
	const cases = [
		{ api: github.origin, token: secret, reason: /GitHub answered 401$/ },
		{
			api: github.origin,
			token: `${secret}\nX-Other: 1`,
			reason: /GitHub couldn't be reached \(TypeError\)$/,
		},
		{
			api: "http://127.0.0.1:9",
			token: secret,
			reason: /GitHub couldn't be reached \(TypeError\)$/,
		},
	];
	for (const each of cases) {
		const env = workerEnv(access, migratedDatabase(), {
			GITHUB_API: each.api,
			GITHUB_DISPATCH_TOKEN: each.token,
		});
		const answer = await callTool("add_papers", { ids: ["2507.11473"] }, env);
		const logged: string[] = [];
		const spy = vi.spyOn(console, "log").mockImplementation((...parts) => {
			logged.push(parts.map(String).join(" "));
		});
		await requests.retryAdds("*/15 * * * *", env);
		await schedule.runSchedule("0 22 * * *", env);
		spy.mockRestore();
		for (const text of [
			JSON.stringify(answer.body),
			JSON.stringify(answer.log),
			...logged,
		]) {
			assert.ok(!text.includes(secret), `the token is in ${text}`);
		}
		assert.match(textOf(answer), /The add run couldn't start yet/);
		assert.equal(logged.length, 2);
		for (const reason of [
			answer.log,
			...logged.map((line) => JSON.parse(line)),
		]) {
			assert.match(reason.reason ?? "", each.reason);
		}
	}
});

test("the 15-minute cron asks GitHub nothing when no request waits, even with a request running for 5 minutes", async () => {
	const { db, env } = siteWith();
	insertRequest(db, "done-1", "done");
	insertRequest(db, "failed-1", "failed");
	insertRequest(
		db,
		"running-1",
		"running",
		new Date(Date.now() - 5 * 60_000).toISOString(),
	);
	const requests = await workerModule<{
		retryAdds(cron: string, env: unknown): Promise<void>;
	}>("requests.ts");
	const logged = vi.spyOn(console, "log").mockImplementation(() => {});
	await requests.retryAdds("*/15 * * * *", env);
	logged.mockRestore();
	assert.deepEqual(github.asked, []);
});

test("a request left running for 31 minutes is started again by the cron", async () => {
	const { db, env } = siteWith();
	insertRequest(
		db,
		"stuck-1",
		"running",
		new Date(Date.now() - 31 * 60_000).toISOString(),
	);
	const requests = await workerModule<{
		retryAdds(cron: string, env: unknown): Promise<void>;
	}>("requests.ts");
	const logged = vi.spyOn(console, "log").mockImplementation(() => {});
	await requests.retryAdds("*/15 * * * *", env);
	logged.mockRestore();
	assert.equal(github.asked.length, 1);
});

// ---- search and get_digest ----

let seq = 0;

// A stored entry: a paper or a news item, on `date`.
function seed(db: DatabaseSync, date: string, entry: JsonObject) {
	seq += 1;
	db.prepare(
		"INSERT INTO entries (id, date, seq, json, updated) VALUES (?, ?, ?, ?, ?)",
	).run(String(entry.id), date, seq, JSON.stringify(entry), NOW);
}

function aPaper(title: string, more: JsonObject = {}): JsonObject {
	const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
	return {
		id: `arxiv:${slug}`,
		type: "paper",
		title: title,
		authors: ["A. Author"],
		published: "2026-10-20",
		source: "arXiv",
		url: `https://arxiv.org/abs/${slug}`,
		abstract: "An abstract.",
		...more,
	};
}

function aNews(title: string): JsonObject {
	const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
	return {
		...NEWS,
		id: `url:https://example.com/${slug}`,
		title: title,
		url: `https://example.com/${slug}`,
	};
}

// The titles an answer shows, in order, found by their headings.
function titlesIn(text: string, titles: string[]): string[] {
	return titles
		.filter((title) => text.includes(title))
		.sort((a, b) => text.indexOf(a) - text.indexOf(b));
}

test("search finds only the entries that hold every word", async () => {
	const { db, env } = siteWith();
	seed(db, "2026-10-20", aPaper("Chain of Thought Monitorability"));
	seed(db, "2026-10-20", aPaper("Monitoring Reward Hacking in Agents"));
	const text = textOf(
		await callTool("search", { query: "monitorability chain" }, env),
	);
	assert.ok(text.includes("Chain of Thought Monitorability"), text);
	assert.equal(text.includes("Monitoring Reward Hacking"), false);
});

test("search matches a word in an author, in the owner's comment or in the owner's takeaway", async () => {
	const { db, env } = siteWith();
	seed(
		db,
		"2026-10-20",
		aPaper("Scientist AI", { authors: ["Yoshua Bengio"] }),
	);
	seed(db, "2026-10-20", aPaper("Quiet Paper"));
	seed(db, "2026-10-20", aPaper("Another Quiet Paper"));
	const store = await workerModule<{
		saveComments(
			db: unknown,
			change: unknown,
			count: typeof ignoreCost,
		): Promise<void>;
		saveTakeaway(
			db: unknown,
			change: unknown,
			count: typeof ignoreCost,
		): Promise<void>;
	}>("owner/store.ts");
	await store.saveComments(
		env.DB,
		{
			entryId: "arxiv:quiet-paper",
			thread: { id: "t1", field: null, passage: null, occurrence: null },
			save: [
				{
					id: "c1",
					text: "compare with the sleeper agents result",
					created: "2026-10-20T08:00:00.000Z",
					edited: null,
				},
			],
			delete: [],
		},
		ignoreCost,
	);
	await store.saveTakeaway(
		env.DB,
		{
			entryId: "arxiv:another-quiet-paper",
			save: {
				id: "k1",
				text: "a non-agentic predictor can still be a safety guard",
				question: null,
				created: "2026-10-20T08:00:00.000Z",
				edited: null,
			},
		},
		ignoreCost,
	);
	const byAuthor = textOf(await callTool("search", { query: "bengio" }, env));
	assert.ok(byAuthor.includes("Scientist AI"), byAuthor);
	assert.equal(byAuthor.includes("Quiet Paper"), false);
	const byComment = textOf(await callTool("search", { query: "sleeper" }, env));
	assert.ok(byComment.includes("Quiet Paper"), byComment);
	assert.equal(byComment.includes("Another Quiet Paper"), false);
	const byTakeaway = textOf(
		await callTool("search", { query: "predictor" }, env),
	);
	assert.ok(byTakeaway.includes("Another Quiet Paper"), byTakeaway);
});

test("a search that matches nothing says so", async () => {
	const { db, env } = siteWith();
	seed(db, "2026-10-20", aPaper("Scientist AI"));
	assert.equal(
		textOf(await callTool("search", { query: "zebrafish" }, env)),
		'No entry matches "zebrafish".',
	);
});

test("more than 20 matches show the newest 20, newest first, and say there are more", async () => {
	const { db, env } = siteWith();
	for (let day = 1; day <= 25; day++) {
		const date = `2026-09-${String(day).padStart(2, "0")}`;
		seed(db, date, aPaper(`Steering study ${String(day).padStart(2, "0")}`));
	}
	const text = textOf(await callTool("search", { query: "steering" }, env));
	const titles = Array.from(
		{ length: 25 },
		(_, k) => `Steering study ${String(k + 1).padStart(2, "0")}`,
	);
	const shown = titlesIn(text, titles);
	assert.deepEqual(shown, titles.slice(5).reverse());
	assert.match(text, /More entries match: add words to narrow the search/);
});

test("a search result shows the owner's marks and comments, and an untouched entry shows none", async () => {
	const { db, env } = siteWith();
	seed(db, "2026-10-20", aPaper("Scientist AI"));
	seed(db, "2026-10-20", aPaper("Scientist Plain"));
	const store = await workerModule<{
		saveRead(
			db: unknown,
			change: unknown,
			count: typeof ignoreCost,
		): Promise<void>;
		saveTags(
			db: unknown,
			change: unknown,
			count: typeof ignoreCost,
		): Promise<void>;
		saveFeedback(
			db: unknown,
			change: unknown,
			count: typeof ignoreCost,
		): Promise<void>;
		saveComments(
			db: unknown,
			change: unknown,
			count: typeof ignoreCost,
		): Promise<void>;
	}>("owner/store.ts");
	const id = "arxiv:scientist-ai";
	await store.saveRead(
		env.DB,
		{ id: id, depth: "paper", date: "2026-10-20" },
		ignoreCost,
	);
	await store.saveTags(env.DB, { id: id, tag: "toRead", on: true }, ignoreCost);
	await store.saveFeedback(
		env.DB,
		{ id: id, mark: "like", date: "2026-10-20" },
		ignoreCost,
	);
	await store.saveComments(
		env.DB,
		{
			entryId: id,
			thread: {
				id: "t1",
				field: "abstract",
				passage: "An abstract",
				occurrence: 1,
			},
			save: [
				{
					id: "c1",
					text: "compare with debate",
					created: "2026-10-20T08:00:00.000Z",
					edited: null,
				},
			],
			delete: [],
		},
		ignoreCost,
	);
	const text = textOf(await callTool("search", { query: "scientist" }, env));
	const parts = text.split("### ");
	const touched = parts.find((part) => part.startsWith("Scientist AI"));
	const plain = parts.find((part) => part.startsWith("Scientist Plain"));
	assert.ok(
		touched?.includes("read: paper (2026-10-20), tags: To read, liked"),
		text,
	);
	assert.ok(touched?.includes('On "An abstract" (abstract)'), text);
	assert.ok(touched?.includes("compare with debate"), text);
	assert.ok(plain, text);
	assert.equal(plain.includes("marks"), false, plain);
	assert.equal(plain.includes("comments"), false, plain);
});

test("search cuts a long abstract at 300 characters and marks it, and get_digest shows all of it", async () => {
	const { db, env } = siteWith();
	const abstract = `${"alpha ".repeat(230)}omega`;
	seed(db, "2026-10-20", aPaper("Scientist AI", { abstract: abstract }));
	const found = textOf(await callTool("search", { query: "scientist" }, env));
	assert.ok(found.includes(abstract.slice(0, 300)), found);
	assert.equal(found.includes(abstract), false);
	assert.match(found, /\[cut: \d+ characters in all/);
	const digest = textOf(
		await callTool("get_digest", { date: "2026-10-20" }, env),
	);
	assert.ok(digest.includes(abstract), "the digest holds the whole abstract");
});

test("security: an empty or too long search is refused with the reason and runs no database query", async () => {
	const refused: Record<string, [string, RegExp]> = {
		"an empty query": ["", /at least one word/],
		"only spaces": ["   ", /at least one word/],
		"201 characters": ["a".repeat(201), /at most 200 characters/],
		"eleven words": [
			Array.from({ length: 11 }, (_, k) => `w${k}`).join(" "),
			/at most 10 words/,
		],
		"a word of 49 bytes": ["a".repeat(49), /at most 48 bytes/],
	};
	for (const [name, [query, reason]] of Object.entries(refused)) {
		const answer = await callTool("search", { query: query });
		assert.equal(answer.body.result?.isError, true, name);
		assert.match(textOf(answer), reason, name);
		assert.equal(answer.log.queries, 0, name);
	}
});

test("security: a search of 200 characters, ten words and a word of 48 bytes is run", async () => {
	for (const query of [
		[39, 39, 39, 39, 40].map((length) => "a".repeat(length)).join(" "),
		Array.from({ length: 10 }, (_, k) => `w${k}`).join(" "),
		"a".repeat(48),
	]) {
		const answer = await callTool("search", { query: query });
		assert.notEqual(answer.body.result?.isError, true, query);
	}
});

test("a search whose query isn't text answers invalid params", async () => {
	const answer = await callTool("search", { query: 5 });
	assert.equal(answer.body.error?.code, INVALID_PARAMS);
	assert.equal(answer.body.error?.message, "query must be text");
});

test("a search that matches 300 entries, 200 of them with the owner's notes, runs at most 6 database queries", async () => {
	const { db, env } = siteWith();
	// One transaction, so the 800 inserts take milliseconds.
	db.exec("BEGIN");
	for (let k = 0; k < 300; k++) {
		const day = String((k % 30) + 1).padStart(2, "0");
		seed(db, `2026-10-${day}`, aPaper(`Steering study ${k}`));
	}
	for (let k = 0; k < 200; k++) {
		db.prepare(
			"INSERT INTO read_state (entry_id, depth, date) VALUES (?, 'abstract', '2026-10-20')",
		).run(`arxiv:steering-study-${k}`);
		db.prepare(
			"INSERT INTO threads (id, entry_id, created) VALUES (?, ?, ?)",
		).run(`t${k}`, `arxiv:steering-study-${k}`, NOW);
		db.prepare(
			"INSERT INTO comments (id, thread_id, text, created) VALUES (?, ?, 'a note', ?)",
		).run(`c${k}`, `t${k}`, NOW);
	}
	db.exec("COMMIT");
	let queries = 0;
	const request = new Request("https://ivan.wiryadi.com/liminal-space/mcp", {
		method: "POST",
		headers: JSON_HEADERS,
		body: message("tools/call", {
			name: "search",
			arguments: { query: "steering" },
		}),
	});
	const log: Log = {
		method: "POST",
		path: "/liminal-space/mcp",
		status: 0,
		queries: 0,
		rowsRead: 0,
		rowsWritten: 0,
	};
	const answer = await mcp.answerMcp(request, env, log, () => {
		queries += 1;
	});
	assert.equal(answer.status, 200);
	assert.ok(queries <= 6, `${queries} queries`);
});

test("security: the wildcards % and _ in a search word match only themselves", async () => {
	const { db, env } = siteWith();
	seed(db, "2026-10-20", aPaper("Scaling to 100% recall"));
	seed(db, "2026-10-20", aPaper("Sparse probes"));
	seed(db, "2026-10-20", aPaper("The reward_model gap"));
	seed(db, "2026-10-20", aPaper("The rewardXmodel gap"));
	const percent = textOf(await callTool("search", { query: "100%" }, env));
	assert.ok(percent.includes("Scaling to 100% recall"), percent);
	assert.equal(percent.includes("Sparse probes"), false);
	const underscore = textOf(
		await callTool("search", { query: "reward_model" }, env),
	);
	assert.ok(underscore.includes("The reward_model gap"), underscore);
	assert.equal(underscore.includes("rewardXmodel"), false);
});

test("get_digest gives a day's papers before its news, and the latest day when no date is given", async () => {
	const { db, env } = siteWith();
	seed(db, "2026-10-20", aNews("Hinton wins award"));
	seed(db, "2026-10-20", aPaper("Scientist AI"));
	seed(db, "2026-10-28", aPaper("Newest Paper"));
	const day = textOf(await callTool("get_digest", { date: "2026-10-20" }, env));
	assert.ok(
		day.indexOf("Scientist AI") < day.indexOf("Hinton wins award"),
		day,
	);
	assert.equal(day.includes("Newest Paper"), false);
	const latest = textOf(await callTool("get_digest", {}, env));
	assert.ok(latest.includes("Newest Paper"), latest);
	assert.equal(latest.includes("Scientist AI"), false);
});

test("get_digest on a day without a digest refuses and names the nearest days that have one", async () => {
	const { db, env } = siteWith();
	seed(db, "2026-10-18", aPaper("Before"));
	seed(db, "2026-10-21", aPaper("After"));
	const answer = await callTool("get_digest", { date: "2026-10-19" }, env);
	assert.equal(answer.body.result?.isError, true);
	const text = textOf(answer);
	assert.ok(text.includes("There is no digest on 2026-10-19"), text);
	assert.ok(text.includes("2026-10-18"), text);
	assert.ok(text.includes("2026-10-21"), text);
});

test("get_digest refuses a date that isn't YYYY-MM-DD", async () => {
	const answer = await callTool("get_digest", { date: "20 October" });
	assert.equal(answer.body.result?.isError, true);
	assert.match(textOf(answer), /2026-10-20/);
});

test("a digest whose Markdown passes 60 KB is cut after a whole entry and says how many were left out", async () => {
	const { db, env } = siteWith();
	for (let k = 0; k < 40; k++) {
		seed(
			db,
			"2026-10-20",
			aPaper(`Long paper ${k}`, { abstract: "word ".repeat(400) }),
		);
	}
	const text = textOf(
		await callTool("get_digest", { date: "2026-10-20" }, env),
	);
	assert.ok(new TextEncoder().encode(text).length <= 60 * 1024);
	assert.match(text, /\d+ (more )?entr(y|ies)[^\n]*left out/i);
});
