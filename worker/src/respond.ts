// What every route shares: reading a JSON body within a limit, and the answers a route refuses or fails with.
import { jsonOf, readBody } from "./body.ts";
import type { RequestLog } from "./env.ts";

// A body a route can't use: the message names the reason, and the status is 400, or 413 for one too large to take.
export class BodyProblem extends Error {
	status: 400 | 413;
	constructor(message: string, status: 400 | 413 = 400) {
		super(message);
		this.status = status;
	}
}

// The JSON a request's body holds, read up to maxBytes; a BodyProblem when it is larger or isn't JSON in UTF-8.
export async function readJson(
	request: Request,
	maxBytes: number,
): Promise<unknown> {
	const bytes = await readBody(request, maxBytes);
	if (bytes === null) {
		throw new BodyProblem(`body is larger than ${maxBytes} bytes`, 413);
	}
	try {
		return jsonOf(bytes);
	} catch {
		throw new BodyProblem("body is not JSON");
	}
}

// A plain-text answer, with the refusal's reason kept for the log line.
export function refuse(
	log: RequestLog,
	status: number,
	body: string,
	reason: string,
	headers: Record<string, string> = {},
): Response {
	log.reason = reason;
	return new Response(body, { status: status, headers: headers });
}

// A token access.ts refused: 403 "forbidden", or 503 "try again" when Access's keys can't be fetched.
export function refuseToken(
	log: RequestLog,
	status: 403 | 503,
	reason: string,
): Response {
	let body = "forbidden";
	if (status === 503) {
		body = "try again";
	}
	return refuse(log, status, body, reason);
}

// A body problem as the sync and owner routes answer it: 413 "too large", or 400 with the reason as the text.
export function refuseBody(log: RequestLog, problem: BodyProblem): Response {
	if (problem.status === 413) {
		return refuse(log, 413, "too large", problem.message);
	}
	return refuse(log, 400, problem.message, problem.message);
}

// D1 failed or was busy: 503 "try again", with `what` and the error's message for the log line.
export function tryAgain(
	log: RequestLog,
	what: string,
	error: unknown,
): Response {
	let reason = what;
	if (error instanceof Error) {
		reason = `${what}: ${error.message}`;
	}
	return refuse(log, 503, "try again", reason);
}

// A JSON answer that no cache keeps.
export function json(value: unknown, status = 200): Response {
	return Response.json(value, {
		status: status,
		headers: { "Cache-Control": "no-store" },
	});
}
