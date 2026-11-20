// POST /liminal-space/api/sync/push: store new entries and fill fields stored entries lack. Never changes or removes
// a stored field or entry, so a push can be repeated and two pushes can run at once.
import { entryProblems, hasText, isDay } from "../../shared/entry-checks.ts";
import { isJsonObject, type JsonObject } from "../../shared/narrow.ts";
import {
	MAX_BODY_BYTES,
	MAX_ENTRIES,
	type PushAnswer,
	type PushItem,
	type PushResult,
} from "../../shared/push-protocol.ts";
import {
	counter,
	MAX_BOUND_VALUES,
	MAX_STATEMENTS,
	type QueryCost,
	runBatch,
} from "./d1.ts";
import type { Env, RequestLog } from "./env.ts";
import {
	BodyProblem,
	readJson,
	refuse,
	refuseBody,
	tryAgain,
} from "./respond.ts";

// A new entry, placed after every stored one. MAX(seq) reads one row through seq's unique index. An id already
// stored (another push got there first) changes nothing and reports 0 changes.
const INSERT_SQL =
	"INSERT INTO entries (id, date, seq, json, updated) " +
	"VALUES (?1, ?2, (SELECT COALESCE(MAX(seq), 0) + 1 FROM entries), ?3, ?4) " +
	"ON CONFLICT(id) DO NOTHING";
// A fill, written only if the stored JSON is still what was read: another push's fill in between reports 0 changes.
const UPDATE_SQL =
	"UPDATE entries SET json = ?1, updated = ?2 WHERE id = ?3 AND json = ?4";

// The valid items that share one id, in the order they came: where each sits in the request, its entry, and the date
// of the first, which a new entry is stored under.
type IdGroup = {
	id: string;
	date: string;
	positions: number[];
	entries: JsonObject[];
};

// What one id's items do to its stored entry: one result per item, and the write that stores it.
type Judgement = {
	outcomes: PushResult[];
	write: "insert" | "update" | "none";
	json: string;
};

// Judge one id's items in order against its stored JSON (null when it isn't stored): the first item of a new id is
// added, and every later item fills the fields absent so far. A stored field is never changed.
function judge(group: IdGroup, storedJson: string | null): Judgement {
	const outcomes: PushResult[] = [];
	let current: JsonObject | null = null;
	if (storedJson !== null) {
		const stored: unknown = JSON.parse(storedJson);
		if (!isJsonObject(stored)) {
			throw new Error(`the stored entry ${group.id} is not an object`);
		}
		// Fields are copied onto an object with no prototype, so a field named "__proto__" stays a field.
		current = Object.assign(Object.create(null), stored);
	}
	let filledAny = false;
	for (const entry of group.entries) {
		if (current === null) {
			outcomes.push({ id: group.id, outcome: "added" });
			current = Object.assign(Object.create(null), entry);
			continue;
		}
		// Only fields absent from the entry as it stands; a field present with any value, null included, stays.
		const fields: string[] = [];
		for (const key of Object.keys(entry)) {
			if (!Object.hasOwn(current, key)) {
				fields.push(key);
				current[key] = entry[key];
			}
		}
		if (fields.length === 0) {
			outcomes.push({ id: group.id, outcome: "already there" });
		} else {
			outcomes.push({ id: group.id, outcome: "filled", fields: fields });
			filledAny = true;
		}
	}
	const json = JSON.stringify(current);
	if (storedJson === null) {
		return { outcomes: outcomes, write: "insert", json: json };
	}
	if (filledAny) {
		return { outcomes: outcomes, write: "update", json: json };
	}
	return { outcomes: outcomes, write: "none", json: json };
}

// Store what the items hold, in order: an item is judged after the ones before it, so an id twice is stored once and
// the second fills what the first lacked. Runs at most 50 D1 statements, the free plan's documented limit per
// request, and reads only the rows it looks up (no scan: every lookup uses an index). Each statement's cost goes to
// `count`. A new entry gets the next seq after every stored one; a lost race with another push is read again, so
// nothing either push sent is lost.
export async function push(
	db: D1Database,
	items: PushItem[],
	count: (cost: QueryCost) => void,
): Promise<PushAnswer> {
	// Run statements as one batch, within the request's statement limit, counting each one's cost.
	// Throws rather than pass the limit: the caller answers 503 and sync.ts sends the request again.
	let used = 0;
	const runWithinLimit = (statements: D1PreparedStatement[]) => {
		if (used + statements.length > MAX_STATEMENTS) {
			throw new Error(
				`the push would run more than ${MAX_STATEMENTS} database statements`,
			);
		}
		used += statements.length;
		return runBatch<{ id: string; json: string }>(db, statements, count);
	};

	// The stored JSON of these ids, looked up through the primary key, at most 100 ids per statement.
	const lookUp = async (ids: string[]) => {
		const statements: D1PreparedStatement[] = [];
		for (let start = 0; start < ids.length; start += MAX_BOUND_VALUES) {
			const chunk = ids.slice(start, start + MAX_BOUND_VALUES);
			const marks = chunk.map(() => "?").join(", ");
			const sql = `SELECT id, json FROM entries WHERE id IN (${marks})`;
			statements.push(db.prepare(sql).bind(...chunk));
		}
		const found = new Map<string, string>();
		if (statements.length === 0) {
			return found;
		}
		for (const answer of await runWithinLimit(statements)) {
			for (const row of answer.results) {
				found.set(row.id, row.json);
			}
		}
		return found;
	};

	// Judge each item's own problems first: a refused item is answered by name and takes no part in what follows.
	const results: PushResult[] = [];
	const groups = new Map<string, IdGroup>();
	for (let k = 0; k < items.length; k++) {
		// The items came from JSON as they were sent, so each is checked as an unknown value.
		const item: unknown = items[k];
		if (!isJsonObject(item)) {
			results[k] = {
				id: null,
				outcome: "refused",
				problems: ["item is not an object"],
			};
			continue;
		}
		const entry = item.entry;
		const problems: string[] = [];
		if (!isDay(item.date)) {
			problems.push("date must be YYYY-MM-DD");
		}
		for (const problem of entryProblems(entry, "check")) {
			problems.push(problem);
		}
		if (problems.length > 0) {
			let id: string | null = null;
			if (isJsonObject(entry) && hasText(entry.id)) {
				id = entry.id;
			}
			results[k] = { id: id, outcome: "refused", problems: problems };
			continue;
		}
		// With no problems, the entry is an object with a text id and the date is a day.
		if (
			!isJsonObject(entry) ||
			typeof entry.id !== "string" ||
			typeof item.date !== "string"
		) {
			throw new Error("an entry passed its checks without a text id or date");
		}
		let group = groups.get(entry.id);
		if (group === undefined) {
			group = { id: entry.id, date: item.date, positions: [], entries: [] };
			groups.set(entry.id, group);
		}
		group.positions.push(k);
		group.entries.push(entry);
	}

	// Judge each id against what is stored and write it; an id whose write found the row changed by another push
	// is read again and judged again, until every write lands.
	let pending = Array.from(groups.values());
	let stored = await lookUp(Array.from(groups.keys()));
	while (pending.length > 0) {
		const now = new Date().toISOString();
		const writes: D1PreparedStatement[] = [];
		const writers: IdGroup[] = [];
		for (const group of pending) {
			const storedJson = stored.get(group.id) || null;
			const judgement = judge(group, storedJson);
			for (let i = 0; i < group.positions.length; i++) {
				const position = group.positions[i];
				const outcome = judgement.outcomes[i];
				if (position !== undefined && outcome !== undefined) {
					results[position] = outcome;
				}
			}
			if (judgement.write === "insert") {
				writes.push(
					db
						.prepare(INSERT_SQL)
						.bind(group.id, group.date, judgement.json, now),
				);
				writers.push(group);
			} else if (judgement.write === "update") {
				writes.push(
					db
						.prepare(UPDATE_SQL)
						.bind(judgement.json, now, group.id, storedJson),
				);
				writers.push(group);
			}
		}
		if (writes.length === 0) {
			break;
		}
		// biome-ignore lint/performance/noAwaitInLoops: a round runs only for the writes the round before lost
		const answers = await runWithinLimit(writes);
		const lost: IdGroup[] = [];
		for (let i = 0; i < writers.length; i++) {
			const answer = answers[i];
			const writer = writers[i];
			if (answer !== undefined && writer !== undefined) {
				if (answer.meta.changes === 0) {
					lost.push(writer);
				}
			}
		}
		if (lost.length > 0) {
			stored = await lookUp(lost.map((group) => group.id));
		}
		pending = lost;
	}
	return { results: results };
}

// POST /liminal-space/api/sync/push: read the body, then store what it holds.
export async function answerPush(
	request: Request,
	env: Env,
	_ctx: ExecutionContext,
	log: RequestLog,
): Promise<Response> {
	let body: unknown;
	try {
		body = await readJson(request, MAX_BODY_BYTES);
	} catch (error) {
		if (!(error instanceof BodyProblem)) {
			throw error;
		}
		if (error.status === 413) {
			return refuseBody(log, error);
		}
		return refuse(log, 400, "bad request", error.message);
	}
	if (!isJsonObject(body) || !Array.isArray(body.entries)) {
		return refuse(log, 400, "bad request", 'body has no "entries" list');
	}
	if (body.entries.length > MAX_ENTRIES) {
		return refuse(log, 413, "too large", `more than ${MAX_ENTRIES} entries`);
	}
	// push judges every item and field itself, so the items go to it as they came; the type is what they should be.
	const items = body.entries as PushItem[];

	// Count every statement push runs into the log line.
	try {
		const answer = await push(env.DB, items, counter(log));
		return Response.json(answer);
	} catch (error) {
		// D1 failed or was busy: nothing push wrote is lost, and sync.ts sends the same entries again.
		return tryAgain(log, "push failed", error);
	}
}
