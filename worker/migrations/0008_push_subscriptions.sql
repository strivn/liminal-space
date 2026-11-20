-- The owner's devices that allowed notifications: one row per push subscription. id grows with
-- each save, so the lowest id is the oldest subscription; at most 4 rows are kept (worker/src/notify.ts).
CREATE TABLE push_subscriptions (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	endpoint TEXT NOT NULL UNIQUE,
	p256dh TEXT NOT NULL,
	auth TEXT NOT NULL
);
