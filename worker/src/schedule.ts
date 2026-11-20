// The Worker's cron triggers (wrangler.jsonc): "0 22 * * *" and "0 23 * * *" dispatch scout.yml on main, 05:00 and
// 06:00 in Jakarta, hours before arXiv's 20:00 New York announcement, when its API refuses most requests; the workflow
// itself skips the session when today already has its papers.
// "*/15 * * * *" starts add.yml again for add requests still queued, or left running by a run that died (requests.ts).
import type { Env } from "./env.ts";

// The branch dispatched workflows run on: main is production, and its workflows refuse any other.
const REF = "main";
// The REST API version the request is written for (https://docs.github.com/en/rest/about-the-rest-api/api-versions).
const API_VERSION = "2022-11-28";

// The one log line a cron run writes, with console.log as JSON: the cron, GitHub's status (0 when GitHub couldn't be
// reached), and why the dispatch failed. Never the token.
type ScheduleLog = { cron: string; status: number; reason?: string };

// What a dispatch did: GitHub's status (0 when GitHub couldn't be reached), and why it failed.
type Dispatch = { status: number; reason?: string };

// Ask GitHub to run `workflow` on main, with no inputs: POST <GITHUB_API>/repos/<GITHUB_REPOSITORY>/actions/
// workflows/<workflow>/dispatches {"ref": "main"}, with GITHUB_DISPATCH_TOKEN as a bearer token. `what` names the
// run in the reason ("the scout"). The reason never holds the token.
export async function dispatchWorkflow(
	env: Env,
	workflow: string,
	what: string,
): Promise<Dispatch> {
	const api = env.GITHUB_API.replace(/\/+$/, "");
	const url = `${api}/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${workflow}/dispatches`;

	// GitHub answers 204 when the run is queued. Its API refuses a request without a User-Agent.
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
				Accept: "application/vnd.github+json",
				"Content-Type": "application/json",
				"User-Agent": "liminal-space-worker",
				"X-GitHub-Api-Version": API_VERSION,
			},
			body: JSON.stringify({ ref: REF }),
		});
		if (!response.ok) {
			return {
				status: response.status,
				reason: `${what} couldn't be dispatched: GitHub answered ${response.status}`,
			};
		}
		return { status: response.status };
	} catch (error) {
		// Only the error's name: its message could quote the request.
		let reason = `${what} couldn't be dispatched: GitHub couldn't be reached`;
		if (error instanceof Error) {
			reason += ` (${error.name})`;
		}
		return { status: 0, reason: reason };
	}
}

// Ask GitHub to run scout.yml on main, with no inputs. A refusal is logged as one JSON line naming the cron and
// GitHub's status, never the token.
export async function runSchedule(cron: string, env: Env): Promise<void> {
	const dispatch = await dispatchWorkflow(env, "scout.yml", "the scout");
	const log: ScheduleLog = { cron: cron, status: dispatch.status };
	if (dispatch.reason !== undefined) {
		log.reason = dispatch.reason;
	}
	console.log(JSON.stringify(log));
}
