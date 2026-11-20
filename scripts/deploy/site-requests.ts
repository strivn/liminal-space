// Requests to the hosted site, tried again on failure; the sync and add-requests programs share them.
import { setTimeout as pause } from "node:timers/promises";
import { request } from "../lib/http.ts";

const DEFAULT_URL = "https://ivan.wiryadi.com/liminal-space";
// Seconds to wait before each retry: 6 tries in about 31 seconds.
const RETRY_WAITS = [1, 2, 4, 8, 16];
// The length of a second for those waits; SYNC_RETRY_SECOND_MS shortens it (tests only).
const SECOND_MS = Number(process.env.SYNC_RETRY_SECOND_MS) || 1000;
// A request with no answer by then counts as a failed connection.
const REQUEST_TIMEOUT_MS = 60_000;

// A failure that stops the push. main prints it as one line, "sync.ts: <message>", instead of a stack trace, and
// sets the exit code without process.exit(), so output already written to a pipe isn't cut off.
export class SyncFailure extends Error {}

// The site's address, without a trailing slash.
export function siteBase() {
	return (process.env.LIMINAL_URL || DEFAULT_URL).replace(/\/+$/, "");
}

// One request, tried again after 1, 2, 4, 8 and 16 s on any answer other than 2xx or a failed connection. Returns
// the text of the 2xx answer; throws a SyncFailure after the sixth failed try. `command` ("push" or "pull") and
// `who` ("the site", "Cloudflare's API") name the request in messages; the request itself, with its token, never is.
export async function requestWithRetry(
	url: string,
	init: {
		method: string;
		headers: Record<string, string>;
		body: string | null;
	},
	command: string,
	who: string,
): Promise<string> {
	for (let attempt = 0; ; attempt++) {
		// One try: the answer's status and text, or status 0 when no answer came.
		let status = 0;
		let text = "";
		// redirect "manual": a redirect (such as Access's login page) is an answer other than 2xx, not a page to read.
		// biome-ignore lint/performance/noAwaitInLoops: each try waits for the one before it to fail
		const answer = await request(url, {
			method: init.method,
			headers: init.headers,
			body: init.body,
			userAgent: null,
			redirect: "manual",
			timeoutMs: REQUEST_TIMEOUT_MS,
		});
		// A failure's error isn't printed: only that no answer came, which stays status 0.
		if (!("problem" in answer)) {
			text = answer.text();
			status = answer.status;
		}
		if (status >= 200 && status < 300) {
			return text;
		}

		// Anything else is tried again, until the sixth try.
		let problem = `${who} answered ${status}`;
		let failure = `${who} answered ${status} six times`;
		if (status === 0) {
			problem = "couldn't connect";
			failure = `couldn't connect to ${who} six times`;
		}
		const wait = RETRY_WAITS[attempt];
		if (wait === undefined) {
			throw new SyncFailure(`${command} failed: ${failure}`);
		}
		console.log(`${problem}; trying again in ${wait} s`);
		await pause(wait * SECOND_MS);
	}
}
