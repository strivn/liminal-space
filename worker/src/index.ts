// The Worker for ivan.wiryadi.com/liminal-space: routes requests on their exact path and checks Access's token itself.
// Static files never reach it; it answers the API routes and 404 otherwise.

import { answerAsk } from "./ask.ts";
import type { Env, RequestLog } from "./env.ts";
import { answerLogs } from "./logs.ts";
import { answerMcpMessage } from "./mcp.ts";
import { runNotifications } from "./notify.ts";
import {
	answerComments,
	answerFeedback,
	answerOwnerLogs,
	answerOwnerPushKey,
	answerOwnerState,
	answerPushSubscription,
	answerRead,
	answerStandout,
	answerTags,
	answerTakeaway,
} from "./owner/handlers.ts";
import { answerPush } from "./push.ts";
import { answerQueued, answerRequestUpdate, retryAdds } from "./requests.ts";
import { refuse } from "./respond.ts";
import { dispatch, type Route } from "./routes.ts";
import { runSchedule } from "./schedule.ts";

// The answer with "X-Content-Type-Options: nosniff", so a browser never guesses a type the Worker didn't state. The
// static files get theirs from the _headers that scripts/deploy/build-site.ts writes; every Worker answer, refusals and 404s
// included, goes through here. The body and headers are copied into a new Response, so a Response whose headers
// can't be changed (one fetched from elsewhere, say) is answered the same way.
function withNosniff(response: Response): Response {
	const answer = new Response(response.body, response);
	answer.headers.set("X-Content-Type-Options", "nosniff");
	return answer;
}

// The cron (wrangler.jsonc) that starts add.yml again for requests whose run couldn't start.
const ADD_RETRY_CRON = "*/15 * * * *";

// The routes, spelled exactly. Cloudflare's runtime resolves "." and ".." segments (also written %2e) before the
// Worker sees the URL; every other spelling (case, %2F, %70, "//", a trailing "/") is compared as sent, never
// decoded, so any of them is 404. wrangler.jsonc's assets.run_worker_first lists the same paths; a path with a dot or a
// trailing "/" never reaches the Worker. routes.ts lets only the site's own page send an owner POST.
const ROUTES: Route[] = [
	{
		path: "/liminal-space/api/sync/push",
		auth: "sync",
		methods: { POST: { handler: answerPush } },
	},
	{
		path: "/liminal-space/api/sync/requests",
		auth: "sync",
		methods: {
			GET: { handler: answerQueued },
			POST: { handler: answerRequestUpdate },
		},
	},
	{
		path: "/liminal-space/api/sync/logs",
		auth: "sync",
		methods: { POST: { handler: answerLogs } },
	},
	{
		path: "/liminal-space/mcp",
		auth: "connector",
		methods: { POST: { handler: answerMcpMessage } },
	},
	{
		path: "/liminal-space/api/owner/state",
		auth: "owner",
		methods: { GET: { handler: answerOwnerState } },
	},
	{
		path: "/liminal-space/api/owner/logs",
		auth: "owner",
		methods: { GET: { handler: answerOwnerLogs } },
	},
	{
		path: "/liminal-space/api/owner/takeaways",
		auth: "owner",
		methods: { POST: { handler: answerTakeaway } },
	},
	{
		path: "/liminal-space/api/owner/read",
		auth: "owner",
		methods: { POST: { handler: answerRead } },
	},
	{
		path: "/liminal-space/api/owner/tags",
		auth: "owner",
		methods: { POST: { handler: answerTags } },
	},
	{
		path: "/liminal-space/api/owner/feedback",
		auth: "owner",
		methods: { POST: { handler: answerFeedback } },
	},
	{
		path: "/liminal-space/api/owner/standouts",
		auth: "owner",
		methods: { POST: { handler: answerStandout } },
	},
	{
		path: "/liminal-space/api/owner/comments",
		auth: "owner",
		methods: { POST: { handler: answerComments } },
	},
	{
		path: "/liminal-space/api/owner/ask",
		auth: "owner",
		methods: { POST: { handler: answerAsk } },
	},
	{
		path: "/liminal-space/api/owner/push",
		auth: "owner",
		methods: {
			GET: { handler: answerOwnerPushKey },
			POST: { handler: answerPushSubscription },
		},
	},
];

// Every path the Worker answers, for wrangler.jsonc's run_worker_first to list (tests/unit/worker-routes.test.ts
// compares the two).
export const WORKER_PATHS = ROUTES.map((route) => route.path);

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const log: RequestLog = {
			method: request.method,
			path: new URL(request.url).pathname,
			status: 0,
			queries: 0,
			rowsRead: 0,
			rowsWritten: 0,
		};
		// Whatever happens, the request gets an answer and exactly one log line.
		let response: Response;
		try {
			response = await dispatch(ROUTES, request, env, ctx, log);
		} catch (error) {
			let reason = "the Worker failed";
			if (error instanceof Error) {
				reason = `the Worker failed: ${error.name}`;
			}
			response = refuse(log, 500, "internal error", reason);
		}
		log.status = response.status;
		console.log(JSON.stringify(log));
		return withNosniff(response);
	},

	// The 15-minute cron starts add.yml again for waiting add requests (requests.ts) and runs the notification step
	// (notify.ts), whose log line says what it did; the daily ones start the cloud scout (schedule.ts).
	async scheduled(controller: ScheduledController, env: Env): Promise<void> {
		if (controller.cron === ADD_RETRY_CRON) {
			await retryAdds(controller.cron, env);
			try {
				await runNotifications(new Date(controller.scheduledTime), env);
			} catch (error) {
				// Only the error's name: a library's message could quote what it was given.
				let reason = "notifications failed";
				if (error instanceof Error) {
					reason += `: ${error.name}`;
				}
				console.log(JSON.stringify({ notify: "failed", reason: reason }));
			}
			return;
		}
		await runSchedule(controller.cron, env);
	},
} satisfies ExportedHandler<Env>;
