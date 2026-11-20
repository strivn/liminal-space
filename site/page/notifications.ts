// The owner's page side of notifications: the "Turn on notifications" button, this device's
// push subscription, and the Home Screen icon's badge.
import { isJsonObject } from "../../shared/narrow.ts";
import { fetchJson } from "./data.ts";
import { el } from "./dom.ts";
import { notice, OWNER_API, postChange } from "./owner.ts";
import type { Day, ReadState } from "./types.ts";

// The button's words.
export const TURN_ON_NOTIFICATIONS = "Turn on notifications";

// The owner's service worker (site/sw.ts), at the address relative to the owner's page that gives it the owner's folder as
// its scope.
const SERVICE_WORKER = "sw.js";

// What the badge last was told, so a device that allows notifications later shows it at once.
let latestUnread = 0;

// Whether this browser can take notifications: it has push and a service worker. An iPhone's Safari outside the Home
// Screen app has no push, and gives no button.
function canTakeNotifications(): boolean {
	return (
		typeof Notification !== "undefined" &&
		"serviceWorker" in navigator &&
		"PushManager" in window
	);
}

// Whether this browser holds a push subscription for the owner's page: its service worker is registered and has one.
async function holdsSubscription(): Promise<boolean> {
	const registration = await navigator.serviceWorker.getRegistration();
	if (registration === undefined) return false;
	return (await registration.pushManager.getSubscription()) !== null;
}

// Server keys come as base64url text; the browser subscribes with their bytes.
function keyBytes(key: string): Uint8Array<ArrayBuffer> {
	const binary = atob(key.replaceAll("-", "+").replaceAll("_", "/"));
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

// Register the service worker, subscribe this device with the site's VAPID key and save the subscription on the site.
// Returns why it didn't work, for the page to show after "Notifications weren't turned on: ", or null when it did.
async function subscribeThisDevice(): Promise<string | null> {
	const key = await fetchJson(`${OWNER_API}push`);
	if (
		key.status !== 200 ||
		!isJsonObject(key.json) ||
		typeof key.json.publicKey !== "string"
	) {
		return "the site can't send notifications";
	}
	const registration = await navigator.serviceWorker.register(SERVICE_WORKER, {
		scope: "./",
	});
	// subscribe needs a worker that is active, which a first registration isn't yet.
	await navigator.serviceWorker.ready;
	const subscription = await registration.pushManager.subscribe({
		userVisibleOnly: true,
		applicationServerKey: keyBytes(key.json.publicKey),
	});
	const answer = await postChange("push", JSON.stringify(subscription));
	if (answer === null || answer.status !== 204) {
		return "couldn't reach the site";
	}
	return null;
}

// A press on the button: ask for permission first, straight from the tap, since iOS allows it from no other place; then
// subscribe. The button goes once the site holds the subscription, or when the answer was no.
async function turnOn(button: HTMLButtonElement): Promise<void> {
	const permission = await Notification.requestPermission();
	if (permission !== "granted") {
		button.remove();
		return;
	}
	let problem: string | null;
	try {
		problem = await subscribeThisDevice();
	} catch (error) {
		console.error("Notifications couldn't be turned on:", error);
		problem = "this browser couldn't subscribe";
	}
	if (problem !== null) {
		notice(`Notifications weren't turned on: ${problem}`);
		return;
	}
	button.remove();
	await showBadge(latestUnread);
}

// The header's button, or null when this browser can't take notifications or the owner refused them. A press asks for
// permission, the one way iOS allows; once allowed, the page registers the service worker, subscribes this device,
// saves the subscription on the site (POST push) and removes the button. A browser that allowed them already shows the
// button only when it holds no subscription (it lost it, or never kept it): the button stays hidden until that is
// known, and goes if it holds one.
export function notificationButton(): HTMLButtonElement | null {
	if (!canTakeNotifications() || Notification.permission === "denied") {
		return null;
	}
	const button = el(
		"button",
		{ type: "button", class: "notify-button" },
		TURN_ON_NOTIFICATIONS,
	);
	button.addEventListener("click", () => {
		turnOn(button).catch((error) => {
			console.error("Notifications couldn't be turned on:", error);
		});
	});
	if (Notification.permission === "granted") {
		button.hidden = true;
		holdsSubscription()
			.then((holds) => {
				if (holds) button.remove();
				else button.hidden = false;
			})
			.catch((error) => {
				console.error("The push subscription couldn't be read:", error);
				button.remove();
			});
	}
	return button;
}

// How many of today's papers (Jakarta date) have no read state; 0 when the newest digest isn't today's. News, articles
// and reports are not tracked, so they never count.
export function unreadToday(
	days: Day[],
	state: ReadState,
	today: string,
): number {
	const day = days.find((each) => each.date === today);
	if (day === undefined) return 0;
	let unread = 0;
	for (const entry of day.entries) {
		if (entry.type === "paper" && state[entry.id] === undefined) unread += 1;
	}
	return unread;
}

// Set the app icon's badge to `unread`, or clear it at 0. Does nothing where the Badging API is missing or
// notifications aren't allowed.
export async function showBadge(unread: number): Promise<void> {
	latestUnread = unread;
	if (
		typeof Notification === "undefined" ||
		Notification.permission !== "granted" ||
		!("setAppBadge" in navigator)
	) {
		return;
	}
	try {
		if (unread > 0) {
			await navigator.setAppBadge(unread);
		} else {
			await navigator.clearAppBadge();
		}
	} catch (error) {
		console.warn("The app badge couldn't be set:", error);
	}
}
