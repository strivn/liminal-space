// Unit tests for the Worker's notifications: the subscription route, the 08:00 and
// 20:00 sends from the 15-minute cron, and the lines they carry (worker/src/notify.ts).
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import { MAX_OWNER_BODY_BYTES } from "../../shared/owner-protocol.ts";
import {
	type Device,
	newDevice,
	newVapidKeys,
	type PushServer,
	startPushService,
} from "../fixtures/web-push-device.ts";
import {
	type Access,
	loadNotify,
	loadWorker,
	migratedDatabase,
	ownerRequest,
	startAccess,
	workerEnv,
} from "../fixtures/worker-in-node.ts";

const PUSH_ROUTE = "/liminal-space/api/owner/push";
// The VAPID keys the Worker is given. The private one's random part can't show up in an answer or a log by chance.
const VAPID_PUBLIC_KEY = `BPublic${"A".repeat(80)}`;
const VAPID_PRIVATE_SECRET = `private-${crypto.randomUUID()}`;

let access: Access;
let db: DatabaseSync;
// Every console.log line the Worker wrote, as the strings it was given.
let logged: string[];

// The push service every device's endpoint leads to (the Worker's PUSH_SERVICE_ORIGIN points at it), and the VAPID pair
// the sending tests give the Worker.
let pushService: PushServer;
const vapid = newVapidKeys();

beforeAll(async () => {
	access = await startAccess();
	pushService = await startPushService();
});
afterAll(async () => {
	await access.close();
	await pushService.close();
});
beforeEach(() => {
	pushService.requests.length = 0;
	pushService.answers.clear();
	pushService.silent.clear();
	pushService.redirects.clear();
	db = migratedDatabase();
	logged = [];
	vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
		logged.push(parts.map(String).join(" "));
	});
});
afterEach(() => {
	vi.restoreAllMocks();
});

// A subscription as a browser gives it: an endpoint on a push service and keys of the right length (base64url,
// 65 and 16 bytes). `n` makes the endpoint unique.
function subscription(n: number, host = "web.push.apple.com") {
	return {
		endpoint: `https://${host}/wpush/v2/device-${n}`,
		keys: { p256dh: "B".repeat(87), auth: "C".repeat(22) },
	};
}

// The Worker's answer to a request to the push route, with its env holding the VAPID keys unless `extra` replaces them.
async function askWorker(
	options: Parameters<typeof ownerRequest>[2],
	extra: Record<string, unknown> = {},
) {
	const worker = await loadWorker();
	const env = workerEnv(access, db, {
		VAPID_PUBLIC_KEY: VAPID_PUBLIC_KEY,
		VAPID_PRIVATE_KEY: VAPID_PRIVATE_SECRET,
		...extra,
	});
	const request = await ownerRequest(access, PUSH_ROUTE, options);
	return await worker.fetch(request, env);
}

function savedEndpoints(): string[] {
	return db
		.prepare("SELECT endpoint FROM push_subscriptions ORDER BY id")
		.all()
		.map((row) => String(row.endpoint));
}

// Who may subscribe, and to what.
test("security: a subscription is saved only from the owner, with the site's Origin and the X-Liminal header", async () => {
	const body = JSON.stringify(subscription(1));
	const refused: [string, Parameters<typeof ownerRequest>[2]][] = [
		["no Access token", { body, email: null }],
		["another person's token", { body, email: "someone@example.com" }],
		["another site's Origin", { body, origin: "https://example.org" }],
		["no Origin", { body, origin: null }],
		["no X-Liminal header", { body, liminal: null }],
		["X-Liminal other than 1", { body, liminal: "0" }],
	];
	for (const [what, options] of refused) {
		const answer = await askWorker(options);
		assert.equal(answer.status, 403, what);
		assert.deepEqual(savedEndpoints(), [], `${what} saved a subscription`);
	}
	const saved = await askWorker({ body });
	assert.equal(saved.status, 204);
	assert.deepEqual(savedEndpoints(), [subscription(1).endpoint]);
});

test("security: a subscription whose endpoint is not https on Apple's, Google's, Mozilla's or Microsoft's push service is refused", async () => {
	const accepted = [
		"https://web.push.apple.com/QGxy",
		"https://fcm.googleapis.com/fcm/send/abc",
		"https://updates.push.services.mozilla.com/wpush/v2/abc",
		"https://wns2-sg2p.notify.windows.com/w/?token=abc",
	];
	const refused = [
		"http://web.push.apple.com/QGxy",
		"https://example.org/push",
		"https://fcm.googleapis.com.example.org/fcm/send/abc",
		"https://notpush.apple.com/x",
		"https://web.push.apple.com.evil.example/x",
		"https://web.push.apple.com@example.org/x",
		"https://user:password@fcm.googleapis.com/x",
		"https://fcm.googleapis.com:8443/x",
		"https://fcm.googleapis.com./x",
		"https://127.0.0.1/x",
		"https://localhost/x",
		"https://fcm.googleapis.com/x\n.example.org",
		"web.push.apple.com/x",
		"",
	];
	for (const [n, endpoint] of accepted.entries()) {
		const answer = await askWorker({
			body: JSON.stringify({ ...subscription(n), endpoint }),
		});
		assert.equal(answer.status, 204, endpoint);
	}
	assert.equal(savedEndpoints().length, accepted.length);
	for (const endpoint of refused) {
		const answer = await askWorker({
			body: JSON.stringify({ ...subscription(9), endpoint }),
		});
		assert.equal(answer.status, 400, endpoint);
	}
	assert.deepEqual(savedEndpoints(), accepted);
});

test("security: a subscription body over the owner routes' size limit is refused", async () => {
	const padding = "x".repeat(MAX_OWNER_BODY_BYTES);
	const answer = await askWorker({
		body: JSON.stringify({ ...subscription(1), padding }),
	});
	assert.equal(answer.status, 413);
	assert.deepEqual(savedEndpoints(), []);
});

test("security: at most 4 subscriptions are kept with the oldest replaced first, and a device that subscribes again becomes the newest", async () => {
	for (let n = 1; n <= 5; n++) {
		const answer = await askWorker({ body: JSON.stringify(subscription(n)) });
		assert.equal(answer.status, 204);
	}
	assert.deepEqual(
		savedEndpoints(),
		[2, 3, 4, 5].map((n) => subscription(n).endpoint),
	);

	// A device that subscribes again keeps one row and becomes the newest, with its new keys.
	const again = {
		...subscription(3),
		keys: { p256dh: "D".repeat(87), auth: "E".repeat(22) },
	};
	await askWorker({ body: JSON.stringify(again) });
	assert.deepEqual(
		savedEndpoints(),
		[2, 4, 5, 3].map((n) => subscription(n).endpoint),
	);
	const keys = db
		.prepare("SELECT p256dh, auth FROM push_subscriptions WHERE endpoint = ?")
		.get(again.endpoint);
	assert.deepEqual({ ...keys }, again.keys);
});

// ---- sending: the 15-minute cron's notification step ----

// A Sunday, and the cron's times on it: 08:00 and 20:00 in Jakarta (UTC+7) as UTC instants.
const TODAY = "2026-09-27";
const YESTERDAY = "2026-09-26";
const jakarta = (date: string, time: string) =>
	new Date(`${date}T${time}:00+07:00`);

// Add entries to the database as the digest of `date`, one of each type named; returns their ids. A paper's id is its
// number, so the same paper is the same entry in two calls.
let nextEntry = 1;
function addEntries(date: string, types: string[]): string[] {
	const insert = db.prepare(
		"INSERT INTO entries (id, date, seq, json, updated) VALUES (?, ?, ?, ?, '2026-09-27T00:00:00Z')",
	);
	return types.map((type) => {
		const n = nextEntry++;
		const id =
			type === "paper"
				? `arxiv:2609.${String(n).padStart(5, "0")}`
				: `${type}:${n}`;
		insert.run(
			id,
			date,
			n,
			JSON.stringify({ id: id, type: type, title: `Secret title ${n}` }),
		);
		return id;
	});
}
function markRead(id: string, date: string) {
	db.prepare(
		"INSERT INTO read_state (entry_id, depth, date) VALUES (?, 'abstract', ?)",
	).run(id, date);
}

// Subscribe a new device on the push service's stand-in, as POST push would have saved it.
let nextDevice = 1;
function subscribeDevice(): Device {
	const n = nextDevice++;
	const device = newDevice(`https://web.push.apple.com/wpush/device-${n}`);
	db.prepare(
		"INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES (?, ?, ?)",
	).run(
		device.subscription.endpoint,
		device.subscription.p256dh,
		device.subscription.auth,
	);
	return device;
}

// Fire the 15-minute cron at `time`, as Cloudflare does; the Worker gets the VAPID keys and the push service's origin
// unless `extra` replaces them.
async function cronAt(time: Date, extra: Record<string, unknown> = {}) {
	const worker = await loadWorker();
	const env = workerEnv(access, db, {
		VAPID_PUBLIC_KEY: vapid.publicKey,
		VAPID_PRIVATE_KEY: vapid.privateKey,
		PUSH_SERVICE_ORIGIN: pushService.origin,
		PUSH_TIMEOUT_MS: "300",
		...extra,
	});
	await worker.scheduled(
		{ cron: "*/15 * * * *", scheduledTime: time.getTime() },
		env,
	);
}

// What the push service was given for a device: each push's decrypted payload.
function payloadsTo(device: Device) {
	const path = new URL(device.subscription.endpoint).pathname;
	return pushService.requests
		.filter((request) => request.path === path)
		.map((request) => device.decrypt(request.body));
}

// The Worker's notification log lines (JSON with a "notify" field) so far.
function notifyLogs(): Record<string, unknown>[] {
	return logged
		.filter((text) => text.includes('"notify"'))
		.map((text) => JSON.parse(text));
}

// What a notification may carry.
test("privacy: a notification carries only its kind, one of the fixed lines and the badge, and no entry title", async () => {
	const { DIGEST_LINES, REMINDER_LINES } = await loadNotify();
	addEntries(TODAY, ["paper", "paper", "news"]);
	const device = subscribeDevice();
	await cronAt(jakarta(TODAY, "08:00"));
	await cronAt(jakarta(TODAY, "20:00"));
	const [digest, reminder] = payloadsTo(device) as Record<string, unknown>[];
	assert.equal(payloadsTo(device).length, 2);
	assert.equal(digest?.kind, "digest");
	assert.ok(DIGEST_LINES.includes(String(digest?.line)));
	assert.equal(reminder?.kind, "reminder");
	assert.ok(REMINDER_LINES.includes(String(reminder?.line)));
	// Only the kind, the line and the badge: no title and no entry.
	for (const payload of [digest, reminder]) {
		assert.deepEqual(Object.keys(payload ?? {}).sort(), [
			"badge",
			"kind",
			"line",
		]);
		assert.ok(!JSON.stringify(payload).includes("Secret title"));
	}
});
test("privacy: the badge number travels in the encrypted payload only", async () => {
	const ids = addEntries(TODAY, [
		"paper",
		"paper",
		"paper",
		"paper",
		"paper",
		"paper",
		"news",
		"news",
	]);
	markRead(ids[0] ?? "", TODAY);
	markRead(ids[1] ?? "", TODAY);
	const device = subscribeDevice();
	await cronAt(jakarta(TODAY, "08:00"));
	const request = pushService.requests[0];
	assert.ok(request, "a push was sent");
	const payload = device.decrypt(request.body) as Record<string, unknown>;
	// 6 papers, 2 read: the badge is 4, and nothing outside the encrypted body says so.
	assert.equal(payload.badge, 4);
	const outside = [
		request.path,
		JSON.stringify(request.headers),
		request.body.toString("latin1"),
	].join("\n");
	assert.ok(!outside.includes("badge"), "the word badge is outside the body");
	assert.ok(
		!outside.includes(String(payload.line)),
		"the line is outside the body",
	);
});
test("privacy: the VAPID private key never appears in a response, a log line or an error", async () => {
	// Every kind of answer the push route gives: the key, a saved subscription, refused bodies, a wrong method, a
	// refused owner, and a database that fails mid-save.
	const failingDb = {
		prepare: () => {
			throw new Error("database failed");
		},
		batch: () => Promise.reject(new Error("database failed")),
	};
	const answers = [
		await askWorker({ method: "GET" }),
		await askWorker({ body: JSON.stringify(subscription(1)) }),
		await askWorker({ body: "not json" }),
		await askWorker({
			body: JSON.stringify({ endpoint: "https://example.org" }),
		}),
		await askWorker({ body: JSON.stringify(subscription(2, "example.org")) }),
		await askWorker({ method: "GET", email: null }),
		await askWorker(
			{ body: JSON.stringify(subscription(3)) },
			{ DB: failingDb },
		),
	];
	const texts: string[] = [];
	for (const answer of answers) {
		texts.push(await answer.text());
		texts.push(JSON.stringify([...answer.headers]));
	}
	assert.equal(answers[0]?.status, 200);
	assert.match(texts[0] ?? "", new RegExp(VAPID_PUBLIC_KEY));
	assert.equal(answers[6]?.status, 503);
	for (const text of [...texts, ...logged]) {
		assert.ok(!text.includes(VAPID_PRIVATE_SECRET), "the private key leaked");
	}
	assert.ok(logged.length >= answers.length, "the Worker logs each request");

	// Sending: once with a private key that isn't a key, so the library throws for every device, and once with a real
	// one while one push service refuses and another never answers. The log lines hold neither key.
	addEntries(TODAY, ["paper"]);
	const devices = [subscribeDevice(), subscribeDevice(), subscribeDevice()];
	const path = (device: Device | undefined) =>
		new URL(device?.subscription.endpoint ?? "").pathname;
	pushService.answers.set(path(devices[1]), 500);
	pushService.silent.add(path(devices[2]));
	await cronAt(jakarta(TODAY, "08:00"), {
		VAPID_PRIVATE_KEY: VAPID_PRIVATE_SECRET,
	});
	db.exec("DELETE FROM notification_sends");
	await cronAt(jakarta(TODAY, "08:00"));
	const sendLogs = notifyLogs();
	assert.equal(sendLogs.length, 2);
	assert.equal(
		JSON.stringify(sendLogs[0]).includes("couldn't be sent"),
		true,
		"the first run failed for every device",
	);
	for (const text of logged) {
		assert.ok(!text.includes(VAPID_PRIVATE_SECRET), "the private key leaked");
		assert.ok(!text.includes(vapid.privateKey), "the real private key leaked");
	}
});

// When notifications go out.
// A fresh database and push service state, for a test that runs several cases.
function freshState() {
	db = migratedDatabase();
	pushService.requests.length = 0;
}

test("the digest notification goes out at 08:00 in Jakarta only when today's digest has entries", async () => {
	type Case = {
		what: string;
		entries: [string, string[]][];
		time: Date;
		pushes: number;
	};
	const cases: Case[] = [
		{
			what: "today's digest at 08:00",
			entries: [[TODAY, ["paper", "news"]]],
			time: jakarta(TODAY, "08:00"),
			pushes: 1,
		},
		{
			what: "today's digest at 08:45, the hour's last run",
			entries: [[TODAY, ["paper"]]],
			time: jakarta(TODAY, "08:45"),
			pushes: 1,
		},
		{
			what: "a digest of news alone",
			entries: [[TODAY, ["news"]]],
			time: jakarta(TODAY, "08:00"),
			pushes: 1,
		},
		{
			what: "the newest digest is yesterday's",
			entries: [[YESTERDAY, ["paper"]]],
			time: jakarta(TODAY, "08:00"),
			pushes: 0,
		},
		{
			what: "no digest at all",
			entries: [],
			time: jakarta(TODAY, "08:00"),
			pushes: 0,
		},
		{
			what: "07:45",
			entries: [[TODAY, ["paper"]]],
			time: jakarta(TODAY, "07:45"),
			pushes: 0,
		},
		{
			what: "09:00",
			entries: [[TODAY, ["paper"]]],
			time: jakarta(TODAY, "09:00"),
			pushes: 0,
		},
		{
			what: "noon",
			entries: [[TODAY, ["paper"]]],
			time: jakarta(TODAY, "12:00"),
			pushes: 0,
		},
	];
	for (const each of cases) {
		freshState();
		for (const [date, types] of each.entries) addEntries(date, types);
		subscribeDevice();
		await cronAt(each.time);
		assert.equal(
			pushService.requests.length,
			each.pushes,
			`${each.what}: ${each.pushes} pushes`,
		);
	}
});

test("the reminder goes out at 20:00 in Jakarta only when no paper was marked read that day in Jakarta", async () => {
	type Setup = () => void;
	const cases: { what: string; setup: Setup; time: Date; pushes: number }[] = [
		{
			what: "papers today, none read",
			setup: () => addEntries(TODAY, ["paper", "paper"]),
			time: jakarta(TODAY, "20:00"),
			pushes: 1,
		},
		{
			what: "a paper read today",
			setup: () =>
				markRead(addEntries(TODAY, ["paper", "paper"])[0] ?? "", TODAY),
			time: jakarta(TODAY, "20:00"),
			pushes: 0,
		},
		{
			what: "a paper of an older day read today",
			setup: () => {
				addEntries(TODAY, ["paper"]);
				markRead(addEntries(YESTERDAY, ["paper"])[0] ?? "", TODAY);
			},
			time: jakarta(TODAY, "20:00"),
			pushes: 0,
		},
		{
			what: "a paper read yesterday only",
			setup: () => markRead(addEntries(TODAY, ["paper"])[0] ?? "", YESTERDAY),
			time: jakarta(TODAY, "20:00"),
			pushes: 1,
		},
		{
			what: "only a news item read today",
			setup: () =>
				markRead(addEntries(TODAY, ["paper", "news"])[1] ?? "", TODAY),
			time: jakarta(TODAY, "20:00"),
			pushes: 1,
		},
		{
			what: "a digest of news alone",
			setup: () => addEntries(TODAY, ["news"]),
			time: jakarta(TODAY, "20:00"),
			pushes: 0,
		},
		{
			what: "no digest at all",
			setup: () => {},
			time: jakarta(TODAY, "20:00"),
			pushes: 0,
		},
		{
			what: "19:45",
			setup: () => addEntries(TODAY, ["paper"]),
			time: jakarta(TODAY, "19:45"),
			pushes: 0,
		},
		{
			what: "21:00",
			setup: () => addEntries(TODAY, ["paper"]),
			time: jakarta(TODAY, "21:00"),
			pushes: 0,
		},
	];
	for (const each of cases) {
		freshState();
		each.setup();
		subscribeDevice();
		await cronAt(each.time);
		assert.equal(
			pushService.requests.length,
			each.pushes,
			`${each.what}: ${each.pushes} pushes`,
		);
	}
});

test("limit: each notification goes out at most once a Jakarta day, even if the cron runs twice in that slot", async () => {
	addEntries(TODAY, ["paper"]);
	addEntries("2026-09-28", ["paper"]);
	const device = subscribeDevice();
	// Runs one after another in the hour, then two that start together.
	await cronAt(jakarta(TODAY, "08:00"));
	await cronAt(jakarta(TODAY, "08:15"));
	await Promise.all([
		cronAt(jakarta(TODAY, "08:30")),
		cronAt(jakarta(TODAY, "08:30")),
	]);
	assert.equal(payloadsTo(device).length, 1);

	// The reminder is its own notification, once; and the next day's digest goes out again.
	await Promise.all([
		cronAt(jakarta(TODAY, "20:00")),
		cronAt(jakarta(TODAY, "20:00")),
	]);
	await cronAt(jakarta(TODAY, "20:15"));
	await cronAt(jakarta("2026-09-28", "08:00"));
	await cronAt(jakarta("2026-09-28", "08:15"));
	assert.deepEqual(
		payloadsTo(device).map((payload) => (payload as { kind: string }).kind),
		["digest", "reminder", "digest"],
	);
});

test("the line of the day is picked from the date, so every device gets the same line that day", async () => {
	const { lineOfDay, DIGEST_LINES } = await loadNotify();
	addEntries(TODAY, ["paper"]);
	const devices = [subscribeDevice(), subscribeDevice(), subscribeDevice()];
	await cronAt(jakarta(TODAY, "08:00"));
	const lines = devices.map(
		(device) => (payloadsTo(device)[0] as { line: string }).line,
	);
	assert.equal(new Set(lines).size, 1, "every device got the same line");
	assert.equal(lines[0], lineOfDay("digest", TODAY));

	// The same date gives the same line however often it is asked, and the next day gives another.
	let before = lineOfDay("digest", "2026-09-01");
	for (let day = 2; day <= DIGEST_LINES.length * 2; day++) {
		const date = `2026-09-${String(day).padStart(2, "0")}`;
		assert.equal(lineOfDay("digest", date), lineOfDay("digest", date));
		assert.notEqual(lineOfDay("digest", date), before, date);
		before = lineOfDay("digest", date);
	}
});

test("a Worker without VAPID keys sends nothing and logs why, and sends the day's notification once the keys are set", async () => {
	addEntries(TODAY, ["paper"]);
	subscribeDevice();
	await cronAt(jakarta(TODAY, "08:00"), {
		VAPID_PUBLIC_KEY: undefined,
		VAPID_PRIVATE_KEY: undefined,
	});
	assert.equal(pushService.requests.length, 0);
	const [line] = notifyLogs();
	assert.equal(line?.outcome, "skipped");
	assert.match(String(line?.reason), /VAPID/);
	// Nothing was claimed, so keys set later send the day's notification.
	assert.equal(
		db.prepare("SELECT COUNT(*) AS n FROM notification_sends").get()?.n,
		0,
	);
	await cronAt(jakarta(TODAY, "08:15"));
	assert.equal(pushService.requests.length, 1);
});

// What a push service answers.
// The path a device's endpoint has on the push service.
const pathOf = (device: Device) =>
	new URL(device.subscription.endpoint).pathname;
const endpointsKept = () =>
	db
		.prepare("SELECT endpoint FROM push_subscriptions ORDER BY id")
		.all()
		.map((row) => String(row.endpoint));

test("a push service answering 404 or 410 removes that subscription", async () => {
	addEntries(TODAY, ["paper"]);
	const [gone410, gone404, fine] = [
		subscribeDevice(),
		subscribeDevice(),
		subscribeDevice(),
	] as [Device, Device, Device];
	pushService.answers.set(pathOf(gone410), 410);
	pushService.answers.set(pathOf(gone404), 404);
	await cronAt(jakarta(TODAY, "08:00"));
	assert.deepEqual(endpointsKept(), [fine.subscription.endpoint]);
	assert.equal(payloadsTo(fine).length, 1);
	const [line] = notifyLogs();
	assert.equal(line?.removed, 2);
});

test("a push service that fails or times out keeps the subscription, and the other devices still get their push", async () => {
	addEntries(TODAY, ["paper"]);
	const [refusing, silent, fine] = [
		subscribeDevice(),
		subscribeDevice(),
		subscribeDevice(),
	] as [Device, Device, Device];
	pushService.answers.set(pathOf(refusing), 500);
	pushService.silent.add(pathOf(silent));
	await cronAt(jakarta(TODAY, "08:00"));
	assert.equal(endpointsKept().length, 3, "no subscription was removed");
	assert.equal(
		payloadsTo(fine).length,
		1,
		"the other device still got its push",
	);
	// The log names each failure: the host, the status (0 when none came) and the push service's reason.
	const [line] = notifyLogs();
	assert.deepEqual(line?.failed, [
		{ host: "web.push.apple.com", status: 500, reason: "Answered500" },
		{
			host: "web.push.apple.com",
			status: 0,
			reason: "the push couldn't be sent (AbortError)",
		},
	]);
	assert.equal(line?.delivered, 1);
	assert.equal(line?.removed, 0);
});

test("security: a push service's redirect is not followed", async () => {
	addEntries(TODAY, ["paper"]);
	const [redirecting, fine] = [subscribeDevice(), subscribeDevice()] as [
		Device,
		Device,
	];
	// The push service answers 302 to another address, which would answer 201 if the Worker went there: the Worker only
	// checked the host it was first sent to.
	const elsewhere = "/wpush/elsewhere";
	pushService.redirects.set(pathOf(redirecting), elsewhere);
	await cronAt(jakarta(TODAY, "08:00"));
	assert.equal(
		pushService.requests.filter((request) => request.path === elsewhere).length,
		0,
		"the redirect was followed",
	);
	// The redirect is a failed send: the subscription stays and the other device is still sent to.
	assert.equal(endpointsKept().length, 2);
	assert.equal(payloadsTo(fine).length, 1);
	const [line] = notifyLogs();
	assert.equal(line?.removed, 0);
	assert.deepEqual(line?.failed, [
		{ host: "web.push.apple.com", status: 302, reason: "" },
	]);
});

test("security: a stored subscription whose endpoint is on another host is refused with no request sent", async () => {
	addEntries(TODAY, ["paper"]);
	const fine = subscribeDevice();
	// A row written past the route's check: the push service's stand-in answers any path, so a request would show.
	const planted = newDevice("https://example.org/wpush/planted");
	db.prepare(
		"INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES (?, ?, ?)",
	).run(
		planted.subscription.endpoint,
		planted.subscription.p256dh,
		planted.subscription.auth,
	);
	await cronAt(jakarta(TODAY, "08:00"));
	assert.deepEqual(payloadsTo(planted), [], "the other host was sent a push");
	assert.equal(payloadsTo(fine).length, 1);
	const [line] = notifyLogs();
	assert.deepEqual(line?.failed, [
		{
			host: "unknown host",
			status: 0,
			reason: "endpoint is not on a known push service",
		},
	]);
});

// Cost on the free plan.
test("limit: sending to 4 subscriptions stays under 20 ms of CPU and 50 subrequests", async () => {
	for (let n = 0; n < 4; n++) subscribeDevice();
	// Pushes go to a stand-in fetch, so the measure holds the Worker's own work (encrypting, signing, its D1 calls) and
	// not a local server's. Six days run one after another; the first warms Node's crypto and compiler up, and the
	// median of the other five is the measure, so one slow run on a busy machine doesn't decide it.
	const subrequests: string[] = [];
	vi.stubGlobal("fetch", async (url: string) => {
		subrequests.push(url);
		return new Response(null, { status: 201 });
	});
	const cpuTimes: number[] = [];
	for (let day = 1; day <= 6; day++) {
		const date = `2026-10-0${day}`;
		addEntries(date, ["paper", "paper", "news"]);
		const before = process.cpuUsage();
		await cronAt(jakarta(date, "08:00"), { PUSH_SERVICE_ORIGIN: undefined });
		const used = process.cpuUsage(before);
		cpuTimes.push((used.user + used.system) / 1000);
	}
	vi.unstubAllGlobals();
	const median = cpuTimes.slice(1).sort((a, b) => a - b)[2] ?? Infinity;
	assert.equal(subrequests.length, 6 * 4);
	for (const line of notifyLogs()) {
		assert.equal(line.delivered, 4);
		// The pushes and the D1 statements are each a call from the Worker, and one run makes both.
		assert.ok(4 + Number(line.queries) <= 50, `${line.queries} statements`);
	}
	assert.ok(median < 20, `${median} ms of CPU for 4 pushes`);
});
