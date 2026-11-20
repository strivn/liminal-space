// POST /liminal-space/mcp: the claude.ai connector, MCP's JSON-RPC over HTTP, answered by hand (the MCP SDK costs 16 to
// 52 ms of CPU a request against the free plan's 10 ms). Methods: initialize, notifications/* (202, no body),
// ping, tools/list, tools/call with the tools add_papers, add_links, search, get_digest and
// propose_takeaway (worker/src/mcp-tools.ts). Answers are
// application/json, never a stream. Shapes and limits:
// shared/connector-protocol.ts.
import {
	MAX_MCP_BODY_BYTES,
	PROTOCOL_VERSIONS,
} from "../../shared/connector-protocol.ts";
import { isJsonObject, type JsonObject } from "../../shared/narrow.ts";
import { counter, type QueryCost } from "./d1.ts";
import type { Env, RequestLog } from "./env.ts";
import { BadParams, TOOLS, type ToolAnswer } from "./mcp-tools.ts";
import { BodyProblem, json, readJson, refuseBody } from "./respond.ts";

// JSON-RPC's error codes (https://www.jsonrpc.org/specification#error_object).
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

// A JSON-RPC request's id: MCP allows a string or a number, never null.
type RpcId = string | number;

// A JSON-RPC result.
function rpcResult(id: RpcId, result: unknown) {
	return json({ jsonrpc: "2.0", id: id, result: result });
}

// A JSON-RPC error, with its reason kept for the log line. A message the Worker can't read (not JSON, not a request)
// has no id to answer and gets HTTP 400; a request it read gets 200, as JSON-RPC answers travel.
function rpcError(
	log: RequestLog,
	id: RpcId | null,
	code: number,
	message: string,
) {
	log.reason = message;
	let status = 200;
	if (id === null) {
		status = 400;
	}
	return json(
		{ jsonrpc: "2.0", id: id, error: { code: code, message: message } },
		status,
	);
}

// tools/call: run the named tool. An unknown tool or arguments of the wrong shape are a JSON-RPC error; a tool's own
// refusal is a result with isError true.
async function callTool(
	id: RpcId,
	params: unknown,
	env: Env,
	log: RequestLog,
	count: (cost: QueryCost) => void,
): Promise<Response> {
	if (!isJsonObject(params) || typeof params.name !== "string") {
		return rpcError(log, id, INVALID_PARAMS, "tools/call needs a tool name");
	}
	let args: JsonObject = {};
	if (params.arguments !== undefined) {
		if (!isJsonObject(params.arguments)) {
			return rpcError(log, id, INVALID_PARAMS, "arguments must be an object");
		}
		args = params.arguments;
	}
	const name = params.name;
	const tool = TOOLS.find((each) => each.name === name);
	if (tool === undefined) {
		return rpcError(log, id, INVALID_PARAMS, "unknown tool");
	}

	// Run the tool; D1 failing is the Worker's error, not the tool's, and the client may call again.
	let answer: ToolAnswer;
	try {
		answer = await tool.run(args, { env: env, log: log, count: count });
	} catch (error) {
		if (error instanceof BadParams) {
			return rpcError(log, id, INVALID_PARAMS, error.message);
		}
		// The client reads a short message; the log line keeps D1's own.
		const response = rpcError(
			log,
			id,
			INTERNAL_ERROR,
			"the database failed; try again",
		);
		log.reason = "the database failed";
		if (error instanceof Error) {
			log.reason = `the database failed: ${error.message}`;
		}
		return response;
	}
	const result: JsonObject = { content: [{ type: "text", text: answer.text }] };
	if (answer.isError) {
		result.isError = true;
	}
	return rpcResult(id, result);
}

// POST /liminal-space/mcp: the connector's JSON-RPC message. MCP's HTTP transport lets a server without a stream
// refuse GET with 405.
export function answerMcpMessage(
	request: Request,
	env: Env,
	_ctx: ExecutionContext,
	log: RequestLog,
): Promise<Response> {
	return answerMcp(request, env, log, counter(log));
}

// Why a request looks sent by a web page rather than the connector, or null when it doesn't. The connector calls from
// claude.ai's servers and sends no Origin; a browser adds one to every cross-site POST. A page on another site can send
// text/plain, a form or multipart body without asking the site first (a CORS "simple request"), but application/json
// only after a preflight the Worker never answers.
function pageRequestReason(request: Request): string | null {
	if (request.headers.get("Origin") !== null) {
		return "a request carrying an Origin";
	}
	const contentType = request.headers.get("Content-Type") || "";
	// "application/json; charset=utf-8" is JSON too: the media type is what comes before any parameter.
	const mediaType = (contentType.split(";")[0] || "").trim().toLowerCase();
	if (mediaType !== "application/json") {
		return "Content-Type is not application/json";
	}
	return null;
}

// Answer one JSON-RPC message (the token was already checked). A request a web page could send is 403 before its body
// is read. Errors follow JSON-RPC: -32700 for a body that isn't JSON, -32600 for a message that isn't a request,
// -32601 for an unknown method, -32602 for an unknown tool or bad arguments; a tool's own refusal (a bad id, a full
// queue) is a tool result with isError true, naming the reason.
export async function answerMcp(
	request: Request,
	env: Env,
	log: RequestLog,
	count: (cost: QueryCost) => void,
): Promise<Response> {
	const refusal = pageRequestReason(request);
	if (refusal !== null) {
		log.reason = refusal;
		return new Response("forbidden", { status: 403 });
	}
	let message: unknown;
	try {
		message = await readJson(request, MAX_MCP_BODY_BYTES);
	} catch (error) {
		if (!(error instanceof BodyProblem)) {
			throw error;
		}
		if (error.status === 413) {
			return refuseBody(log, error);
		}
		return rpcError(log, null, PARSE_ERROR, error.message);
	}
	// One message a request: MCP no longer sends JSON-RPC batches.
	if (!isJsonObject(message) || message.jsonrpc !== "2.0") {
		return rpcError(
			log,
			null,
			INVALID_REQUEST,
			"body is not one JSON-RPC message",
		);
	}

	// A notification has no id, and the client's answer to a request has a result or an error and no method: neither
	// is answered, 202 with no body.
	const id = message.id;
	const isAnswer =
		message.method === undefined &&
		(message.result !== undefined || message.error !== undefined);
	if (id === undefined || isAnswer) {
		return new Response(null, { status: 202 });
	}
	if (typeof id !== "string" && typeof id !== "number") {
		return rpcError(log, null, INVALID_REQUEST, "id must be text or a number");
	}
	// A request with an id names its method as text.
	if (typeof message.method !== "string") {
		return rpcError(log, id, INVALID_REQUEST, "method must be text");
	}

	// After initialize the client names the version agreed on; one the Worker doesn't speak is refused (MCP's rule).
	const method = message.method;
	const version = request.headers.get("MCP-Protocol-Version");
	if (
		method !== "initialize" &&
		version !== null &&
		!PROTOCOL_VERSIONS.includes(version)
	) {
		return rpcError(
			log,
			null,
			INVALID_REQUEST,
			"unsupported MCP-Protocol-Version",
		);
	}

	if (method === "initialize") {
		// The client's version when the Worker speaks it, else the newest the Worker does.
		let agreed = PROTOCOL_VERSIONS[0];
		// The list is never empty.
		if (agreed === undefined) {
			throw new Error("PROTOCOL_VERSIONS is empty");
		}
		if (
			isJsonObject(message.params) &&
			typeof message.params.protocolVersion === "string" &&
			PROTOCOL_VERSIONS.includes(message.params.protocolVersion)
		) {
			agreed = message.params.protocolVersion;
		}
		return rpcResult(id, {
			protocolVersion: agreed,
			capabilities: { tools: { listChanged: false } },
			serverInfo: { name: "liminal-space", version: "1.0.0" },
		});
	}
	if (method === "ping") {
		return rpcResult(id, {});
	}
	if (method === "tools/list") {
		const listed = TOOLS.map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: tool.inputSchema,
		}));
		return rpcResult(id, { tools: listed });
	}
	if (method === "tools/call") {
		return callTool(id, message.params, env, log, count);
	}
	return rpcError(log, id, METHOD_NOT_FOUND, "method not found");
}
