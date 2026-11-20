// What sync.ts log sends to the Worker and what the owner route answers: one place for both sides.
//
// POST /liminal-space/api/sync/logs, JSON: one cloud run's log, .scout-logs/<date>.md as scout.ts wrote it.
//   {"id": "40591364970-1", "date": "2026-10-28", "log": "## Run started ..."}
// The answer is 200 {} once stored; the same id again replaces the run's log.
// GET /liminal-space/api/owner/logs answers {"logs": [ScoutLog, ...]}, newest date first, then newest stored first.

// A log's own size limit, in UTF-8 bytes; the body may add MAX_LOG_BODY_EXTRA for its id, date and JSON quoting.
export const MAX_LOG_BYTES = 65_536;
export const MAX_LOG_BODY_EXTRA = 4_096;
// How many days of logs the site keeps, counted back from the newest log stored.
export const LOG_DAYS = 30;
// A run id as the workflow writes it, <run id>-<attempt>: letters, digits and dashes, at most 64.
export const RUN_ID = /^[0-9A-Za-z-]{1,64}$/;
// The log file scout.ts writes, named for its Jakarta date.
export const LOG_FILE_NAME = /^(\d{4}-\d{2}-\d{2})\.md$/;

export type ScoutLog = {
	id: string;
	date: string;
	log: string;
	updated: string;
};
