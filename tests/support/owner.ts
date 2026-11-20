// Owner-route helpers for the unit tests: the Worker's owner routes with the owner's login token, as the owner's page
// sends it, straight to the Worker.
import { isJsonObject } from "../../shared/narrow.ts";
import type { OwnerState } from "../../shared/owner-protocol.ts";
import { SITE_ORIGIN } from "../fixtures/worker-in-node.ts";
import type { Answer, Cloud } from "./cloud.ts";
import {
	browserHeaders,
	firstKey,
	OWNER_EMAIL,
	ownerClaims,
	sendToWorker,
	signToken,
	startWorker,
} from "./cloud.ts";

// The owner routes (shared/owner-protocol.ts).
const STATE_PATH = "/liminal-space/api/owner/state";
export const COMMENTS_PATH = "/liminal-space/api/owner/comments";
export const ASK_PATH = "/liminal-space/api/owner/ask";

// The origin the Worker takes as the site's own: the page server's when one started it, wrangler.jsonc's otherwise.
function siteOriginOf(cloud: Cloud): string {
	if (cloud.siteOrigin !== null) {
		return cloud.siteOrigin;
	}
	return SITE_ORIGIN;
}

// A login token for the owner app, as Access signs it for `email` (the owner's by default).
export function ownerToken(cloud: Cloud, email?: string): Promise<string> {
	return signToken(firstKey(cloud), ownerClaims(cloud, email || OWNER_EMAIL));
}

// The headers the owner's page sends with a change, and the login Access adds, in the header and in the browser's
// CF_Authorization cookie: JSON, "X-Liminal: 1", the site's origin.
export async function ownerHeaders(
	cloud: Cloud,
): Promise<Record<string, string>> {
	return Object.assign(
		{
			"Content-Type": "application/json",
			"X-Liminal": "1",
			Origin: siteOriginOf(cloud),
		},
		browserHeaders(await ownerToken(cloud)),
	);
}

// The answer's body for a failure message, shortened.
function bodyNote(answer: Answer): string {
	if (answer.body.includes("<html")) {
		return "the local runtime's HTML error page (the Worker threw)";
	}
	return JSON.stringify(answer.body.slice(0, 300));
}

// The site's saved state, read straight from the Worker with the owner's token. Fails, naming the answer, unless it
// is 200 with the three parts of OwnerState.
export async function readSiteState(cloud: Cloud): Promise<OwnerState> {
	const headers = browserHeaders(await ownerToken(cloud));
	const answer = await sendToWorker(cloud, "GET", STATE_PATH, headers, null);
	if (answer.status !== 200) {
		throw new Error(
			`reading the site's saved state: GET ${STATE_PATH} answered ${answer.status}, ${bodyNote(answer)}`,
		);
	}
	const parsed: unknown = JSON.parse(answer.body);
	if (
		!isJsonObject(parsed) ||
		!isJsonObject(parsed.read) ||
		!isJsonObject(parsed.tags) ||
		!isJsonObject(parsed.comments)
	) {
		throw new Error(
			`the site's saved state isn't {"read", "tags", "comments"}: ${answer.body.slice(0, 300)}`,
		);
	}
	// Checked above: an object holding the three parts; their insides are left for the test to compare.
	const state: OwnerState = JSON.parse(answer.body);
	return state;
}

// Send one change straight to the Worker, as the owner's page sends it, and return the answer.
export async function postToSite(
	cloud: Cloud,
	routePath: string,
	body: unknown,
): Promise<Answer> {
	return sendToWorker(
		cloud,
		"POST",
		routePath,
		await ownerHeaders(cloud),
		JSON.stringify(body),
	);
}

// Ask Claude about a thread, as the owner's page does: the answer as it streams, for a test that reads it piece by piece
// or lets go of it (`signal`) before it ends.
export async function openAsk(
	cloud: Cloud,
	body: unknown,
	signal?: AbortSignal,
): Promise<Response> {
	await startWorker(cloud);
	if (cloud.workerUrl === null) {
		throw new Error("the Worker has no URL");
	}
	return fetch(cloud.workerUrl + ASK_PATH, {
		method: "POST",
		headers: await ownerHeaders(cloud),
		body: JSON.stringify(body),
		signal: signal ?? null,
	});
}
