// What sync.ts push sends to the Worker and what the Worker answers: one place for both sides.
import type { JsonObject } from "./narrow.ts";

// The request body, JSON, at most MAX_BODY_BYTES bytes and MAX_ENTRIES entries (413 beyond either): entries in file
// order, each with the date of the digests line it sits on.
//   {"entries": [{"date": "2026-10-16", "entry": {"id": "arxiv:2610.00001", "type": "paper", ...}}, ...]}
// 24 entries keep a request within D1's documented 50 statements even when every write loses a race to another push
// and is read and written again: 1 lookup + 24 writes + 1 lookup + 24 writes.
export const MAX_ENTRIES = 24;
// 1 MB, counted as 1,000,000 bytes.
export const MAX_BODY_BYTES = 1_000_000;
export type PushItem = { date: string; entry: JsonObject };

// The answer, 200, JSON: one result per item, in the order sent.
//   added: stored as a new entry, after every entry stored before it.
//   filled: the entry was stored; these fields, absent from it, were added. Its other fields and date stay.
//   already there: the entry was stored with every field the item has.
//   refused: problems in the words of shared/entry-checks.ts entryProblems(entry, "check"), or the date's problem.
// id is null when the item has no text id.
export type PushAnswer = { results: PushResult[] };
export type PushResult =
	| { id: string; outcome: "added" | "already there" }
	| { id: string; outcome: "filled"; fields: string[] }
	| { id: string | null; outcome: "refused"; problems: string[] };
