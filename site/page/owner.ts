// The owner's state on the site: loading it, sending each change, and the notice.

import { isJsonObject } from "../../shared/narrow.ts";
import { fetchJson } from "./data.ts";
import { announce } from "./dom.ts";
import { feedbackOf, readStateOf, tagsOf, takeawaysOf } from "./state.ts";
import type { AllComments, OwnerData } from "./types.ts";

// The owner routes, relative to the owner's page.
export const OWNER_API = "../api/owner/";
// Why a change didn't reach the site; shown after "Not saved: " or "Not deleted: ".
export const UNREACHABLE = "couldn't reach the site";
// How long the page says a read or tag press wasn't saved.
const NOTICE_MS = 5000;

// The sessionStorage key that says this tab already signed in again.
export const SIGNED_IN_AGAIN = "liminal-signed-in-again";

// Sign in again through Access once per tab: Access's logout on the page's own host, which returns to this page and
// asks for a new sign-in. True when it left for the logout; false when this tab already tried, or its storage can't
// be used.
export function signInAgainOnce(storage: Storage, here: Location): boolean {
	try {
		if (storage.getItem(SIGNED_IN_AGAIN) !== null) return false;
		storage.setItem(SIGNED_IN_AGAIN, "1");
	} catch {
		return false;
	}
	const logout = new URL("/cdn-cgi/access/logout", here.origin);
	logout.searchParams.set("returnTo", here.href);
	here.assign(logout.href);
	return true;
}

// The owner's saved state from the site, "refused" when the Worker refused the sign-in (403), or null when it can't
// be read otherwise: no answer (Access's sign-in page included), another refusal, or an answer that isn't a state.
export async function loadOwnerState(): Promise<OwnerData | "refused" | null> {
	const answer = await fetchJson(`${OWNER_API}state`);
	if (answer.status === 403) return "refused";
	const json = answer.json;
	if (answer.status !== 200 || !isJsonObject(json)) return null;
	if (
		!isJsonObject(json.read) ||
		!isJsonObject(json.tags) ||
		!isJsonObject(json.comments) ||
		!isJsonObject(json.feedback) ||
		!isJsonObject(json.takeaways)
	)
		return null;
	// Comments by entry id in an object without a prototype, so an entry id "__proto__" is an ordinary key.
	const comments: AllComments = Object.create(null);
	for (const entryId of Object.keys(json.comments)) {
		comments[entryId] = json.comments[entryId];
	}
	return {
		read: readStateOf(json.read),
		tags: tagsOf(json.tags),
		comments: comments,
		feedback: feedbackOf(json.feedback),
		takeaways: takeawaysOf(json.takeaways),
	};
}

// POST one change (JSON text) to an owner route, as the Worker requires: the header "X-Liminal: 1", and the page's
// own Origin, which the browser adds. The answer, or null when none came.
export async function postChange(route: string, body: string) {
	try {
		return await fetch(`${OWNER_API}${route}`, {
			method: "POST",
			headers: { "X-Liminal": "1", "Content-Type": "application/json" },
			body: body,
		});
	} catch {
		return null;
	}
}

// The routes a change to one entry goes to.
export type OwnerRoute =
	| "read"
	| "tags"
	| "feedback"
	| "comments"
	| "takeaways";
// What createSender hands the rest of the page.
export type Sender = {
	send: (
		route: OwnerRoute,
		entryId: string,
		change: object,
	) => Promise<boolean>;
	pending: (route: OwnerRoute, entryId: string) => boolean;
	moves: () => number;
};

// Sends each change as one POST. Changes to one entry wait for the one before, so the site gets them in the order
// they were made. send's promise says whether the site saved the change; it never fails. pending says whether a
// change of `route` to an entry is still on its way. moves counts every change made and every answer to one, so a
// read of the site's state can tell whether a change crossed it.
export function createSender(): Sender {
	const queues = new Map<string, Promise<boolean>>(); // entry id -> its last change sent
	const waiting = new Map<string, number>(); // "<route> <entry id>" -> how many changes are on their way
	let moved = 0; // changes made plus changes answered, since the page opened

	function send(route: OwnerRoute, entryId: string, change: object) {
		// The body is written now, so a later change to the page's state can't change what this one sends.
		const body = JSON.stringify(change);
		const key = `${route} ${entryId}`;
		waiting.set(key, (waiting.get(key) || 0) + 1);
		moved += 1;
		const before = queues.get(entryId) || Promise.resolve(true);
		const sent = before
			.then(() => postChange(route, body))
			.then((response) => {
				moved += 1;
				const left = (waiting.get(key) || 1) - 1;
				if (left === 0) waiting.delete(key);
				else waiting.set(key, left);
				if (queues.get(entryId) === sent) queues.delete(entryId);
				return response !== null && response.status === 200;
			});
		queues.set(entryId, sent);
		return sent;
	}

	function pending(route: OwnerRoute, entryId: string) {
		return waiting.has(`${route} ${entryId}`);
	}

	function moves() {
		return moved;
	}

	return { send: send, pending: pending, moves: moves };
}

// Send a change; if the site did not store it, roll the page back (unless a later press supersedes it) and say so.
export function sendOrRollBack(
	sender: Sender,
	route: OwnerRoute,
	entryId: string,
	change: object,
	steps: {
		stored: () => void;
		superseded: () => boolean;
		rollBack: () => void;
	},
	notice: (text: string) => void,
	label: string,
): void {
	sender
		.send(route, entryId, change)
		.then((stored) => {
			if (stored) {
				steps.stored();
				return;
			}
			if (!steps.superseded()) steps.rollBack();
			notice(`Not saved: ${UNREACHABLE}`);
		})
		.catch((error) => console.error(label, error));
}

// A message at the foot of the window for NOTICE_MS, such as "Not saved: couldn't reach the site", said through the
// page's status region, so a screen reader speaks it too.
export function notice(text: string): void {
	announce(text, "notice", NOTICE_MS);
}

// A function that reads the site's state again and shows it. When it can't be read, the page keeps what it shows. When
// a change was made or answered while the read was on its way, the site may have read its state before or after that
// change, so the answer could undo it: read again instead. It says whether the state was read and shown.
export function createStateRefresh(
	sender: Sender,
	show: (fresh: OwnerData) => void,
): () => Promise<boolean> {
	async function refreshState(): Promise<boolean> {
		const movesBefore = sender.moves();
		const fresh = await loadOwnerState();
		if (fresh === null || fresh === "refused") {
			console.warn("The saved state couldn't be read again");
			return false;
		}
		if (sender.moves() !== movesBefore) {
			return refreshState();
		}
		show(fresh);
		return true;
	}
	return refreshState;
}

// Read the state again each time the page comes back into view, so a change made on another device shows.
export function refreshOnReturn(refreshState: () => Promise<boolean>): void {
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState !== "visible") return;
		refreshState().catch((error) =>
			console.error("The saved state not shown:", error),
		);
	});
}
