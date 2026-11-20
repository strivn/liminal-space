// The add_requests table: queued by the connector's tools, read and reported by add.yml through the sync routes
// GET and POST /liminal-space/api/sync/requests, and retried by the 15-minute cron. Shapes: shared/connector-protocol.ts.
// A finished request keeps its result, the one record of what each add did, for a look in the D1 console.
// Every lookup goes through an index: the primary key or add_requests_status.
import {
	type AddItemResult,
	type AddKind,
	type AddPayload,
	type AddRequest,
	MAX_QUEUED_REQUESTS,
	MAX_REQUEST_UPDATE_BYTES,
	type QueuedAnswer,
	type RequestUpdate,
} from "../../shared/connector-protocol.ts";
import { isJsonObject } from "../../shared/narrow.ts";
import { counter, countOne, type QueryCost } from "./d1.ts";
import type { Env, RequestLog } from "./env.ts";
import {
	BodyProblem,
	readJson,
	refuse,
	refuseBody,
	tryAgain,
} from "./respond.ts";
import { dispatchWorkflow } from "./schedule.ts";

// A request, saved only while fewer than MAX_QUEUED_REQUESTS wait: one statement, so two calls at once can't both
// take the last place. The count reads the queued rows through add_requests_status.
const INSERT_IF_ROOM =
	"INSERT INTO add_requests (id, kind, payload, status, created) " +
	"SELECT ?1, ?2, ?3, 'queued', ?4 " +
	"WHERE (SELECT COUNT(*) FROM add_requests WHERE status = 'queued') < ?5";
// The requests add.yml handles, oldest first, through add_requests_status: the queued ones, and the ones still marked
// running. add.yml runs one at a time, so when it reads this list no run is handling a request: one marked running was
// left so by a run that died (cancelled, timed out, or its report failed), and is handled again.
const SELECT_QUEUED =
	"SELECT id, kind, payload FROM add_requests WHERE status IN ('queued', 'running') ORDER BY created, rowid";
// Whether any request waits: at most one row read, through add_requests_status.
const SELECT_ANY_QUEUED =
	"SELECT id FROM add_requests WHERE status = 'queued' LIMIT 1";
// Whether a request has been marked running for longer than any add run lasts, through add_requests_status: it reads
// only the running rows, which are none or the one or two of the current run. The table keeps no start time, so the
// request's creation stands in for it: a request created over STUCK_AFTER_MS ago and still running is either stuck or
// in a run that started late, and a dispatch in the second case only adds a run that waits for this one and finds
// nothing left to do.
const SELECT_ANY_STUCK =
	"SELECT id FROM add_requests WHERE status = 'running' AND created < ?1 LIMIT 1";
// A request add.yml has started, through the primary key.
const MARK_RUNNING = "UPDATE add_requests SET status = ?2 WHERE id = ?1";
// A request add.yml has finished, with its result, through the primary key.
const MARK_FINISHED =
	"UPDATE add_requests SET status = ?2, finished = ?3, result = ?4 WHERE id = ?1";

// How long a request may stay running before the cron starts add.yml again for it: add.yml's job times out after 20
// minutes, so after 30 no run is handling it.
const STUCK_AFTER_MS = 30 * 60 * 1000;

// The queue already holds MAX_QUEUED_REQUESTS requests: nothing was saved.
export class QueueFull extends Error {}

// The outcomes a request's item can have.
const OUTCOMES: unknown[] = ["added", "already there", "failed"];

// One item of a result: {"id", "outcome", "reason": text, given for "failed"}.
function itemResultOf(value: unknown): AddItemResult {
	if (!isJsonObject(value)) {
		throw new BodyProblem("a result item is not an object");
	}
	if (typeof value.id !== "string") {
		throw new BodyProblem("a result item's id must be text");
	}
	if (!OUTCOMES.includes(value.outcome)) {
		throw new BodyProblem(
			'a result item\'s outcome must be "added", "already there" or "failed"',
		);
	}
	const item: AddItemResult = {
		id: value.id,
		outcome: value.outcome as AddItemResult["outcome"],
	};
	if (value.reason !== undefined) {
		if (typeof value.reason !== "string") {
			throw new BodyProblem("a result item's reason must be text");
		}
		item.reason = value.reason;
	}
	return item;
}

// The body of POST requests: {"id", "status": "running", "done" or "failed", "result": {"items"}}, the result
// given when the request is done or failed. Only these fields are kept.
export function requestUpdateOf(body: unknown): RequestUpdate {
	if (!isJsonObject(body)) {
		throw new BodyProblem("body is not an object");
	}
	const id = body.id;
	const status = body.status;
	if (typeof id !== "string" || id === "") {
		throw new BodyProblem("id must be a request id");
	}
	if (status !== "running" && status !== "done" && status !== "failed") {
		throw new BodyProblem('status must be "running", "done" or "failed"');
	}
	const change: RequestUpdate = { id: id, status: status };
	if (body.result === undefined) {
		return change;
	}
	const result = body.result;
	if (!isJsonObject(result) || !Array.isArray(result.items)) {
		throw new BodyProblem('result must hold a list of "items"');
	}
	const items: AddItemResult[] = [];
	for (const item of result.items) {
		items.push(itemResultOf(item));
	}
	change.result = { items: items };
	return change;
}

// A column holding JSON text, read back; null for a NULL column.
function parsedColumn(value: unknown): unknown {
	if (typeof value !== "string") {
		return null;
	}
	return JSON.parse(value);
}

// Queue a request (refused when MAX_QUEUED_REQUESTS already wait) and return it.
export async function enqueue(
	db: D1Database,
	kind: AddKind,
	payload: AddPayload,
	count: (cost: QueryCost) => void,
): Promise<AddRequest> {
	const request: AddRequest = {
		id: crypto.randomUUID(),
		kind: kind,
		payload: payload,
		status: "queued",
		created: new Date().toISOString(),
		finished: null,
		result: null,
	};
	const answer = await countOne(
		db
			.prepare(INSERT_IF_ROOM)
			.bind(
				request.id,
				kind,
				JSON.stringify(payload),
				request.created,
				MAX_QUEUED_REQUESTS,
			)
			.all(),
		count,
	);
	if (answer.meta.changes === 0) {
		throw new QueueFull(`${MAX_QUEUED_REQUESTS} requests are already waiting`);
	}
	return request;
}

// The requests add.yml handles, queued or left running, oldest first, through the add_requests_status index.
export async function queued(
	db: D1Database,
	count: (cost: QueryCost) => void,
): Promise<QueuedAnswer> {
	const answer = await countOne(db.prepare(SELECT_QUEUED).all(), count);
	const list: QueuedAnswer["requests"] = [];
	for (const row of answer.results) {
		list.push({
			id: String(row.id),
			kind: row.kind as AddKind,
			payload: parsedColumn(row.payload) as AddPayload,
		});
	}
	return { requests: list };
}

// True when a request waits for add.yml: one is queued, or one has stayed running past STUCK_AFTER_MS. The second
// lookup runs only when nothing is queued.
async function anyWaiting(
	db: D1Database,
	count: (cost: QueryCost) => void,
): Promise<boolean> {
	const waiting = await countOne(db.prepare(SELECT_ANY_QUEUED).all(), count);
	if (waiting.results.length > 0) {
		return true;
	}
	const startedBefore = new Date(Date.now() - STUCK_AFTER_MS).toISOString();
	const stuck = await countOne(
		db.prepare(SELECT_ANY_STUCK).bind(startedBefore).all(),
		count,
	);
	return stuck.results.length > 0;
}

// Record a request's new status and result. False when no request has that id.
export async function update(
	db: D1Database,
	change: RequestUpdate,
	count: (cost: QueryCost) => void,
): Promise<boolean> {
	let statement: D1PreparedStatement;
	if (change.status === "running") {
		statement = db.prepare(MARK_RUNNING).bind(change.id, change.status);
	} else {
		let result: string | null = null;
		if (change.result !== undefined) {
			result = JSON.stringify(change.result);
		}
		statement = db
			.prepare(MARK_FINISHED)
			.bind(change.id, change.status, new Date().toISOString(), result);
	}
	const answer = await countOne(statement.all(), count);
	return answer.meta.changes > 0;
}

// The one log line the 15-minute cron writes, with console.log as JSON: the cron, whether a request was waiting (queued,
// or left running), GitHub's status (0 when GitHub wasn't asked or couldn't be reached), why it failed, and what D1 read.
type RetryLog = {
	cron: string;
	queued: boolean;
	status: number;
	reason?: string;
	queries: number;
	rowsRead: number;
};

// The 15-minute cron: start add.yml again when a request waits (its first dispatch may have failed, or the run that
// marked it running died), and ask GitHub nothing when none does.
export async function retryAdds(cron: string, env: Env): Promise<void> {
	const log: RetryLog = {
		cron: cron,
		queued: false,
		status: 0,
		queries: 0,
		rowsRead: 0,
	};
	const count = (cost: QueryCost) => {
		log.queries += 1;
		log.rowsRead += cost.rowsRead;
	};
	try {
		log.queued = await anyWaiting(env.DB, count);
	} catch (error) {
		log.reason = "the queue couldn't be read";
		if (error instanceof Error) {
			log.reason += `: ${error.message}`;
		}
	}
	if (log.queued) {
		const dispatch = await dispatchWorkflow(env, "add.yml", "add.yml");
		log.status = dispatch.status;
		if (dispatch.reason !== undefined) {
			log.reason = dispatch.reason;
		}
	}
	console.log(JSON.stringify(log));
}

// GET /liminal-space/api/sync/requests: the requests add.yml handles next.
export async function answerQueued(
	_request: Request,
	env: Env,
	_ctx: ExecutionContext,
	log: RequestLog,
): Promise<Response> {
	try {
		return Response.json(await queued(env.DB, counter(log)));
	} catch (error) {
		return tryAgain(log, "queue read failed", error);
	}
}

// POST /liminal-space/api/sync/requests: add.yml reports one request's new status and result.
export async function answerRequestUpdate(
	request: Request,
	env: Env,
	_ctx: ExecutionContext,
	log: RequestLog,
): Promise<Response> {
	let body: unknown;
	try {
		body = await readJson(request, MAX_REQUEST_UPDATE_BYTES);
	} catch (error) {
		if (!(error instanceof BodyProblem)) {
			throw error;
		}
		return refuseBody(log, error);
	}
	try {
		const found = await update(env.DB, requestUpdateOf(body), counter(log));
		if (!found) {
			return refuse(log, 404, "no such request", "no such request");
		}
		return Response.json({});
	} catch (error) {
		if (error instanceof BodyProblem) {
			return refuseBody(log, error);
		}
		return tryAgain(log, "request update failed", error);
	}
}
