// Notifications to the owner's devices: the push subscription routes under
// /liminal-space/api/owner/push, and the 08:00 and 20:00 Jakarta sends, run from the 15-minute cron. Shapes:
// shared/owner-protocol.ts (routes) and shared/notify-protocol.ts (payload).
import { buildPushPayload, type VapidKeys } from "@block65/webcrypto-web-push";
import { isJsonObject } from "../../shared/narrow.ts";
import type {
	NotifyKind,
	NotifyPayload,
} from "../../shared/notify-protocol.ts";
import type {
	PushKeyAnswer,
	PushSubscriptionChange,
} from "../../shared/owner-protocol.ts";
import { type QueryCost, runBatch } from "./d1.ts";
import type { Env } from "./env.ts";

// The lines a notification can carry, one picked per Jakarta day. Dry on purpose, and never naming an entry, a title
// or a count, since a lock screen shows them.
export const DIGEST_LINES: string[] = [
	"Fresh papers are in. They won't read themselves, sadly.",
	"The scout was up before you. No pressure.",
	"Today's research has arrived, still warm.",
	"New papers. Your coffee and your conscience can split the job.",
	"The digest is here, looking at you expectantly.",
	"Another morning, another stack of things smarter than us.",
	"Papers delivered. Pretending you didn't see this is also an option.",
	"The scout brought gifts. Mostly PDFs.",
	"Your reading list grew overnight. As it does.",
	"Good morning. The abstracts have been waiting since dawn.",
];
export const REMINDER_LINES: string[] = [
	"Not one abstract today. Bold strategy.",
	"Your papers are starting to feel ignored.",
	"The streak is watching. Quietly. Judging.",
	"One abstract. That's all it asks.",
	"Today's papers are still unread, in case you were wondering.",
	"The heatmap has a blank square with your name on it.",
	"Even skimming counts. Just saying.",
	"The research didn't read itself. We checked.",
	"Five minutes, one abstract, eternal smugness.",
	"Tonight's square is still empty. No crown for that.",
];

// The most subscriptions kept: the owner's devices. A new one past this replaces the oldest.
const MAX_SUBSCRIPTIONS = 4;
// The longest endpoint kept; the real ones are a few hundred characters.
const MAX_ENDPOINT_CHARS = 2048;
// A subscription's keys as browsers write them, base64url without padding: p256dh is 65 bytes, auth is 16.
const P256DH_PATTERN = /^[A-Za-z0-9_-]{87}$/;
const AUTH_PATTERN = /^[A-Za-z0-9_-]{22}$/;

// Hosts of the push services as browsers report them (community allowlists agree on these; no vendor publishes a
// list): Google's one host, and the domains of Apple's (web.push.apple.com and its regional hosts), Mozilla's and
// Microsoft's (Edge, through WNS, which Microsoft says to accept only under notify.windows.com).
const PUSH_HOST = "fcm.googleapis.com";
const PUSH_DOMAINS = [
	".push.apple.com",
	".push.services.mozilla.com",
	".notify.windows.com",
];

// The push services a subscription's endpoint may point at: Apple's, Google's, Mozilla's and Microsoft's, on https at
// the default port with no login in the address. The Worker fetches the endpoint, so any other host is refused (a
// stored endpoint is otherwise a request the Worker makes to an address the sender chose).
function isPushEndpoint(endpoint: string): boolean {
	// The URL parser drops tabs and line breaks and trims control characters at the ends, so a string holding a control
	// character or a space is not the address it parses to.
	if (
		endpoint.length > MAX_ENDPOINT_CHARS ||
		[...endpoint].some((char) => char <= " " || char === "\u007f")
	) {
		return false;
	}
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return false;
	}
	if (
		url.protocol !== "https:" ||
		url.username !== "" ||
		url.password !== "" ||
		url.port !== ""
	) {
		return false;
	}
	return (
		url.hostname === PUSH_HOST ||
		PUSH_DOMAINS.some((domain) => url.hostname.endsWith(domain))
	);
}

const DAY_MS = 24 * 60 * 60 * 1000;

// The line of `kind` for a Jakarta date (YYYY-MM-DD): the same for every device that day.
export function lineOfDay(kind: NotifyKind, date: string): string {
	let lines = REMINDER_LINES;
	if (kind === "digest") {
		lines = DIGEST_LINES;
	}
	const day = Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
	const line = lines[day % lines.length];
	if (line === undefined) {
		throw new Error(`"${date}" is not a date`);
	}
	return line;
}

// GET push: the VAPID public key, PushKeyAnswer as JSON; 503 when the Worker has no VAPID keys (staging).
export function answerPushKey(env: Env): Response {
	if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
		return new Response("notifications are not set up", { status: 503 });
	}
	const answer: PushKeyAnswer = { publicKey: env.VAPID_PUBLIC_KEY };
	return Response.json(answer, { headers: { "Cache-Control": "no-store" } });
}

// A 400 with the reason as its text, for the page to show and the request's log line to keep.
function refuseSubscription(reason: string): Response {
	return new Response(reason, { status: 400 });
}

// The subscription a body holds, or why it isn't one. Fields a browser adds (expirationTime) are ignored.
function subscriptionOf(body: unknown): PushSubscriptionChange | string {
	if (
		!isJsonObject(body) ||
		typeof body.endpoint !== "string" ||
		!isJsonObject(body.keys) ||
		typeof body.keys.p256dh !== "string" ||
		typeof body.keys.auth !== "string"
	) {
		return "body is not a push subscription";
	}
	if (!isPushEndpoint(body.endpoint)) {
		return "endpoint is not on a known push service";
	}
	if (
		!P256DH_PATTERN.test(body.keys.p256dh) ||
		!AUTH_PATTERN.test(body.keys.auth)
	) {
		return "keys are not a push subscription's";
	}
	return {
		endpoint: body.endpoint,
		keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
	};
}

// POST push: check a PushSubscriptionChange and save it, 204; 400 with the reason for a body that isn't one or an
// endpoint off the known push services. The caller has checked Access, the owner's email, Origin and X-Liminal.
export async function savePushSubscription(
	body: unknown,
	env: Env,
): Promise<Response> {
	const subscription = subscriptionOf(body);
	if (typeof subscription === "string") {
		return refuseSubscription(subscription);
	}
	// One transaction: a device that subscribes again becomes the newest, and past MAX_SUBSCRIPTIONS the lowest ids go.
	await env.DB.batch([
		env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(
			subscription.endpoint,
		),
		env.DB.prepare(
			"INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES (?, ?, ?)",
		).bind(
			subscription.endpoint,
			subscription.keys.p256dh,
			subscription.keys.auth,
		),
		env.DB.prepare(
			"DELETE FROM push_subscriptions WHERE id NOT IN (SELECT id FROM push_subscriptions ORDER BY id DESC LIMIT ?)",
		).bind(MAX_SUBSCRIPTIONS),
	]);
	return new Response(null, { status: 204 });
}

// ---- sending ----

// The hours of Jakarta's day, UTC+7 with no daylight saving, when each notification goes out; the cron runs in them 4
// times, and notification_sends keeps all but one from sending.
const DIGEST_HOUR = 8;
const REMINDER_HOUR = 20;
const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;
// How long one push may take before the Worker stops waiting for that device, unless PUSH_TIMEOUT_MS says otherwise.
// Devices are sent to at the same time, so one that doesn't answer delays no other.
const PUSH_TIMEOUT_MS = 5000;
// How long a push service keeps a notification for a device that is off: 4 hours, so a reminder doesn't arrive after
// midnight. Apple needs a positive number.
const PUSH_TTL_SECONDS = 4 * 60 * 60;
// The most of a push service's answer kept for the log line.
const MAX_REASON_CHARS = 200;

type Subscription = { endpoint: string; p256dh: string; auth: string };
// What one push came to: the push service's host (never the endpoint's path, which is a secret address), the status it
// answered (0 when it didn't), and the reason it gave.
type Delivery = { host: string; status: number; reason: string; gone: boolean };

// The number in `row`'s column `name`, 0 when it has none.
function numberIn(row: Record<string, unknown> | undefined, name: string) {
	return Number(row?.[name] ?? 0);
}

// Where a push to `endpoint` is sent: the endpoint itself, or the same path on PUSH_SERVICE_ORIGIN when the tests set it.
function pushTarget(endpoint: string, env: Env): string {
	if (!env.PUSH_SERVICE_ORIGIN) {
		return endpoint;
	}
	const url = new URL(endpoint);
	return `${env.PUSH_SERVICE_ORIGIN}${url.pathname}${url.search}`;
}

// Send one device its notification: encrypted for its keys and signed with the VAPID keys (RFC 8291 and 8292, through
// @block65/webcrypto-web-push), within the push timeout. Never throws: a failure is a Delivery with status 0.
async function sendTo(
	subscription: Subscription,
	payload: NotifyPayload,
	vapid: VapidKeys,
	env: Env,
): Promise<Delivery> {
	const delivery: Delivery = {
		host: "unknown host",
		status: 0,
		reason: "",
		gone: false,
	};
	// The endpoint was checked when it was saved; it is checked again before the Worker makes a request to it.
	if (!isPushEndpoint(subscription.endpoint)) {
		delivery.reason = "endpoint is not on a known push service";
		return delivery;
	}
	delivery.host = new URL(subscription.endpoint).hostname;
	const timer = new AbortController();
	let timeoutMs = PUSH_TIMEOUT_MS;
	const configured = Number(env.PUSH_TIMEOUT_MS);
	if (Number.isFinite(configured) && configured > 0) {
		timeoutMs = configured;
	}
	const timeout = setTimeout(() => timer.abort(), timeoutMs);
	try {
		const request = await buildPushPayload(
			{ data: payload, options: { ttl: PUSH_TTL_SECONDS } },
			{
				endpoint: subscription.endpoint,
				expirationTime: null,
				keys: { p256dh: subscription.p256dh, auth: subscription.auth },
			},
			vapid,
		);
		// A redirect is not followed: only the endpoint's own host was checked, so a 3xx is a failed send.
		const response = await fetch(pushTarget(subscription.endpoint, env), {
			...request,
			redirect: "manual",
			signal: timer.signal,
		});
		delivery.status = response.status;
		// A push service says why it refused in the body: Apple's is JSON with a "reason".
		const text = (await response.text()).slice(0, MAX_REASON_CHARS);
		delivery.reason = text;
		try {
			const parsed: unknown = JSON.parse(text);
			if (isJsonObject(parsed) && typeof parsed.reason === "string") {
				delivery.reason = parsed.reason;
			}
		} catch {
			// Not JSON: the text stands.
		}
		delivery.gone = response.status === 404 || response.status === 410;
	} catch (error) {
		// Only the error's name: its message could quote the request.
		delivery.reason = "the push couldn't be sent";
		if (error instanceof Error) {
			delivery.reason += ` (${error.name})`;
		}
	} finally {
		clearTimeout(timeout);
	}
	return delivery;
}

// The one log line a notification step writes, as JSON: what it did or why it didn't, and the D1 cost.
type NotifyLog = {
	notify: NotifyKind;
	date: string;
	outcome: "sent" | "skipped";
	reason?: string;
	devices: number;
	delivered: number;
	removed: number;
	failed: { host: string; status: number; reason: string }[];
	queries: number;
	rowsRead: number;
	rowsWritten: number;
};

// Why a notification is not sent now, or null when it is: it already went out today, the digest has no entries (08:00),
// or there is no paper to read, or one was read (20:00).
function skipReason(
	kind: NotifyKind,
	sent: number,
	today: { entries: number; papers: number },
	readToday: number,
): string | null {
	if (sent > 0) {
		return "already sent today";
	}
	if (kind === "digest" && today.entries === 0) {
		return "no digest today";
	}
	if (kind === "reminder" && today.papers === 0) {
		return "no papers today";
	}
	if (kind === "reminder" && readToday > 0) {
		return "a paper was read today";
	}
	return null;
}

// The 15-minute cron's notification step: at 08:00 Jakarta the digest notification when today's digest has entries,
// at 20:00 the reminder when no paper was marked read that Jakarta day; at any other time nothing. Each goes out once
// a day. A subscription its push service answers 404 or 410 for is removed.
export async function runNotifications(now: Date, env: Env): Promise<void> {
	const jakarta = new Date(now.getTime() + JAKARTA_OFFSET_MS);
	const date = jakarta.toISOString().slice(0, 10);
	let kind: NotifyKind;
	if (jakarta.getUTCHours() === DIGEST_HOUR) {
		kind = "digest";
	} else if (jakarta.getUTCHours() === REMINDER_HOUR) {
		kind = "reminder";
	} else {
		return;
	}
	const log: NotifyLog = {
		notify: kind,
		date: date,
		outcome: "skipped",
		devices: 0,
		delivered: 0,
		removed: 0,
		failed: [],
		queries: 0,
		rowsRead: 0,
		rowsWritten: 0,
	};
	const count = (cost: QueryCost) => {
		log.queries += 1;
		log.rowsRead += cost.rowsRead;
		log.rowsWritten += cost.rowsWritten;
	};
	try {
		await sendNotification(kind, date, env, log, count);
	} finally {
		console.log(JSON.stringify(log));
	}
}

// One kind's turn for a Jakarta day: decide, claim the day, send to every device, drop the ones that are gone. Fills in
// `log` as it goes.
async function sendNotification(
	kind: NotifyKind,
	date: string,
	env: Env,
	log: NotifyLog,
	count: (cost: QueryCost) => void,
) {
	// A Worker without VAPID keys (staging) can't sign a push.
	if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
		log.reason = "no VAPID keys";
		return;
	}
	// Today's entries and papers with the papers not yet read, and the papers read on this Jakarta day: the digest's
	// entries are those dated today, a paper's read mark is dated the day it was pressed. Both are lookups by index.
	const [sentAnswer, todayAnswer, readAnswer] = await runBatch(
		env.DB,
		[
			env.DB.prepare(
				"SELECT COUNT(*) AS sent FROM notification_sends WHERE kind = ? AND date = ?",
			).bind(kind, date),
			env.DB.prepare(
				"SELECT COUNT(*) AS entries, " +
					"COALESCE(SUM(json_extract(e.json, '$.type') = 'paper'), 0) AS papers, " +
					"COALESCE(SUM(json_extract(e.json, '$.type') = 'paper' AND r.entry_id IS NULL), 0) AS unread " +
					"FROM entries e LEFT JOIN read_state r ON r.entry_id = e.id WHERE e.date = ?",
			).bind(date),
			env.DB.prepare(
				"SELECT COUNT(*) AS read FROM read_state r JOIN entries e ON e.id = r.entry_id " +
					"WHERE r.date = ? AND json_extract(e.json, '$.type') = 'paper'",
			).bind(date),
		],
		count,
	);
	const today = {
		entries: numberIn(todayAnswer?.results[0], "entries"),
		papers: numberIn(todayAnswer?.results[0], "papers"),
	};
	const unread = numberIn(todayAnswer?.results[0], "unread");
	const skip = skipReason(
		kind,
		numberIn(sentAnswer?.results[0], "sent"),
		today,
		numberIn(readAnswer?.results[0], "read"),
	);
	if (skip !== null) {
		log.reason = skip;
		return;
	}

	// Claim the day before sending: a run that starts at the same time finds the row and sends nothing.
	const [claim, subscribed] = await runBatch<Subscription>(
		env.DB,
		[
			env.DB.prepare(
				"INSERT OR IGNORE INTO notification_sends (kind, date) VALUES (?, ?)",
			).bind(kind, date),
			env.DB.prepare(
				"SELECT endpoint, p256dh, auth FROM push_subscriptions ORDER BY id",
			),
		],
		count,
	);
	if (claim?.meta.changes === 0) {
		log.reason = "already sent today";
		return;
	}
	const devices = subscribed?.results ?? [];
	log.devices = devices.length;
	if (devices.length === 0) {
		log.reason = "no devices";
		return;
	}

	// The badge number travels inside the encrypted payload; the push's headers and address carry nothing of it.
	const payload: NotifyPayload = {
		kind: kind,
		line: lineOfDay(kind, date),
		badge: unread,
	};
	const vapid: VapidKeys = {
		subject: env.SITE_ORIGIN,
		publicKey: env.VAPID_PUBLIC_KEY,
		privateKey: env.VAPID_PRIVATE_KEY,
	};
	const deliveries = await Promise.all(
		devices.map((device) => sendTo(device, payload, vapid, env)),
	);
	log.outcome = "sent";
	const gone: D1PreparedStatement[] = [];
	for (const [index, delivery] of deliveries.entries()) {
		if (delivery.status >= 200 && delivery.status < 300) {
			log.delivered += 1;
			continue;
		}
		log.failed.push({
			host: delivery.host,
			status: delivery.status,
			reason: delivery.reason,
		});
		const device = devices[index];
		if (delivery.gone && device !== undefined) {
			gone.push(
				env.DB.prepare(
					"DELETE FROM push_subscriptions WHERE endpoint = ?",
				).bind(device.endpoint),
			);
		}
	}
	if (gone.length > 0) {
		await runBatch(env.DB, gone, count);
		log.removed = gone.length;
	}
}
