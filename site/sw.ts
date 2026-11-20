// The owner's service worker: it shows a pushed notification, sets the Home Screen icon's
// badge, and opens the owner's page on a tap. scripts/deploy/build-site.ts serves it from the owner's folder, which is
// its scope; the public page never registers it. It has no fetch handler, so every request goes to the network as
// without it.
import { NOTIFY_TITLE, notifyPayloadOf } from "../shared/notify-protocol.ts";

const scope = self as unknown as ServiceWorkerGlobalScope;

// Where a tap goes, and what a window of the owner's page is told by.
const OWNER_PAGE = "/liminal-space/owner/";
// The icon beside a notification's text, a file of the public page, found from this script's address.
const ICON = "../app-icon/apple-touch-icon.png";

// Show the pushed line and set the badge to its number. A push whose payload can't be read still shows the title, because
// iOS ends a subscription whose pushes show nothing.
async function showPush(event: PushEvent): Promise<void> {
	let data: unknown = null;
	try {
		data = event.data?.json();
	} catch {
		data = null;
	}
	const payload = notifyPayloadOf(data);
	if (payload === null) {
		await scope.registration.showNotification(NOTIFY_TITLE, { icon: ICON });
		return;
	}
	await scope.registration.showNotification(NOTIFY_TITLE, {
		body: payload.line,
		icon: ICON,
		tag: payload.kind,
	});
	try {
		if (payload.badge > 0) {
			await scope.navigator.setAppBadge(payload.badge);
		} else {
			await scope.navigator.clearAppBadge();
		}
	} catch {
		// A browser without the Badging API still showed the notification.
	}
}

// Focus an open window of the owner's page, or open one.
async function openOwnerPage(): Promise<void> {
	const windows = await scope.clients.matchAll({
		type: "window",
		includeUncontrolled: true,
	});
	for (const open of windows) {
		if (new URL(open.url).pathname.startsWith(OWNER_PAGE)) {
			// biome-ignore lint/performance/noAwaitInLoops: focus one window, then stop
			await open.focus();
			return;
		}
	}
	await scope.clients.openWindow(OWNER_PAGE);
}

scope.addEventListener("push", (event) => {
	event.waitUntil(showPush(event));
});
scope.addEventListener("notificationclick", (event) => {
	event.notification.close();
	event.waitUntil(openOwnerPage());
});
