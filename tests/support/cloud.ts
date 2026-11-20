// The cloud harness: the real Worker in Cloudflare's local runtime
// (wrangler's createTestHarness reads wrangler.jsonc and gives each harness its own in-memory D1), and a stand-in for
// Cloudflare Access on 127.0.0.1. The stand-in publishes test signing keys at /cdn-cgi/access/certs, where the Worker
// fetches them (ACCESS_TEAM_DOMAIN points at it), and stands in front of the Worker for sync.ts as Access does: it checks
// the service token, signs a sync token and forwards the request. Each test file starts its own of each.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { JWK, JWTPayload } from "jose";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { TestHarness } from "wrangler";
import { createTestHarness } from "wrangler";
import type { JsonObject } from "../../shared/narrow.ts";
import { isJsonObject } from "../../shared/narrow.ts";
import {
	createPushService,
	newVapidKeys,
	type PushService,
} from "../fixtures/web-push-device.ts";

const ROOT = path.join(import.meta.dirname, "..", "..");

// Test values the Worker gets in place of the real Access apps': the sync app's audience, the owner app's audience, the
// mcp app's audience (the connector), service token "sync"'s client ID and secret, and the owner's login email (a Worker
// secret in production). The secret is random, so a message that shows it can't pass by chance.
const SYNC_AUD = "test-sync-audience";
const OWNER_AUD = "test-owner-audience";
const MCP_AUD = "test-mcp-audience";
const SYNC_CLIENT_ID = "test-sync-client.access";
const SYNC_CLIENT_SECRET = `SECRET-${crypto.randomBytes(12).toString("hex")}`;
export const OWNER_EMAIL = "owner@example.com";

// The push route, the one route sync.ts posts to.
const PUSH_PATH = "/liminal-space/api/sync/push";

// The Worker secret GITHUB_DISPATCH_TOKEN as the tests give it: a made-up value whose random part can't show up in a
// log by chance.
const GITHUB_DISPATCH_TOKEN = `test-dispatch-${crypto.randomBytes(12).toString("hex")}`;

// The Worker secrets VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY as the tests give them: a pair made once per process.
const VAPID_KEYS = newVapidKeys();
const VAPID_PUBLIC_KEY = VAPID_KEYS.publicKey;
const VAPID_PRIVATE_KEY = VAPID_KEYS.privateKey;

// Where the stand-in for GitHub's API listens on the stand-in's server: every path under /repos/. The Worker's
// GITHUB_API points at the server itself, as GitHub's API is "https://api.github.com" with paths like /repos/....
const GITHUB_API_PREFIX = "/repos/";
// Where the stand-in for the push services listens on the same server: every path under /wpush/, the path a test
// device's endpoint on a real push service host has. The Worker's PUSH_SERVICE_ORIGIN points at the server.
const PUSH_PREFIX = "/wpush/";

// One request the Worker made to the stand-in for GitHub's API: method, path, headers (names in lower case) and body.
type GithubRequest = {
	method: string;
	path: string;
	headers: http.IncomingHttpHeaders;
	body: string;
};

// Where the stand-in for Anthropic's API listens on the stand-in's server: every path under /v1/. The Worker's
// ANTHROPIC_API points at the server itself, as Anthropic's API is "https://api.anthropic.com" with paths like
// /v1/messages.
const ANTHROPIC_API_PREFIX = "/v1/";

// One request the Worker made to the stand-in for Anthropic's API: method, path, headers (names in lower case) and
// the JSON body it sent (null when the body was no JSON).
type AnthropicRequest = {
	method: string;
	path: string;
	headers: http.IncomingHttpHeaders;
	body: unknown;
};

// A point in an answer where the stand-in stops until a test lets it go on: `reached` settles when the stand-in is
// about to send piece number `atPiece` (counted from 0), `release` lets it send that piece and the rest.
export type Gate = {
	atPiece: number;
	reached: Promise<void>;
	markReached: () => void;
	released: Promise<void>;
	release: () => void;
};

// A gate before piece `atPiece` of an answer.
export function makeGate(atPiece: number): Gate {
	let markReached = () => {};
	let release = () => {};
	const reached = new Promise<void>((resolve) => {
		markReached = resolve;
	});
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	return {
		atPiece: atPiece,
		reached: reached,
		markReached: markReached,
		released: released,
		release: release,
	};
}

// What the stand-in for Anthropic's API answers every request with. "text": a streamed reply sent in `pieces` (each
// piece one text delta), stopping at `gate` when there is one; a gate at piece number `pieces.length` holds the
// answer's end. "cut": the pieces, then an overloaded_error event in place of the end, as the API sends when it
// fails mid-stream. "error": the HTTP status and error body of a request the API refuses before it streams anything,
// with the stable `error_code` some of them carry in `details`. "turns": one answer per request, in order (the last
// repeats), each a list of content blocks and the stop reason the answer ends with.
export type AnthropicBlock =
	| { type: "text"; text: string }
	| { type: "server_tool_use"; name: "web_search" | "web_fetch" };
export type AnthropicTurn = {
	blocks: AnthropicBlock[];
	stopReason: "end_turn" | "pause_turn";
};
export type AnthropicAnswer =
	| { kind: "text" | "cut"; pieces: string[]; gate: Gate | null }
	| { kind: "turns"; turns: AnthropicTurn[] }
	| {
			kind: "error";
			status: number;
			type: string;
			message: string;
			code?: string;
	  };

// A key pair the stand-in for Access can sign with, and its public half as a JWK with its key id.
export type SigningKey = {
	kid: string;
	privateKey: CryptoKey;
	publicKey: CryptoKey;
	jwk: JWK;
};

// One request that arrived at the stand-in's front door (key fetches aren't counted here): its method and path, its
// body's size in bytes, the entries it carried (null when the body held no entries list), the status it was answered
// with (null until then), and who answered: the stand-in itself, as Access, or the Worker behind it.
type SiteRequest = {
	method: string;
	path: string;
	bytes: number;
	items: unknown[] | null;
	status: number | null;
	answeredBy: "access" | "worker" | null;
};

// The Worker's one JSON log line per request, as worker/src/env.ts's RequestLog states it. Copied, not imported:
// the Worker's files use Cloudflare's runtime types, which the tests' type check doesn't load.
export type RequestLog = {
	method: string;
	path: string;
	status: number;
	reason?: string;
	queries: number;
	rowsRead: number;
	rowsWritten: number;
};

// The parts of the D1 binding the tests use. Typed here for the same reason as RequestLog.
type D1Result = {
	results: unknown[];
	meta: { rows_read: number; rows_written: number; changes: number };
};
type D1Statement = {
	bind(...values: unknown[]): D1Statement;
	all(): Promise<D1Result>;
	run(): Promise<D1Result>;
};
export type D1 = {
	prepare(query: string): D1Statement;
	batch(statements: D1Statement[]): Promise<D1Result[]>;
};

// What the stand-in answers in place of the Worker: `status` to the first `first` requests from now on, or to every
// request when `first` is null; `answered` counts how many it has answered so.
type AccessAnswer = {
	status: number;
	first: number | null;
	answered: number;
};

// Entries the stand-in for Access answers as refused when a push reaches it, without passing them on to the Worker: their
// ids as the entries hold them ("arxiv:2610.00002") and the problem the refusal names.
type PushRefusal = { ids: string[]; problem: string };

// One test's cloud: the stand-in for Access (its URL, the keys it publishes, how often the Worker fetched them, the
// status it answers key fetches with, what it answers in place of the Worker, the requests at its front door), how the
// Worker is set up before it starts (its key-fetch cooldown, null = the Worker's default; the site's origin, null =
// wrangler.jsonc's; the folder its D1 migrations come from, null = wrangler.jsonc's), the requests the stand-in for
// Cloudflare's D1 API received and the status it answers every one of them with (null = run the query), the status the
// stand-in for GitHub's API answers with and the requests it received, the Anthropic key the Worker is given (null = none,
// as on staging) and what the stand-in for Anthropic's API answers with and the requests it received, its start once
// begun, and, once started, the Worker's harness, URL and D1 binding.
export type Cloud = {
	accessUrl: string;
	published: SigningKey[];
	keyFetches: number;
	keysStatus: number;
	accessAnswer: AccessAnswer | null;
	requests: SiteRequest[];
	cooldownSeconds: string | null;
	siteOrigin: string | null;
	assetsDir: string | null;
	migrationsDir: string | null;
	environment: string | null;
	apiRequests: ApiRequest[];
	apiStatus: number | null;
	githubStatus: number;
	githubRequests: GithubRequest[];
	anthropicKey: string | null;
	anthropicAnswer: AnthropicAnswer;
	anthropicRequests: AnthropicRequest[];
	// The stand-in for the push services, at PUSH_PREFIX on the same server.
	push: PushService;
	pushRefusal: PushRefusal | null;
	tempDirs: string[];
	starting: Promise<void> | null;
	harness: TestHarness | null;
	workerUrl: string | null;
	db: D1 | null;
};

// What one request to the Worker came back with: status, body text, and the Allow and X-Content-Type-Options headers
// (null without one).
export type Answer = {
	status: number;
	body: string;
	allow: string | null;
	contentTypeOptions: string | null;
};

// =====================================================================================================
// Signing keys and tokens
// =====================================================================================================

// A fresh RSA key pair for RS256 under key id `kid`.
async function makeSigningKey(kid: string): Promise<SigningKey> {
	const pair = await generateKeyPair("RS256", { extractable: true });
	const jwk = await exportJWK(pair.publicKey);
	jwk.kid = kid;
	jwk.alg = "RS256";
	jwk.use = "sig";
	return {
		kid: kid,
		privateKey: pair.privateKey,
		publicKey: pair.publicKey,
		jwk: jwk,
	};
}

// Seconds since 1970, as JWT times count.
function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

// The claims of the token Access gives a request that carried service token "sync": the sync app's audience, the
// stand-in as issuer, the client ID as common_name, valid from now for an hour, and no email.
export function syncClaims(cloud: Cloud): JWTPayload {
	const now = nowSeconds();
	return {
		aud: [SYNC_AUD],
		iss: cloud.accessUrl,
		common_name: SYNC_CLIENT_ID,
		type: "app",
		sub: "",
		iat: now,
		nbf: now,
		exp: now + 3600,
	};
}

// The claims of the owner's login token as Access signs it for the owner app: the owner app's audience and the owner's
// email. `email` replaces the owner's, for a token of someone else.
export function ownerClaims(cloud: Cloud, email: string): JWTPayload {
	const claims = loginClaims(cloud, email);
	claims.aud = [OWNER_AUD];
	return claims;
}

// The claims of the token Access signs for a claude.ai connector: the mcp app's audience and the owner app's.
function connectorClaims(cloud: Cloud, email: string): JWTPayload {
	const claims = loginClaims(cloud, email);
	claims.aud = [MCP_AUD, OWNER_AUD];
	return claims;
}

// The headers of a browser's request to an owner route once Access let it through: the login token in
// Cf-Access-Jwt-Assertion, and the same token in the CF_Authorization cookie that Access sets in the browser. A
// connector sends the header only.
export function browserHeaders(token: string): {
	"Cf-Access-Jwt-Assertion": string;
	Cookie: string;
} {
	return {
		"Cf-Access-Jwt-Assertion": token,
		Cookie: `CF_Authorization=${token}`,
	};
}

// The claims of a person's login token: an email and a user id instead of common_name.
function loginClaims(cloud: Cloud, email: string): JWTPayload {
	const now = nowSeconds();
	return {
		aud: [SYNC_AUD],
		iss: cloud.accessUrl,
		email: email,
		type: "app",
		sub: "5c3b8a3e-0d7d-4b1e-9a51-0b7f0c1e2d3f",
		country: "ID",
		iat: now,
		nbf: now,
		exp: now + 3600,
	};
}

// An RS256 token with these claims, signed by `key` and naming its kid.
export function signToken(
	key: SigningKey,
	claims: JWTPayload,
): Promise<string> {
	return new SignJWT(claims)
		.setProtectedHeader({ alg: "RS256", kid: key.kid, typ: "JWT" })
		.sign(key.privateKey);
}

// The key the stand-in signs sync tokens with: the first one it published.
export function firstKey(cloud: Cloud): SigningKey {
	const key = cloud.published[0];
	if (key === undefined) {
		throw new Error("the stand-in for Access publishes no key");
	}
	return key;
}

// A connector's token for the owner's email, as Access signs it for the mcp app.
export function connectorToken(cloud: Cloud): Promise<string> {
	return signToken(firstKey(cloud), connectorClaims(cloud, OWNER_EMAIL));
}

// =====================================================================================================
// The stand-in for Access
// =====================================================================================================

// The whole body of a request, as bytes.
function readBody(request: http.IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => resolve(Buffer.concat(chunks)));
		request.on("error", reject);
	});
}

// The entries list a push body carried, or null when it isn't JSON with one.
function itemsOf(body: Buffer): unknown[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body.toString("utf8"));
	} catch {
		return null;
	}
	if (!isJsonObject(parsed) || !Array.isArray(parsed.entries)) {
		return null;
	}
	return parsed.entries;
}

// A header's one value, or "" when it is missing.
function headerValue(request: http.IncomingMessage, name: string): string {
	const value = request.headers[name];
	if (typeof value === "string") {
		return value;
	}
	return "";
}

// Answer the Worker's key fetch: the published keys as Access serves them, or cloud.keysStatus.
function answerKeyFetch(cloud: Cloud, response: http.ServerResponse): void {
	cloud.keyFetches += 1;
	if (cloud.keysStatus !== 200) {
		response.writeHead(cloud.keysStatus);
		response.end();
		return;
	}
	const keys = cloud.published.map((key) => key.jwk);
	response.writeHead(200, { "Content-Type": "application/json" });
	response.end(JSON.stringify({ keys: keys }));
}

// The status the stand-in answers this front-door request with in place of the Worker, or null to let it through:
// what cloud.accessAnswer says, or 403 when the request lacks the test service token, as Access refuses it.
function accessRefusal(
	cloud: Cloud,
	request: http.IncomingMessage,
): number | null {
	const told = cloud.accessAnswer;
	if (told !== null && (told.first === null || told.answered < told.first)) {
		told.answered += 1;
		return told.status;
	}
	const id = headerValue(request, "cf-access-client-id");
	const secret = headerValue(request, "cf-access-client-secret");
	if (id !== SYNC_CLIENT_ID || secret !== SYNC_CLIENT_SECRET) {
		return 403;
	}
	return null;
}

// A push body with the entries that cloud.pushRefusal names taken out, and where they sat.
type Withheld = { kept: Buffer; at: Map<number, string>; total: number };

// The id of a push item's entry, or null when it holds none.
function entryIdOf(item: unknown): string | null {
	if (isJsonObject(item) && isJsonObject(item.entry)) {
		if (typeof item.entry.id === "string") {
			return item.entry.id;
		}
	}
	return null;
}

// Take the refused entries out of a push body, so the Worker never stores them; null when the request is no push or
// holds none of them.
function withholdRefused(
	cloud: Cloud,
	logged: SiteRequest,
	body: Buffer,
): Withheld | null {
	const refusal = cloud.pushRefusal;
	if (
		refusal === null ||
		logged.method !== "POST" ||
		logged.path !== PUSH_PATH
	) {
		return null;
	}
	const items = itemsOf(body);
	if (items === null) {
		return null;
	}
	const kept: unknown[] = [];
	const at = new Map<number, string>();
	items.forEach((item, index) => {
		const id = entryIdOf(item);
		if (id !== null && refusal.ids.includes(id)) {
			at.set(index, id);
		} else {
			kept.push(item);
		}
	});
	if (at.size === 0) {
		return null;
	}
	const text = JSON.stringify({ entries: kept });
	return { kept: Buffer.from(text), at: at, total: items.length };
}

// The Worker's answer to the entries that were kept, with a "refused" result put back where each withheld entry sat; the
// answer unchanged when it isn't a list of results.
function withRefusals(
	refusal: PushRefusal,
	withheld: Withheld,
	answerBody: Buffer,
): Buffer {
	let parsed: unknown = null;
	try {
		parsed = JSON.parse(answerBody.toString("utf8"));
	} catch {
		return answerBody;
	}
	if (!isJsonObject(parsed) || !Array.isArray(parsed.results)) {
		return answerBody;
	}
	const results: unknown[] = [];
	let next = 0;
	for (let index = 0; index < withheld.total; index++) {
		const id = withheld.at.get(index);
		if (id === undefined) {
			results.push(parsed.results[next]);
			next += 1;
		} else {
			results.push({
				id: id,
				outcome: "refused",
				problems: [refusal.problem],
			});
		}
	}
	return Buffer.from(JSON.stringify({ results: results }));
}

// Handle one front-door request: record it, then answer it as Access would, or sign a sync token and pass the request
// to the Worker with the token in Cf-Access-Jwt-Assertion, and send back the Worker's answer.
async function answerFrontDoor(
	cloud: Cloud,
	request: http.IncomingMessage,
	response: http.ServerResponse,
): Promise<void> {
	const body = await readBody(request);
	const logged: SiteRequest = {
		method: request.method || "",
		path: request.url || "",
		bytes: body.length,
		items: itemsOf(body),
		status: null,
		answeredBy: null,
	};
	cloud.requests.push(logged);

	const refusal = accessRefusal(cloud, request);
	if (refusal !== null) {
		logged.status = refusal;
		logged.answeredBy = "access";
		response.writeHead(refusal, { "Content-Type": "text/plain" });
		response.end("refused by the stand-in for Access");
		return;
	}
	if (cloud.workerUrl === null) {
		throw new Error("a request reached the stand-in before the Worker started");
	}

	// The body is passed on as bytes, so the Worker sees exactly what sync.ts sent.
	const token = await signToken(firstKey(cloud), syncClaims(cloud));
	const headers: Record<string, string> = { "Cf-Access-Jwt-Assertion": token };
	const type = headerValue(request, "content-type");
	if (type !== "") {
		headers["Content-Type"] = type;
	}
	const init: RequestInit = { method: logged.method, headers: headers };
	// A push holding an entry the site was told to refuse goes on without it; its refusal is added to the answer below.
	const withheld = withholdRefused(cloud, logged, body);
	if (logged.method !== "GET" && logged.method !== "HEAD") {
		if (withheld === null) {
			init.body = Uint8Array.from(body);
		} else {
			init.body = Uint8Array.from(withheld.kept);
		}
	}
	const answer = await fetch(cloud.workerUrl + logged.path, init);
	let answerBody: Buffer = Buffer.from(await answer.arrayBuffer());
	if (
		withheld !== null &&
		cloud.pushRefusal !== null &&
		answer.status === 200
	) {
		answerBody = withRefusals(cloud.pushRefusal, withheld, answerBody);
	}
	logged.status = answer.status;
	logged.answeredBy = "worker";
	response.writeHead(answer.status, {
		"Content-Type": answer.headers.get("content-type") || "text/plain",
	});
	response.end(answerBody);
}

// Answer the Worker's request to GitHub's API: record it, then answer 204 with no body for a dispatch it accepts, or
// cloud.githubStatus with GitHub's JSON error body.
async function answerGithub(
	cloud: Cloud,
	request: http.IncomingMessage,
	response: http.ServerResponse,
): Promise<void> {
	const body = await readBody(request);
	cloud.githubRequests.push({
		method: request.method || "",
		path: request.url || "",
		headers: request.headers,
		body: body.toString("utf8"),
	});
	if (cloud.githubStatus === 204) {
		response.writeHead(204);
		response.end();
		return;
	}
	response.writeHead(cloud.githubStatus, {
		"Content-Type": "application/json",
	});
	response.end(
		JSON.stringify({
			message: "Bad credentials",
			documentation_url: "https://docs.github.com/rest",
			status: String(cloud.githubStatus),
		}),
	);
}

// One server-sent event, as the Messages API writes it: the event's name and its JSON data.
function sseEvent(name: string, data: unknown): string {
	return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

// Stream one turn's blocks in the API's event order: a text block is one text delta; a server tool call carries an empty
// input, as web search and web fetch calls do in the API's streams.
function writeTurn(response: http.ServerResponse, turn: AnthropicTurn): void {
	response.write(
		sseEvent("message_start", {
			type: "message_start",
			message: {
				id: "msg_standin",
				type: "message",
				role: "assistant",
				content: [],
				model: "claude-sonnet-5-5",
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 25, output_tokens: 1 },
			},
		}),
	);
	for (const [index, block] of turn.blocks.entries()) {
		if (block.type === "text") {
			response.write(
				sseEvent("content_block_start", {
					type: "content_block_start",
					index: index,
					content_block: { type: "text", text: "" },
				}),
			);
			response.write(
				sseEvent("content_block_delta", {
					type: "content_block_delta",
					index: index,
					delta: { type: "text_delta", text: block.text },
				}),
			);
		} else {
			response.write(
				sseEvent("content_block_start", {
					type: "content_block_start",
					index: index,
					content_block: {
						type: "server_tool_use",
						id: `srvtoolu_standin${index}`,
						name: block.name,
						input: {},
					},
				}),
			);
		}
		response.write(
			sseEvent("content_block_stop", {
				type: "content_block_stop",
				index: index,
			}),
		);
	}
	response.write(
		sseEvent("message_delta", {
			type: "message_delta",
			delta: { stop_reason: turn.stopReason, stop_sequence: null },
			usage: { output_tokens: 15 },
		}),
	);
	response.write(sseEvent("message_stop", { type: "message_stop" }));
	response.end();
}

// Stand in for Anthropic's Messages API: record the request, then answer as cloud.anthropicAnswer says. A reply is
// streamed in the API's event order (message_start, content_block_start, ping, content_block_delta per piece,
// content_block_stop, message_delta, message_stop), as platform.claude.com/docs/en/build-with-claude/streaming shows.
async function answerAnthropic(
	cloud: Cloud,
	request: http.IncomingMessage,
	response: http.ServerResponse,
): Promise<void> {
	const text = (await readBody(request)).toString("utf8");
	let body: unknown = null;
	try {
		body = JSON.parse(text);
	} catch {
		// A body that is no JSON is recorded as null.
	}
	cloud.anthropicRequests.push({
		method: request.method || "",
		path: request.url || "",
		headers: request.headers,
		body: body,
	});
	const answer = cloud.anthropicAnswer;
	if (answer.kind === "error") {
		response.writeHead(answer.status, { "Content-Type": "application/json" });
		const error: Record<string, unknown> = {
			type: answer.type,
			message: answer.message,
		};
		if (answer.code !== undefined) {
			error.details = { error_code: answer.code };
		}
		response.end(
			JSON.stringify({
				type: "error",
				error: error,
				request_id: "req_standin",
			}),
		);
		return;
	}
	response.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
	});
	if (answer.kind === "turns") {
		const turn =
			answer.turns[
				Math.min(cloud.anthropicRequests.length, answer.turns.length) - 1
			];
		if (turn === undefined) {
			throw new Error("the stand-in has no turn to answer with");
		}
		writeTurn(response, turn);
		return;
	}
	response.write(
		sseEvent("message_start", {
			type: "message_start",
			message: {
				id: "msg_standin",
				type: "message",
				role: "assistant",
				content: [],
				model: "claude-sonnet-5-5",
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 25, output_tokens: 1 },
			},
		}),
	);
	response.write(
		sseEvent("content_block_start", {
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		}),
	);
	response.write(sseEvent("ping", { type: "ping" }));
	for (const [index, piece] of answer.pieces.entries()) {
		if (answer.gate?.atPiece === index) {
			answer.gate.markReached();
			await answer.gate.released;
		}
		response.write(
			sseEvent("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: piece },
			}),
		);
	}
	if (answer.gate?.atPiece === answer.pieces.length) {
		answer.gate.markReached();
		await answer.gate.released;
	}
	if (answer.kind === "cut") {
		response.write(
			sseEvent("error", {
				type: "error",
				error: { type: "overloaded_error", message: "Overloaded" },
			}),
		);
		response.end();
		return;
	}
	response.write(
		sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
	);
	response.write(
		sseEvent("message_delta", {
			type: "message_delta",
			delta: { stop_reason: "end_turn", stop_sequence: null },
			usage: { output_tokens: 15 },
		}),
	);
	response.write(sseEvent("message_stop", { type: "message_stop" }));
	response.end();
}

// The TCP port a listening server took.
function portOf(server: http.Server): number {
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("the stand-in listens on no TCP port");
	}
	return address.port;
}

// The key every stand-in for Access publishes first, made once per process because an RSA key is slow to make.
let firstPublishedKey: Promise<SigningKey> | null = null;

// Start the stand-in for Access on a free port, publishing one key; the Worker isn't started yet (startWorker).
export async function startCloud(): Promise<{
	cloud: Cloud;
	server: http.Server;
}> {
	if (firstPublishedKey === null) {
		firstPublishedKey = makeSigningKey("access-key-1");
	}
	const cloud: Cloud = {
		accessUrl: "", // set once the server listens
		published: [await firstPublishedKey],
		keyFetches: 0,
		keysStatus: 200,
		accessAnswer: null,
		requests: [],
		cooldownSeconds: null,
		siteOrigin: null,
		assetsDir: null,
		migrationsDir: null,
		environment: null, // a wrangler environment the Worker runs as, e.g. "staging"; null for the top level
		apiRequests: [],
		apiStatus: null,
		githubStatus: 204,
		githubRequests: [],
		anthropicKey: `sk-ant-test-${crypto.randomBytes(12).toString("hex")}`,
		anthropicAnswer: {
			kind: "text",
			pieces: ["The stand-in's reply."],
			gate: null,
		},
		anthropicRequests: [],
		push: createPushService(),
		pushRefusal: null,
		tempDirs: [],
		starting: null,
		harness: null,
		workerUrl: null,
		db: null,
	};
	const server = http.createServer((request, response) => {
		if (request.url === "/cdn-cgi/access/certs") {
			answerKeyFetch(cloud, response);
			return;
		}
		if ((request.url || "").startsWith(API_PREFIX)) {
			answerD1Api(cloud, request, response).catch((error: unknown) => {
				console.error("the stand-in for Cloudflare's API failed:", error);
				if (!response.headersSent) {
					response.writeHead(500);
				}
				response.end();
			});
			return;
		}
		if ((request.url || "").startsWith(ANTHROPIC_API_PREFIX)) {
			answerAnthropic(cloud, request, response).catch((error: unknown) => {
				console.error("the stand-in for Anthropic's API failed:", error);
				if (!response.headersSent) {
					response.writeHead(500);
				}
				response.end();
			});
			return;
		}
		if ((request.url || "").startsWith(GITHUB_API_PREFIX)) {
			answerGithub(cloud, request, response).catch((error: unknown) => {
				console.error("the stand-in for GitHub's API failed:", error);
				if (!response.headersSent) {
					response.writeHead(500);
				}
				response.end();
			});
			return;
		}
		if ((request.url || "").startsWith(PUSH_PREFIX)) {
			cloud.push.handle(request, response).catch((error: unknown) => {
				console.error("the stand-in for the push services failed:", error);
				if (!response.headersSent) {
					response.writeHead(500);
				}
				response.end();
			});
			return;
		}
		answerFrontDoor(cloud, request, response).catch((error: unknown) => {
			// A forwarding failure shows in the test's output and as a 502, never as a hang.
			console.error("the stand-in for Access failed to forward:", error);
			if (!response.headersSent) {
				response.writeHead(502);
			}
			response.end();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cloud.accessUrl = `http://127.0.0.1:${portOf(server)}`;
	return { cloud: cloud, server: server };
}

// =====================================================================================================
// The Worker
// =====================================================================================================

// Start the Worker from wrangler.jsonc once, with its D1 migrated and the stand-ins as its Access, GitHub, Anthropic and
// push services; every call waits for that one start.
export async function startWorker(cloud: Cloud): Promise<void> {
	if (cloud.starting === null) {
		cloud.starting = launchWorker(cloud);
	}
	await cloud.starting;
}

// The one start startWorker waits for.
async function launchWorker(cloud: Cloud): Promise<void> {
	// The vars point the Worker at the stand-in and the test audiences.
	const vars: Record<string, string> = {
		ACCESS_TEAM_DOMAIN: cloud.accessUrl,
		SYNC_AUD: SYNC_AUD,
		OWNER_AUD: OWNER_AUD,
		GITHUB_API: cloud.accessUrl,
		ANTHROPIC_API: cloud.accessUrl,
		PUSH_SERVICE_ORIGIN: cloud.accessUrl,
		PUSH_TIMEOUT_MS: "300",
	};
	if (cloud.cooldownSeconds !== null) {
		vars.JWKS_COOLDOWN_SECONDS = cloud.cooldownSeconds;
	}
	if (cloud.siteOrigin !== null) {
		vars.SITE_ORIGIN = cloud.siteOrigin;
	}
	const harness = createTestHarness({
		root: ROOT,
		workers: [
			{
				configPath: workerConfig(cloud),
				vars: vars,
				secrets: workerSecrets(cloud),
			},
		],
	});
	cloud.harness = harness;
	const listening = await harness.listen();
	cloud.workerUrl = listening.url.origin;
	// Untyped on purpose: Env's D1Database is a Workers runtime type the tests don't load, so the harness's typed form
	// would refuse the binding name.
	const worker = harness.getWorker();
	await worker.applyD1Migrations("DB");
	const env = await worker.getEnv();
	const db: D1 = env.DB;
	cloud.db = db;
}

// Stop the Worker and the stand-in. Kept-alive connections are dropped first, so close() doesn't wait on them.
export async function stopCloud(
	cloud: Cloud,
	server: http.Server,
): Promise<void> {
	// A start still under way ends first, so the harness is never closed while it starts.
	if (cloud.starting !== null) {
		await cloud.starting.catch(() => {});
	}
	if (cloud.harness !== null) {
		await cloud.harness.close();
	}
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
	for (const dir of cloud.tempDirs) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// A fresh temp folder that stopCloud deletes.
function cloudTempDir(cloud: Cloud, prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	cloud.tempDirs.push(dir);
	return dir;
}

// The repo's wrangler.jsonc as an object. Its comments sit on lines of their own, so dropping those lines leaves JSON.
function wranglerConfig(): JsonObject {
	const text = fs.readFileSync(path.join(ROOT, "wrangler.jsonc"), "utf8");
	const json = text
		.split("\n")
		.filter((line) => !line.trim().startsWith("//"))
		.join("\n");
	const config: unknown = JSON.parse(json);
	if (!isJsonObject(config)) {
		throw new Error("wrangler.jsonc is not a JSON object");
	}
	return config;
}

// The repo's wrangler.jsonc as this Worker reads it, written to a temp file with absolute paths, the assets folder from
// cloud.assetsDir (or an empty one) and the migrations folder from cloud.migrationsDir, if set.
function workerConfig(cloud: Cloud): string {
	const config = effectiveConfig(cloud);
	if (!Array.isArray(config.d1_databases)) {
		throw new Error("wrangler.jsonc has no d1_databases list");
	}
	delete config.$schema;
	config.main = path.join(ROOT, String(config.main));
	let assets = cloud.assetsDir;
	if (assets === null) {
		assets = cloudTempDir(cloud, "liminal-assets-");
	}
	config.assets = Object.assign({}, config.assets, { directory: assets });
	for (const database of config.d1_databases) {
		if (isJsonObject(database) && typeof database.migrations_dir === "string") {
			database.migrations_dir = path.join(ROOT, database.migrations_dir);
			if (cloud.migrationsDir !== null) {
				database.migrations_dir = cloud.migrationsDir;
			}
		}
	}
	const file = path.join(
		cloudTempDir(cloud, "liminal-config-"),
		"wrangler.json",
	);
	fs.writeFileSync(file, JSON.stringify(config, null, "\t"));
	return file;
}

// wrangler.jsonc for the Worker's environment: with cloud.environment set, that environment's keys replace the top level's.
function effectiveConfig(cloud: Cloud): JsonObject {
	const config = wranglerConfig();
	const environments = config.env;
	delete config.env;
	if (cloud.environment === null) {
		return config;
	}
	if (
		!isJsonObject(environments) ||
		!isJsonObject(environments[cloud.environment])
	) {
		throw new Error(`wrangler.jsonc has no env.${cloud.environment}`);
	}
	return Object.assign(config, environments[cloud.environment]);
}

// The secrets the Worker gets: every test secret at the top level; in an environment, only the ones its secrets.required lists.
function workerSecrets(cloud: Cloud): Record<string, string> {
	const secrets: Record<string, string> = {
		MCP_AUD: MCP_AUD,
		SYNC_CLIENT_ID: SYNC_CLIENT_ID,
		OWNER_EMAIL: OWNER_EMAIL,
		GITHUB_DISPATCH_TOKEN: GITHUB_DISPATCH_TOKEN,
		VAPID_PUBLIC_KEY: VAPID_PUBLIC_KEY,
		VAPID_PRIVATE_KEY: VAPID_PRIVATE_KEY,
	};
	// With no Anthropic key (cloud.anthropicKey null) the site has no Claude set up.
	if (cloud.anthropicKey !== null) {
		secrets.ANTHROPIC_API_KEY = cloud.anthropicKey;
	}
	if (cloud.environment === null) {
		return secrets;
	}
	const declared = effectiveConfig(cloud).secrets;
	let required: unknown[] = [];
	if (isJsonObject(declared) && Array.isArray(declared.required)) {
		required = declared.required;
	}
	for (const name of Object.keys(secrets)) {
		if (!required.includes(name)) {
			delete secrets[name];
		}
	}
	return secrets;
}

// The D1 binding of the started Worker.
function databaseOf(cloud: Cloud): D1 {
	if (cloud.db === null) {
		throw new Error("the Worker hasn't started, so there is no database yet");
	}
	return cloud.db;
}

// Send one request straight to the Worker at `requestPath`, kept exactly as written, and return what it answered.
// A stream body goes out chunked; "half" duplex is what fetch requires for a request body that is a stream.
export async function sendToWorker(
	cloud: Cloud,
	method: string,
	requestPath: string,
	headers: Record<string, string>,
	body: string | ReadableStream<Uint8Array> | null,
): Promise<Answer> {
	await startWorker(cloud);
	if (cloud.workerUrl === null) {
		throw new Error("the Worker has no URL");
	}
	// Node's fetch takes `duplex`; the DOM types the tests load don't list it, so the type adds it.
	const init: RequestInit & { duplex?: "half" } = {
		method: method,
		headers: headers,
	};
	if (body !== null) {
		init.body = body;
	}
	if (body instanceof ReadableStream) {
		init.duplex = "half";
	}
	const answer = await fetch(cloud.workerUrl + requestPath, init);
	return {
		status: answer.status,
		body: await answer.text(),
		allow: answer.headers.get("allow"),
		contentTypeOptions: answer.headers.get("x-content-type-options"),
	};
}

// =====================================================================================================
// The Worker's log
// =====================================================================================================

// The Worker's request log lines so far, in order: the console.log lines that are JSON objects with a status and path.
export function requestLogs(cloud: Cloud): RequestLog[] {
	if (cloud.harness === null) {
		return [];
	}
	const lines: RequestLog[] = [];
	for (const log of cloud.harness.getLogs()) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(log.message);
		} catch {
			continue;
		}
		if (
			isJsonObject(parsed) &&
			typeof parsed.status === "number" &&
			typeof parsed.path === "string"
		) {
			const line: RequestLog = {
				method: String(parsed.method),
				path: parsed.path,
				status: parsed.status,
				queries: Number(parsed.queries),
				rowsRead: Number(parsed.rowsRead),
				rowsWritten: Number(parsed.rowsWritten),
			};
			if (typeof parsed.reason === "string") {
				line.reason = parsed.reason;
			}
			lines.push(line);
		}
	}
	return lines;
}

// =====================================================================================================
// The stand-in for Cloudflare's D1 query API
// =====================================================================================================
// Runs a query on the Worker's local D1 and answers in the shape of Cloudflare's D1 query API.

// Where the API's paths start on the stand-in, as on api.cloudflare.com.
const API_PREFIX = "/client/v4/";

// The test value of the API token.
const CLOUDFLARE_TEST_TOKEN = `cf-test-${crypto.randomBytes(8).toString("hex")}`;

// One request to the API stand-in: its path, the SQL it sent (null when the body held none) and the status it got.
type ApiRequest = { path: string; sql: string | null; status: number };

// The test values of the account id and database id, which a query's path must name.
const CLOUDFLARE_TEST_ACCOUNT_ID = crypto.randomBytes(16).toString("hex");
const D1_TEST_DATABASE_ID = crypto.randomUUID();

// The query path for those two ids.
const D1_QUERY_PATH = `${API_PREFIX}accounts/${CLOUDFLARE_TEST_ACCOUNT_ID}/d1/database/${D1_TEST_DATABASE_ID}/query`;

// Send a JSON answer in the API's shape.
function sendApi(
	response: http.ServerResponse,
	status: number,
	body: JsonObject,
): void {
	response.writeHead(status, { "Content-Type": "application/json" });
	response.end(JSON.stringify(body));
}

// Answer one API request: the query path with the right ids and token runs its SQL on the local D1; anything else
// answers as the API would (403 for a wrong token, 404 for another path, 400 for SQL that fails). With cloud.apiStatus
// set, every request gets that status instead.
async function answerD1Api(
	cloud: Cloud,
	request: http.IncomingMessage,
	response: http.ServerResponse,
): Promise<void> {
	const body = await readBody(request);
	const logged: ApiRequest = { path: request.url || "", sql: null, status: 0 };
	cloud.apiRequests.push(logged);
	// With apiStatus set, every request gets that status, whatever it asked.
	if (cloud.apiStatus !== null) {
		logged.status = cloud.apiStatus;
		sendApi(response, cloud.apiStatus, {
			success: false,
			errors: [
				{ code: 10000, message: `the stand-in answers ${cloud.apiStatus}` },
			],
			messages: [],
			result: null,
		});
		return;
	}
	if (
		headerValue(request, "authorization") !== `Bearer ${CLOUDFLARE_TEST_TOKEN}`
	) {
		logged.status = 403;
		sendApi(response, 403, {
			success: false,
			errors: [{ code: 10000, message: "Authentication error" }],
			messages: [],
			result: null,
		});
		return;
	}
	if (request.method !== "POST" || logged.path !== D1_QUERY_PATH) {
		logged.status = 404;
		sendApi(response, 404, {
			success: false,
			errors: [{ code: 7003, message: "No route for that URI" }],
			messages: [],
			result: null,
		});
		return;
	}
	const parsed: unknown = JSON.parse(body.toString("utf8"));
	if (!isJsonObject(parsed) || typeof parsed.sql !== "string") {
		logged.status = 400;
		sendApi(response, 400, {
			success: false,
			errors: [{ code: 7400, message: "the body holds no sql" }],
			messages: [],
			result: null,
		});
		return;
	}
	logged.sql = parsed.sql;
	let params: unknown[] = [];
	if (Array.isArray(parsed.params)) {
		params = parsed.params;
	}
	await startWorker(cloud);
	try {
		const result = await databaseOf(cloud)
			.prepare(parsed.sql)
			.bind(...params)
			.all();
		logged.status = 200;
		sendApi(response, 200, {
			success: true,
			errors: [],
			messages: [],
			result: [{ results: result.results, success: true, meta: result.meta }],
		});
	} catch (error) {
		logged.status = 400;
		sendApi(response, 400, {
			success: false,
			errors: [{ code: 7500, message: String(error) }],
			messages: [],
			result: null,
		});
	}
}

// The environment sync.ts needs to push through the stand-in for Access and to pull from the stand-in for D1's API.
export function syncEnv(cloud: Cloud): Record<string, string> {
	return {
		ACCESS_SYNC_ID: SYNC_CLIENT_ID,
		ACCESS_SYNC_SECRET: SYNC_CLIENT_SECRET,
		LIMINAL_URL: `${cloud.accessUrl}/liminal-space`,
		LIMINAL_ALLOW_LOCAL: URL.parse(cloud.accessUrl)?.host ?? "",
		CLOUDFLARE_API_BASE: `${cloud.accessUrl}${API_PREFIX}`,
		CLOUDFLARE_API_TOKEN: CLOUDFLARE_TEST_TOKEN,
		CLOUDFLARE_ACCOUNT_ID: CLOUDFLARE_TEST_ACCOUNT_ID,
		D1_DATABASE_ID: D1_TEST_DATABASE_ID,
		SYNC_RETRY_SECOND_MS: "1",
	};
}
