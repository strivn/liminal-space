// The connector's add requests: what the Worker queues from a Claude app, what add.yml reads and reports back, and
// the limits on both. One place for the Worker, add.yml's scripts and the tests.
import type { JsonObject } from "./narrow.ts";

// A tool call's payload. Papers: arXiv ids as given ("2507.11473" or "arxiv:2507.11473"). Links: items in the shape
// digests.ts add takes (type, title, published, source, url; authors, links and description optional), checked with
// entryProblems(item, "add") before anything is queued.
export type AddPayload = { papers: string[] } | { links: JsonObject[] };
export type AddKind = "papers" | "links";
export type AddStatus = "queued" | "running" | "done" | "failed";

// What happened to each id or link of a request, once add.yml has handled it. reason is set for "failed".
export type AddItemResult = {
	id: string;
	outcome: "added" | "already there" | "failed";
	reason?: string;
};
export type AddResult = { items: AddItemResult[] };

// One row of add_requests as the routes see it. created and finished are UTC times.
export type AddRequest = {
	id: string;
	kind: AddKind;
	payload: AddPayload;
	status: AddStatus;
	created: string;
	finished: string | null;
	result: AddResult | null;
};

// GET /liminal-space/api/sync/requests (sync token): the queued requests, oldest first.
export type QueuedAnswer = {
	requests: { id: string; kind: AddKind; payload: AddPayload }[];
};
// POST /liminal-space/api/sync/requests (sync token): one request's new status, and its result when it is done or
// failed. 200 {} when recorded; 404 for an id the database doesn't hold.
export type RequestUpdate = {
	id: string;
	status: "running" | "done" | "failed";
	result?: AddResult;
};

// Limits the connector's tools enforce before anything is queued.
export const MAX_PAPERS_PER_CALL = 10;
export const MAX_LINKS_PER_CALL = 5;
export const MAX_QUEUED_REQUESTS = 30;
// A tool call holds at most 5 links of a few fields each: 64 KB is far more than any honest call needs.
export const MAX_MCP_BODY_BYTES = 65_536;
// The largest body POST requests takes: one request's result, which names at most 10 ids or 5 links.
export const MAX_REQUEST_UPDATE_BYTES = 65_536;
// The MCP protocol versions the hand-written handler speaks, newest first.
export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"];
