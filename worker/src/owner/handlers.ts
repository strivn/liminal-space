// The owner routes' handlers: the two reads, the push key and subscription, and one change handler for each owner POST
// path. worker/src/index.ts lists them in its route table.
import { MAX_OWNER_BODY_BYTES } from "../../../shared/owner-protocol.ts";
import { counter } from "../d1.ts";
import type { Env, RequestLog } from "../env.ts";
import { readLogs } from "../logs.ts";
import { answerPushKey, savePushSubscription } from "../notify.ts";
import {
	BodyProblem,
	json,
	readJson,
	refuseBody,
	tryAgain,
} from "../respond.ts";
import type { Handler } from "../routes.ts";
import {
	commentsChangeOf,
	feedbackChangeOf,
	readChangeOf,
	standoutChangeOf,
	tagsChangeOf,
	takeawayChangeOf,
} from "./checks.ts";
import { readState } from "./notes.ts";
import {
	saveComments,
	saveFeedback,
	saveRead,
	saveStandout,
	saveTags,
	saveTakeaway,
} from "./store.ts";

// GET /liminal-space/api/owner/logs: every stored scout run's log.
export async function answerOwnerLogs(
	_request: Request,
	env: Env,
	_ctx: ExecutionContext,
	log: RequestLog,
): Promise<Response> {
	try {
		return json(await readLogs(env.DB, counter(log)));
	} catch (error) {
		return tryAgain(log, "logs read failed", error);
	}
}

// GET /liminal-space/api/owner/state: every read mark, tag and thread.
export async function answerOwnerState(
	_request: Request,
	env: Env,
	_ctx: ExecutionContext,
	log: RequestLog,
): Promise<Response> {
	try {
		return json(await readState(env.DB, counter(log)));
	} catch (error) {
		return tryAgain(log, "state read failed", error);
	}
}

// GET /liminal-space/api/owner/push: the VAPID public key the page subscribes with.
export function answerOwnerPushKey(_request: Request, env: Env): Response {
	return answerPushKey(env);
}

// An owner POST with a JSON body: read the body, then let `change` check and store it. Nothing is written for a
// refused body.
function ownerChange(
	change: (body: unknown, env: Env, log: RequestLog) => Promise<Response>,
): Handler {
	return async (request, env, _ctx, log) => {
		let body: unknown;
		try {
			body = await readJson(request, MAX_OWNER_BODY_BYTES);
		} catch (error) {
			if (!(error instanceof BodyProblem)) {
				throw error;
			}
			return refuseBody(log, error);
		}
		try {
			return await change(body, env, log);
		} catch (error) {
			if (error instanceof BodyProblem) {
				return refuseBody(log, error);
			}
			// D1 failed or was busy: a batch is one transaction, so nothing of this change was written.
			return tryAgain(log, "owner change failed", error);
		}
	};
}

// POST /liminal-space/api/owner/takeaways.
export const answerTakeaway = ownerChange(async (body, env, log) => {
	await saveTakeaway(env.DB, takeawayChangeOf(body), counter(log));
	return json({});
});

// POST /liminal-space/api/owner/read.
export const answerRead = ownerChange(async (body, env, log) => {
	await saveRead(env.DB, readChangeOf(body), counter(log));
	return json({});
});

// POST /liminal-space/api/owner/tags.
export const answerTags = ownerChange(async (body, env, log) => {
	await saveTags(env.DB, tagsChangeOf(body), counter(log));
	return json({});
});

// POST /liminal-space/api/owner/feedback.
export const answerFeedback = ownerChange(async (body, env, log) => {
	await saveFeedback(env.DB, feedbackChangeOf(body), counter(log));
	return json({});
});

// POST /liminal-space/api/owner/standouts.
export const answerStandout = ownerChange(async (body, env, log) => {
	await saveStandout(env.DB, standoutChangeOf(body), counter(log));
	return json({});
});

// POST /liminal-space/api/owner/comments.
export const answerComments = ownerChange(async (body, env, log) => {
	await saveComments(env.DB, commentsChangeOf(body), counter(log));
	return json({});
});

// POST /liminal-space/api/owner/push: save this device's push subscription, keeping a refusal's text for the log line.
export const answerPushSubscription = ownerChange(async (body, env, log) => {
	const answer = await savePushSubscription(body, env);
	if (answer.status === 400) {
		log.reason = await answer.clone().text();
	}
	return answer;
});
