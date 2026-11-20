// The scout's run logs in D1's scout_logs: stored through the sync route, listed on the owner route
// (shared/log-protocol.ts).

import type { ScoutLog } from "../../shared/log-protocol.ts";
import {
	LOG_DAYS,
	MAX_LOG_BODY_EXTRA,
	MAX_LOG_BYTES,
	RUN_ID,
} from "../../shared/log-protocol.ts";
import { isJsonObject } from "../../shared/narrow.ts";
import type { QueryCost } from "./d1.ts";
import { counter, countOne, runBatch } from "./d1.ts";
import type { Env, RequestLog } from "./env.ts";
import {
	BodyProblem,
	readJson,
	refuse,
	refuseBody,
	tryAgain,
} from "./respond.ts";

// The date `days` days before the YYYY-MM-DD date `date`.
function daysBefore(date: string, days: number): string {
	const day = new Date(`${date}T00:00:00Z`);
	day.setUTCDate(day.getUTCDate() - days);
	return day.toISOString().slice(0, 10);
}

// A real calendar date written YYYY-MM-DD.
function isDate(text: unknown): text is string {
	return (
		typeof text === "string" &&
		/^\d{4}-\d{2}-\d{2}$/.test(text) &&
		daysBefore(text, 0) === text
	);
}

// The run a POST body names, or a BodyProblem saying what is wrong with it.
export function logOf(body: unknown): Omit<ScoutLog, "updated"> {
	if (!isJsonObject(body)) {
		throw new BodyProblem("body is not a JSON object");
	}
	if (typeof body.id !== "string" || !RUN_ID.test(body.id)) {
		throw new BodyProblem("id is not a run id");
	}
	if (!isDate(body.date)) {
		throw new BodyProblem("date is not YYYY-MM-DD");
	}
	if (typeof body.log !== "string") {
		throw new BodyProblem("log is not text");
	}
	if (new TextEncoder().encode(body.log).byteLength > MAX_LOG_BYTES) {
		throw new BodyProblem(`log is larger than ${MAX_LOG_BYTES} bytes`, 413);
	}
	return { id: body.id, date: body.date, log: body.log };
}

// Store one run's log, replacing the run's earlier one, and remove the logs dated more than LOG_DAYS days before it.
// One batch, so both happen or neither does.
export async function saveLog(
	db: D1Database,
	run: Omit<ScoutLog, "updated">,
	count: (cost: QueryCost) => void,
): Promise<void> {
	await runBatch(
		db,
		[
			db
				.prepare(
					"INSERT INTO scout_logs (id, date, log, updated) VALUES (?1, ?2, ?3, ?4) " +
						"ON CONFLICT (id) DO UPDATE SET date = excluded.date, log = excluded.log, updated = excluded.updated",
				)
				.bind(run.id, run.date, run.log, new Date().toISOString()),
			db
				.prepare("DELETE FROM scout_logs WHERE date < ?1")
				.bind(daysBefore(run.date, LOG_DAYS)),
		],
		count,
	);
}

// Every stored run's log, newest date first, then the one stored last first.
export async function readLogs(
	db: D1Database,
	count: (cost: QueryCost) => void,
): Promise<{ logs: ScoutLog[] }> {
	const answer = await countOne(
		db
			.prepare(
				"SELECT id, date, log, updated FROM scout_logs ORDER BY date DESC, updated DESC",
			)
			.all<ScoutLog>(),
		count,
	);
	return { logs: answer.results };
}

// POST /liminal-space/api/sync/logs: one run's log, stored.
export async function answerLogs(
	request: Request,
	env: Env,
	_ctx: ExecutionContext,
	log: RequestLog,
): Promise<Response> {
	let body: unknown;
	try {
		body = await readJson(request, MAX_LOG_BYTES + MAX_LOG_BODY_EXTRA);
	} catch (error) {
		if (!(error instanceof BodyProblem)) {
			throw error;
		}
		return refuseBody(log, error);
	}
	// A log too large answers its own reason as the text, unlike a body too large.
	try {
		await saveLog(env.DB, logOf(body), counter(log));
		return Response.json({});
	} catch (error) {
		if (error instanceof BodyProblem) {
			return refuse(log, error.status, error.message, error.message);
		}
		return tryAgain(log, "log save failed", error);
	}
}
