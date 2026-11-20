// What the Worker pushes to the owner's devices and the service worker shows: one shape for
// worker/src/notify.ts, site/sw.ts and the tests. The payload is encrypted for each device (RFC 8291), so only the
// device reads the badge number; the text is a fixed line that names no entry.
import { isJsonObject } from "./narrow.ts";

// The two notifications: "digest" at 08:00 in Jakarta, "reminder" at 20:00.
export type NotifyKind = "digest" | "reminder";
// The decrypted payload, as JSON: the line to show and the badge's number of today's unread papers.
export type NotifyPayload = { kind: NotifyKind; line: string; badge: number };
// Every notification's title.
export const NOTIFY_TITLE = "Liminal Space";

// The payload a push carried, or null when it isn't a NotifyPayload; the service worker then still shows
// NOTIFY_TITLE with no line, because iOS ends a subscription whose pushes show nothing.
export function notifyPayloadOf(data: unknown): NotifyPayload | null {
	if (
		!isJsonObject(data) ||
		(data.kind !== "digest" && data.kind !== "reminder") ||
		typeof data.line !== "string" ||
		typeof data.badge !== "number" ||
		!Number.isInteger(data.badge) ||
		data.badge < 0
	) {
		return null;
	}
	return { kind: data.kind, line: data.line, badge: data.badge };
}
