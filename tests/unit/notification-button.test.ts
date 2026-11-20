// @vitest-environment jsdom
// The owner's page side of notifications (site/page/notifications.ts): the button, this device's subscription and the badge.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { startStatusRegion } from "../../site/page/dom.ts";
import {
	notificationButton,
	showBadge,
	TURN_ON_NOTIFICATIONS,
} from "../../site/page/notifications.ts";

type Permission = "default" | "granted" | "denied";

// A browser that can take notifications, asked or not, holding a subscription or not.
function browser(options: {
	permission: Permission;
	subscribed?: boolean;
	answer?: Permission;
}) {
	const requestPermission = vi.fn(async () => options.answer || "granted");
	const fakeNotification = Object.assign(() => {}, {
		permission: options.permission,
		requestPermission: requestPermission,
	});
	vi.stubGlobal("Notification", fakeNotification);
	vi.stubGlobal("PushManager", class {});
	const subscription = {
		endpoint: "https://web.push.apple.com/abc",
		keys: { p256dh: "k", auth: "a" },
	};
	const subscribe = vi.fn(async () => subscription);
	const register = vi.fn(async () => ({
		pushManager: {
			subscribe: subscribe,
			getSubscription: async () => (options.subscribed ? subscription : null),
		},
	}));
	Object.defineProperty(navigator, "serviceWorker", {
		value: {
			register: register,
			ready: Promise.resolve(),
			getRegistration: async () => {
				if (options.subscribed === undefined) return undefined;
				return {
					pushManager: {
						getSubscription: async () =>
							options.subscribed ? subscription : null,
					},
				};
			},
		},
		configurable: true,
	});
	return { requestPermission, register, subscribe, subscription };
}

// A fetch that answers the site's key and takes the subscription.
function site(options: { key?: unknown; postStatus?: number } = {}) {
	const calls: { url: string; init: RequestInit | undefined }[] = [];
	vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
		calls.push({ url: url, init: init });
		if (init?.method === "POST")
			return new Response(null, { status: options.postStatus || 204 });
		if (options.key === null) return new Response("{}", { status: 503 });
		return new Response(JSON.stringify(options.key || { publicKey: "AQID" }), {
			status: 200,
		});
	});
	return calls;
}

beforeEach(() => {
	startStatusRegion();
});

afterEach(() => {
	vi.unstubAllGlobals();
	Reflect.deleteProperty(navigator, "serviceWorker");
	document.body.replaceChildren();
});

describe("the button", () => {
	test("a browser that supports notifications and was never asked shows the Turn on notifications button", () => {
		browser({ permission: "default" });
		const button = notificationButton();
		expect(button?.textContent).toBe(TURN_ON_NOTIFICATIONS);
		expect(button?.hidden).toBe(false);
	});

	test("a browser without push, or one that refused, gets no button", () => {
		browser({ permission: "denied" });
		expect(notificationButton()).toBeNull();

		browser({ permission: "default" });
		Reflect.deleteProperty(window, "PushManager");
		expect(notificationButton()).toBeNull();

		browser({ permission: "default" });
		Reflect.deleteProperty(navigator, "serviceWorker");
		expect(notificationButton()).toBeNull();
	});

	test("a browser that allowed notifications shows the button again only when it holds no subscription", async () => {
		browser({ permission: "granted", subscribed: false });
		const lost = notificationButton() as HTMLButtonElement;
		expect(lost.hidden).toBe(true);
		await vi.waitFor(() => expect(lost.hidden).toBe(false));

		browser({ permission: "granted", subscribed: true });
		const holding = notificationButton() as HTMLButtonElement;
		document.body.append(holding);
		await vi.waitFor(() => expect(holding.isConnected).toBe(false));
	});

	test("a browser that allowed notifications but never registered a service worker is offered the button", async () => {
		browser({ permission: "granted" });
		const button = notificationButton() as HTMLButtonElement;
		await vi.waitFor(() => expect(button.hidden).toBe(false));
	});
});

describe("turning notifications on", () => {
	test("a tap asks for permission at once, and a yes subscribes the device and saves the subscription on the site", async () => {
		const device = browser({ permission: "default" });
		const calls = site();
		const button = notificationButton() as HTMLButtonElement;
		document.body.append(button);
		button.click();
		// Straight from the tap, before anything is awaited: iOS allows the question from no other place.
		expect(device.requestPermission).toHaveBeenCalledTimes(1);

		await vi.waitFor(() => expect(button.isConnected).toBe(false));
		expect(device.register).toHaveBeenCalledWith("sw.js", { scope: "./" });
		expect(device.subscribe).toHaveBeenCalledWith({
			userVisibleOnly: true,
			applicationServerKey: Uint8Array.from([1, 2, 3]),
		});
		const saved = calls.find((call) => call.init?.method === "POST");
		expect(saved?.url).toBe("../api/owner/push");
		expect(saved?.init?.headers).toMatchObject({ "X-Liminal": "1" });
		expect(JSON.parse(String(saved?.init?.body))).toEqual(device.subscription);
	});

	test("answering no removes the button and subscribes nothing", async () => {
		const device = browser({ permission: "default", answer: "denied" });
		const calls = site();
		const button = notificationButton() as HTMLButtonElement;
		document.body.append(button);
		button.click();
		await vi.waitFor(() => expect(button.isConnected).toBe(false));
		expect(device.register).not.toHaveBeenCalled();
		expect(calls).toHaveLength(0);
	});

	test.each([
		[
			"a site that has no key to give",
			{ key: null },
			"the site can't send notifications",
		],
		[
			"a site that does not take the subscription",
			{ postStatus: 500 },
			"couldn't reach the site",
		],
	])("%s leaves the button and says why", async (_name, options, reason) => {
		browser({ permission: "default" });
		site(options);
		const button = notificationButton() as HTMLButtonElement;
		document.body.append(button);
		button.click();
		await vi.waitFor(() =>
			expect(document.querySelector('[role="status"]')?.textContent).toContain(
				`Notifications weren't turned on: ${reason}`,
			),
		);
		expect(button.isConnected).toBe(true);
	});

	test("a browser that can't subscribe leaves the button and says so", async () => {
		const device = browser({ permission: "default" });
		device.subscribe.mockRejectedValue(new Error("no push service"));
		site();
		vi.spyOn(console, "error").mockImplementation(() => {});
		const button = notificationButton() as HTMLButtonElement;
		document.body.append(button);
		button.click();
		await vi.waitFor(() =>
			expect(document.querySelector('[role="status"]')?.textContent).toContain(
				"this browser couldn't subscribe",
			),
		);
		expect(button.isConnected).toBe(true);
	});
});

describe("the badge", () => {
	const badges = () => {
		const setAppBadge = vi.fn(async () => {});
		const clearAppBadge = vi.fn(async () => {});
		Object.defineProperty(navigator, "setAppBadge", {
			value: setAppBadge,
			configurable: true,
		});
		Object.defineProperty(navigator, "clearAppBadge", {
			value: clearAppBadge,
			configurable: true,
		});
		return { setAppBadge, clearAppBadge };
	};
	afterEach(() => {
		Reflect.deleteProperty(navigator, "setAppBadge");
		Reflect.deleteProperty(navigator, "clearAppBadge");
	});

	test("the badge is set to the given count, and a count of 0 clears it", async () => {
		browser({ permission: "granted", subscribed: true });
		const badge = badges();
		await showBadge(3);
		expect(badge.setAppBadge).toHaveBeenCalledWith(3);
		await showBadge(0);
		expect(badge.clearAppBadge).toHaveBeenCalledTimes(1);
		expect(badge.setAppBadge).toHaveBeenCalledTimes(1);
	});

	test("without permission, or where the badge isn't supported, nothing is set and nothing fails", async () => {
		browser({ permission: "default" });
		const badge = badges();
		await showBadge(3);
		expect(badge.setAppBadge).not.toHaveBeenCalled();

		browser({ permission: "granted" });
		Reflect.deleteProperty(navigator, "setAppBadge");
		await expect(showBadge(3)).resolves.toBeUndefined();
	});

	test("when the browser refuses the badge, a warning is logged and nothing fails", async () => {
		browser({ permission: "granted" });
		const badge = badges();
		badge.setAppBadge.mockRejectedValue(new Error("refused"));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await expect(showBadge(2)).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalled();
	});

	test("a badge count given before notifications are allowed is shown once they are turned on", async () => {
		const device = browser({ permission: "default" });
		site();
		const badge = badges();
		await showBadge(5);
		expect(badge.setAppBadge).not.toHaveBeenCalled();

		const button = notificationButton() as HTMLButtonElement;
		document.body.append(button);
		(Notification as unknown as { permission: Permission }).permission =
			"granted";
		button.click();
		await vi.waitFor(() => expect(badge.setAppBadge).toHaveBeenCalledWith(5));
		expect(device.subscribe).toHaveBeenCalledTimes(1);
	});
});
