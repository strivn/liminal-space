// The Worker's body reading and answers (worker/src/respond.ts), and what each body-reading route answers to a body it
// can't use, through the real Worker.
import assert from "node:assert/strict";
import type http from "node:http";
import { afterAll, beforeAll, test } from "vitest";
import {
	MAX_MCP_BODY_BYTES,
	MAX_REQUEST_UPDATE_BYTES,
} from "../../shared/connector-protocol.ts";
import {
	MAX_LOG_BODY_EXTRA,
	MAX_LOG_BYTES,
} from "../../shared/log-protocol.ts";
import { MAX_OWNER_BODY_BYTES } from "../../shared/owner-protocol.ts";
import { MAX_BODY_BYTES } from "../../shared/push-protocol.ts";
import {
	type Cloud,
	connectorToken,
	firstKey,
	requestLogs,
	signToken,
	startCloud,
	startWorker,
	stopCloud,
	syncClaims,
} from "../support/cloud.ts";
import { ownerHeaders } from "../support/owner.ts";
import { type RespondModule, workerModule } from "./owner-worker.ts";

// Who a route's token is for: the sync service token, the owner's page, or the claude.ai connector.
type Caller = "sync" | "owner" | "connector";

// A body-reading route: its path, who calls it, its body limit, and a body that parses but fails its own check.
type Route = {
	path: string;
	caller: Caller;
	maxBytes: number;
	invalid: string;
};

const OWNER_CHANGE = (name: string): Route => ({
	path: `/liminal-space/api/owner/${name}`,
	caller: "owner",
	maxBytes: MAX_OWNER_BODY_BYTES,
	invalid: "[]",
});

const ROUTES: Route[] = [
	{
		path: "/liminal-space/api/sync/push",
		caller: "sync",
		maxBytes: MAX_BODY_BYTES,
		invalid: "{}",
	},
	{
		path: "/liminal-space/api/sync/requests",
		caller: "sync",
		maxBytes: MAX_REQUEST_UPDATE_BYTES,
		invalid: "[]",
	},
	{
		path: "/liminal-space/api/sync/logs",
		caller: "sync",
		maxBytes: MAX_LOG_BYTES + MAX_LOG_BODY_EXTRA,
		invalid: "[]",
	},
	{
		path: "/liminal-space/mcp",
		caller: "connector",
		maxBytes: MAX_MCP_BODY_BYTES,
		invalid: "[]",
	},
	OWNER_CHANGE("takeaways"),
	OWNER_CHANGE("read"),
	OWNER_CHANGE("tags"),
	OWNER_CHANGE("feedback"),
	OWNER_CHANGE("comments"),
	OWNER_CHANGE("push"),
	{
		path: "/liminal-space/api/owner/ask",
		caller: "owner",
		maxBytes: MAX_OWNER_BODY_BYTES,
		invalid: "{}",
	},
];

// The four bodies a route can't use.
type Problem = "one byte over" | "not JSON" | "bad UTF-8" | "fails the check";
const PROBLEMS: Problem[] = [
	"one byte over",
	"not JSON",
	"bad UTF-8",
	"fails the check",
];

// One route's answer to one problem: status, text, the headers a client reads, and the reason the log line keeps.
type Row = {
	path: string;
	problem: Problem;
	status: number;
	body: string;
	contentType: string | null;
	cacheControl: string | null;
	reason: string | undefined;
};

const TEXT = "text/plain;charset=UTF-8";
const JSON_TYPE = "application/json";

// What each route answers today, row by row.
function expected(
	path: string,
	problem: Problem,
	status: number,
	body: string,
	reason: string,
	contentType = TEXT,
	cacheControl: string | null = null,
): Row {
	return {
		path: path,
		problem: problem,
		status: status,
		body: body,
		contentType: contentType,
		cacheControl: cacheControl,
		reason: reason,
	};
}

// A JSON-RPC error with no id, as the mcp route answers a body it can't read.
function rpcError(code: number, message: string): string {
	return JSON.stringify({
		jsonrpc: "2.0",
		id: null,
		error: { code: code, message: message },
	});
}

// The owner change routes answer a body too large with 413 "too large", and every other problem with 400 and the
// reason as text.
function ownerChangeRows(name: string, invalidReason: string): Row[] {
	const path = `/liminal-space/api/owner/${name}`;
	const tooLarge = `body is larger than ${MAX_OWNER_BODY_BYTES} bytes`;
	return [
		expected(path, "one byte over", 413, "too large", tooLarge),
		expected(path, "not JSON", 400, "body is not JSON", "body is not JSON"),
		expected(path, "bad UTF-8", 400, "body is not JSON", "body is not JSON"),
		expected(path, "fails the check", 400, invalidReason, invalidReason),
	];
}

const PUSH = "/liminal-space/api/sync/push";
const REQUESTS = "/liminal-space/api/sync/requests";
const LOGS = "/liminal-space/api/sync/logs";
const MCP = "/liminal-space/mcp";
const ASK = "/liminal-space/api/owner/ask";
const ASK_IDS = "body is not an entry id and a thread id";

const TABLE: Row[] = [
	expected(
		PUSH,
		"one byte over",
		413,
		"too large",
		`body is larger than ${MAX_BODY_BYTES} bytes`,
	),
	expected(PUSH, "not JSON", 400, "bad request", "body is not JSON"),
	expected(PUSH, "bad UTF-8", 400, "bad request", "body is not JSON"),
	expected(
		PUSH,
		"fails the check",
		400,
		"bad request",
		'body has no "entries" list',
	),
	expected(
		REQUESTS,
		"one byte over",
		413,
		"too large",
		`body is larger than ${MAX_REQUEST_UPDATE_BYTES} bytes`,
	),
	expected(REQUESTS, "not JSON", 400, "body is not JSON", "body is not JSON"),
	expected(REQUESTS, "bad UTF-8", 400, "body is not JSON", "body is not JSON"),
	expected(
		REQUESTS,
		"fails the check",
		400,
		"body is not an object",
		"body is not an object",
	),
	expected(
		LOGS,
		"one byte over",
		413,
		"too large",
		`body is larger than ${MAX_LOG_BYTES + MAX_LOG_BODY_EXTRA} bytes`,
	),
	expected(LOGS, "not JSON", 400, "body is not JSON", "body is not JSON"),
	expected(LOGS, "bad UTF-8", 400, "body is not JSON", "body is not JSON"),
	expected(
		LOGS,
		"fails the check",
		400,
		"body is not a JSON object",
		"body is not a JSON object",
	),
	expected(
		MCP,
		"one byte over",
		413,
		"too large",
		`body is larger than ${MAX_MCP_BODY_BYTES} bytes`,
	),
	expected(
		MCP,
		"not JSON",
		400,
		rpcError(-32700, "body is not JSON"),
		"body is not JSON",
		JSON_TYPE,
		"no-store",
	),
	expected(
		MCP,
		"bad UTF-8",
		400,
		rpcError(-32700, "body is not JSON"),
		"body is not JSON",
		JSON_TYPE,
		"no-store",
	),
	expected(
		MCP,
		"fails the check",
		400,
		rpcError(-32600, "body is not one JSON-RPC message"),
		"body is not one JSON-RPC message",
		JSON_TYPE,
		"no-store",
	),
	...ownerChangeRows("takeaways", "body is not an object"),
	...ownerChangeRows("read", "body is not an object"),
	...ownerChangeRows("tags", "body is not an object"),
	...ownerChangeRows("feedback", "body is not an object"),
	...ownerChangeRows("comments", "body is not an object"),
	...ownerChangeRows("push", "body is not a push subscription"),
	expected(
		ASK,
		"one byte over",
		413,
		"body is too large",
		"body is too large",
		TEXT,
		"no-store",
	),
	expected(
		ASK,
		"not JSON",
		400,
		"body is not JSON",
		"body is not JSON",
		TEXT,
		"no-store",
	),
	expected(
		ASK,
		"bad UTF-8",
		400,
		"body is not JSON",
		"body is not JSON",
		TEXT,
		"no-store",
	),
	expected(ASK, "fails the check", 400, ASK_IDS, ASK_IDS, TEXT, "no-store"),
];

let cloud: Cloud;
let server: http.Server;

beforeAll(async () => {
	const started = await startCloud();
	cloud = started.cloud;
	server = started.server;
	await startWorker(cloud);
});

afterAll(async () => {
	await stopCloud(cloud, server);
});

// The headers a caller's request carries once Access let it through.
async function callerHeaders(caller: Caller): Promise<Record<string, string>> {
	if (caller === "owner") {
		return ownerHeaders(cloud);
	}
	if (caller === "connector") {
		return {
			"Content-Type": "application/json",
			"Cf-Access-Jwt-Assertion": await connectorToken(cloud),
		};
	}
	return {
		"Content-Type": "application/json",
		"Cf-Access-Jwt-Assertion": await signToken(
			firstKey(cloud),
			syncClaims(cloud),
		),
	};
}

// The bytes of each problem body for a route: valid JSON one byte over the limit, text that isn't JSON, JSON with a
// byte that isn't UTF-8, and JSON the route's own check refuses.
function problemBody(route: Route, problem: Problem): Uint8Array<ArrayBuffer> {
	const encoder = new TextEncoder();
	if (problem === "one byte over") {
		const padding = "x".repeat(route.maxBytes + 1 - '{"pad":""}'.length);
		return encoder.encode(JSON.stringify({ pad: padding }));
	}
	if (problem === "not JSON") {
		return encoder.encode("{not json");
	}
	if (problem === "bad UTF-8") {
		return Uint8Array.from([
			0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d,
		]);
	}
	return encoder.encode(route.invalid);
}

// Send one problem body to one route and read the answer and its log line back as a row.
async function answerRow(route: Route, problem: Problem): Promise<Row> {
	if (cloud.workerUrl === null) {
		throw new Error("the Worker has no URL");
	}
	const logsBefore = requestLogs(cloud).length;
	const answer = await fetch(cloud.workerUrl + route.path, {
		method: "POST",
		headers: await callerHeaders(route.caller),
		body: problemBody(route, problem),
	});
	const body = await answer.text();
	const logs = requestLogs(cloud).slice(logsBefore);
	assert.equal(logs.length, 1, `one log line for ${route.path}`);
	const line = logs[0];
	let reason: string | undefined;
	if (line !== undefined) {
		reason = line.reason;
	}
	return {
		path: route.path,
		problem: problem,
		status: answer.status,
		body: body,
		contentType: answer.headers.get("content-type"),
		cacheControl: answer.headers.get("cache-control"),
		reason: reason,
	};
}

test("each route that reads a body answers the four kinds of bad body with the status, text and headers listed for it", async () => {
	const rows: Row[] = [];
	// One request at a time: each row reads the log line its own request wrote.
	for (const route of ROUTES) {
		for (const problem of PROBLEMS) {
			rows.push(await answerRow(route, problem));
		}
	}
	assert.deepEqual(rows, TABLE);
});

// A POST whose body is these bytes.
function postOf(body: string | Uint8Array<ArrayBuffer>): Request {
	return new Request("https://example.com/", { method: "POST", body: body });
}

// Whether `error` is respond.ts's BodyProblem with this status and message.
function isProblem(
	respond: RespondModule,
	error: unknown,
	status: number,
	message: string,
): boolean {
	assert.ok(error instanceof respond.BodyProblem, String(error));
	assert.equal(error.status, status);
	assert.equal(error.message, message);
	return true;
}

test("a JSON body within the size limit is read as the parsed object", async () => {
	const respond = await workerModule<RespondModule>("respond.ts");
	const text = JSON.stringify({ id: "arxiv:2601.00001", on: true });
	assert.deepEqual(await respond.readJson(postOf(text), text.length), {
		id: "arxiv:2601.00001",
		on: true,
	});
});

test("security: a body one byte over the size limit is refused with 413 naming the limit", async () => {
	const respond = await workerModule<RespondModule>("respond.ts");
	const text = JSON.stringify({ pad: "xxxx" });
	await assert.rejects(
		respond.readJson(postOf(text), text.length - 1),
		(error) =>
			isProblem(
				respond,
				error,
				413,
				`body is larger than ${text.length - 1} bytes`,
			),
	);
});

test("a body that isn't JSON, or isn't valid UTF-8, is refused with 400 'body is not JSON'", async () => {
	const respond = await workerModule<RespondModule>("respond.ts");
	const badUtf8 = Uint8Array.from([0x22, 0xff, 0x22]);
	for (const body of ["{not json", badUtf8]) {
		await assert.rejects(respond.readJson(postOf(body), 100), (error) =>
			isProblem(respond, error, 400, "body is not JSON"),
		);
	}
});

test("security: a JSON answer carries Cache-Control: no-store", async () => {
	const respond = await workerModule<RespondModule>("respond.ts");
	const answer = respond.json({ ok: true }, 201);
	assert.equal(answer.status, 201);
	assert.equal(answer.headers.get("cache-control"), "no-store");
	assert.deepEqual(await answer.json(), { ok: true });
});
