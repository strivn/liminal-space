// Unit tests for the owner's service worker: showing a pushed notification,
// setting the badge, and opening the page on a tap (site/sw.ts). The worker's real code runs against a stand-in for
// the worker's global scope, which records what it was asked to show, to badge and to open. The module is loaded by
// its path at run time: it is typed for a worker, which the tests' type check doesn't load.
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, test, vi } from "vitest";

const SERVICE_WORKER = pathToFileURL(
	join(import.meta.dirname, "..", "..", "site", "sw.ts"),
).href;

type Listener = (event: unknown) => void;
type Shown = { title: string; options: { body?: string; tag?: string } };
type OpenWindow = { url: string; focused: boolean };

let listeners: Map<string, Listener>;
let shown: Shown[];
// Every call to the badge: the number set, or null for a clear.
let badge: (number | null)[];
let windows: OpenWindow[];
let opened: string[];

// The worker's scope as the service worker's code uses it, installed as `self` before the worker's module loads.
beforeEach(async () => {
	listeners = new Map();
	shown = [];
	badge = [];
	windows = [];
	opened = [];
	vi.stubGlobal("self", {
		addEventListener: (type: string, listener: Listener) => {
			listeners.set(type, listener);
		},
		registration: {
			showNotification: async (title: string, options: Shown["options"]) => {
				shown.push({ title: title, options: options });
			},
		},
		navigator: {
			setAppBadge: async (count: number) => {
				badge.push(count);
			},
			clearAppBadge: async () => {
				badge.push(null);
			},
		},
		clients: {
			matchAll: async () =>
				windows.map((each) => ({
					url: each.url,
					focus: async () => {
						each.focused = true;
					},
				})),
			openWindow: async (url: string) => {
				opened.push(url);
			},
		},
	});
	vi.resetModules();
	await import(SERVICE_WORKER);
});
afterEach(() => {
	vi.unstubAllGlobals();
});

// Deliver a push whose data is `data` (a function, so one can throw as a body that isn't JSON does) and wait for what
// the worker asked to wait on.
async function push(data: (() => unknown) | null): Promise<void> {
	let waiting: Promise<void> = Promise.resolve();
	const listener = listeners.get("push");
	assert.ok(listener, "the worker listens for push");
	listener({
		data: data === null ? null : { json: data },
		waitUntil: (work: Promise<void>) => {
			waiting = work;
		},
	});
	await waiting;
}

test('a push shows its line under the title "Liminal Space" and sets the badge to its number', async () => {
	const line = "The scout was up before you. No pressure.";
	await push(() => ({ kind: "digest", line: line, badge: 4 }));
	assert.equal(shown.length, 1);
	assert.equal(shown[0]?.title, "Liminal Space");
	assert.equal(shown[0]?.options.body, line);
	assert.deepEqual(badge, [4]);
});

test("a push with the number 0 clears the badge", async () => {
	await push(() => ({
		kind: "reminder",
		line: "One abstract. That's all it asks.",
		badge: 0,
	}));
	assert.equal(shown.length, 1);
	assert.deepEqual(badge, [null]);
});

test("a push whose payload can't be read still shows a notification, so iOS keeps the subscription", async () => {
	const unreadable: (() => unknown)[] = [
		() => {
			throw new SyntaxError("not JSON");
		},
		() => ({ kind: "digest", line: 7, badge: "four" }),
		() => "just text",
	];
	for (const data of [...unreadable, null]) {
		await push(data);
	}
	assert.equal(shown.length, unreadable.length + 1);
	for (const each of shown) {
		assert.equal(each.title, "Liminal Space");
		assert.equal(each.options.body, undefined);
	}
	assert.deepEqual(badge, []);
});

// Deliver a tap on a notification and wait for what the worker asked to wait on; returns whether it closed.
async function tap(): Promise<boolean> {
	let closed = false;
	let waiting: Promise<void> = Promise.resolve();
	const listener = listeners.get("notificationclick");
	assert.ok(listener, "the worker listens for a tap on a notification");
	listener({
		notification: {
			close: () => {
				closed = true;
			},
		},
		waitUntil: (work: Promise<void>) => {
			waiting = work;
		},
	});
	await waiting;
	return closed;
}

test("tapping a notification focuses the owner's page if one is open, and otherwise opens /liminal-space/owner/", async () => {
	windows = [
		{ url: "https://ivan.wiryadi.com/liminal-space/", focused: false },
		{
			url: "https://ivan.wiryadi.com/liminal-space/owner/#2026-09-27",
			focused: false,
		},
	];
	assert.equal(await tap(), true, "the tapped notification closes");
	assert.deepEqual(
		windows.map((each) => each.focused),
		[false, true],
	);
	assert.deepEqual(opened, []);

	// With only the public page open, the owner's page opens in a new window.
	windows = [
		{ url: "https://ivan.wiryadi.com/liminal-space/", focused: false },
	];
	await tap();
	assert.deepEqual(opened, ["/liminal-space/owner/"]);
	assert.equal(windows[0]?.focused, false);

	windows = [];
	await tap();
	assert.deepEqual(opened, ["/liminal-space/owner/", "/liminal-space/owner/"]);
});

test("the service worker answers no fetch, so the page always loads from the network", () => {
	assert.ok(listeners.size > 0, "the worker's listeners were registered");
	assert.equal(listeners.has("fetch"), false);
});
