// Copy digests between this machine and the hosted site.
// Usage: node scripts/deploy/sync.ts push <digests file>
//        node scripts/deploy/sync.ts pull [--database] <digests file>
//        node scripts/deploy/sync.ts log <run id> <YYYY-MM-DD>.md
//        node scripts/deploy/sync.ts push-study <study file>
//        node scripts/deploy/sync.ts pull-study [--database] <study file>
// push sends the entries that are new or changed since the last pull, compared with digests.pulled.js next to the
// digests file (every entry when there is none), to <LIMINAL_URL>/api/sync/push, in requests the Worker can answer
// within D1's free limits (MAX_ENTRIES, MAX_BODY_BYTES in shared/push-protocol.ts). After every entry is accepted,
// digests.pulled.js becomes a copy of the digests file.
// pull replaces the digests file and digests.pulled.js with what the site holds, whatever the file held: the hosted
// <LIMINAL_URL>/data/ files, no token needed (entries only, enough to seed another copy of the site), or with
// --database, D1 through Cloudflare's API (scout.yml, add.yml and deploys start this way). With --database it also
// writes digests.read.json beside them: the
// id of every entry with a read mark, for bringing unread papers back later;
// and feedback.json in the cache folder, the owner's Dislike, OK and Like marks on papers in the last 30 days
// (scripts/lib/feedback.ts).
// log sends one cloud run's log, .scout-logs/<date>.md, to <LIMINAL_URL>/api/sync/logs, where only the owner's page
// reads it (shared/log-protocol.ts).
// Requests are retried after 1, 2, 4, 8 and 16 s. Messages name lines, entries and ids, never a token or a file's text.
// Environment: ACCESS_SYNC_ID and ACCESS_SYNC_SECRET (push and log), Access service token "sync", sent as CF-Access-Client-Id
// and CF-Access-Client-Secret; CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and D1_DATABASE_ID (pull --database; the
// ids are kept out of the repository) and CLOUDFLARE_API_BASE, default https://api.cloudflare.com/client/v4;
// LIMINAL_URL, default https://ivan.wiryadi.com/liminal-space (tests point it elsewhere); SYNC_RETRY_SECOND_MS as the
// length of a second between retries, tests only.
import { randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	hasControlCharacter,
	hasText,
	readLines,
	UnloadedLine,
} from "../../shared/entry-checks.ts";
import {
	LOG_FILE_NAME,
	MAX_LOG_BYTES,
	RUN_ID,
} from "../../shared/log-protocol.ts";
import {
	errorCode,
	isJsonObject,
	type JsonObject,
} from "../../shared/narrow.ts";
import {
	MAX_BODY_BYTES,
	MAX_ENTRIES,
	type PushItem,
	type PushResult,
} from "../../shared/push-protocol.ts";
import type { MonthLine } from "../../shared/site-data-shape.ts";
import { digestLine } from "../digests/digests-file.ts";
import {
	FEEDBACK_DAYS,
	type FeedbackRow,
	feedbackFileOf,
	feedbackPath,
} from "../lib/feedback.ts";
import { daysBefore, jakartaToday } from "../lib/run-date.ts";
import { requestWithRetry, SyncFailure, siteBase } from "./site-requests.ts";

const USAGE =
	"usage: node scripts/deploy/sync.ts push <digests file> | pull [--database] <digests file> | count --database | log <run id> <YYYY-MM-DD>.md";
// Cloudflare's API, for pull --database; CLOUDFLARE_API_BASE points tests at a stand-in.
const DEFAULT_API_BASE = "https://api.cloudflare.com/client/v4";
// The copy of the digests as last pulled or pushed, in the digests file's folder.
const PULLED_NAME = "digests.pulled.js";
// The ids of the entries with a read mark, as pull --database last read them, in the digests file's folder too.
const READ_MARKS_NAME = "digests.read.json";
// The body with no entries, '{"entries":[]}': every request body is this plus its entries and the commas between.
const EMPTY_BODY_BYTES = Buffer.byteLength(JSON.stringify({ entries: [] }));

// One entry push may send, with where it sits in the digests file for messages: line number and position in the
// line, both counting from 1.
export type Outgoing = { item: PushItem; line: number; position: number };

// Every entry the pulled copy holds, each as its JSON text: an entry written the same way is unchanged.
// A pulled line that doesn't load is skipped, which only means its entries are sent again.
function pulledEntries(pulledText: string | null) {
	const pulled = new Set<string>();
	if (pulledText === null) {
		return pulled;
	}
	for (const line of readLines(pulledText)) {
		const digest = line.digest;
		if (isJsonObject(digest) && Array.isArray(digest.entries)) {
			for (const entry of digest.entries) {
				pulled.add(JSON.stringify(entry));
			}
		}
	}
	return pulled;
}

// The entries of `text` that `pulledText` (null when there is no pulled copy) doesn't hold as they are now: new ids,
// and entries whose fields differ. File order. Throws "line <n> doesn't load ..." for a line that doesn't load.
export function changedEntries(
	text: string,
	pulledText: string | null,
): Outgoing[] {
	const pulled = pulledEntries(pulledText);
	const outgoing: Outgoing[] = [];
	for (const line of readLines(text)) {
		if (line.problem !== undefined) {
			throw new UnloadedLine(line.number, line.problem);
		}
		const digest = line.digest;
		if (!isJsonObject(digest) || !Array.isArray(digest.entries)) {
			throw new UnloadedLine(
				line.number,
				"doesn't load (entries must be a list)",
			);
		}
		// The site judges every date and entry with digests.ts check's own words, so each is sent as the file holds
		// it, even one that isn't what the type says it should be.
		const date = digest.date as string;
		const entries: unknown[] = digest.entries;
		for (let k = 0; k < entries.length; k++) {
			const entry = entries[k];
			if (pulled.has(JSON.stringify(entry))) {
				continue;
			}
			outgoing.push({
				item: { date: date, entry: entry as JsonObject },
				line: line.number,
				position: k + 1,
			});
		}
	}
	return outgoing;
}

// Split what push sends into requests of at most MAX_ENTRIES (24) entries and a body under MAX_BODY_BYTES, in order.
export function requestsOf(outgoing: Outgoing[]): Outgoing[][] {
	const requests: Outgoing[][] = [];
	let current: Outgoing[] = [];
	let bodyBytes = EMPTY_BODY_BYTES;
	for (const one of outgoing) {
		const itemBytes = Buffer.byteLength(JSON.stringify(one.item));
		// A comma goes before every entry but the first.
		let addedBytes = itemBytes;
		if (current.length > 0) {
			addedBytes += 1;
		}
		// Start a new request when this one is full. An entry too large for any request still goes, alone.
		const full =
			current.length === MAX_ENTRIES ||
			bodyBytes + addedBytes >= MAX_BODY_BYTES;
		if (current.length > 0 && full) {
			requests.push(current);
			current = [];
			bodyBytes = EMPTY_BODY_BYTES;
			addedBytes = itemBytes;
		}
		current.push(one);
		bodyBytes += addedBytes;
	}
	if (current.length > 0) {
		requests.push(current);
	}
	return requests;
}

// The site's answer as one result per entry sent, or null when it isn't that.
function readResults(answer: unknown, count: number): PushResult[] | null {
	if (!isJsonObject(answer) || !Array.isArray(answer.results)) {
		return null;
	}
	const results: unknown[] = answer.results;
	if (results.length !== count) {
		return null;
	}
	for (const result of results) {
		if (!isJsonObject(result)) {
			return null;
		}
		const outcome = result.outcome;
		if (outcome === "added" || outcome === "already there") {
			continue;
		}
		if (outcome === "filled" && Array.isArray(result.fields)) {
			continue;
		}
		if (outcome === "refused" && Array.isArray(result.problems)) {
			continue;
		}
		return null;
	}
	// Each result has been checked to be one of the four kinds the protocol names.
	return results as PushResult[];
}

// The text of an answer as JSON, or null when it isn't JSON.
function parseAnswer(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

// Send one request's entries. Returns the site's results, one per entry sent.
async function sendRequest(
	url: string,
	headers: Record<string, string>,
	request: Outgoing[],
): Promise<PushResult[]> {
	const items: PushItem[] = request.map((one) => one.item);
	const body = JSON.stringify({ entries: items });
	const text = await requestWithRetry(
		url,
		{ method: "POST", headers: headers, body: body },
		"push",
		"the site",
	);
	const results = readResults(parseAnswer(text), request.length);
	if (results === null) {
		throw new SyncFailure(
			"push failed: the site's answer doesn't hold one result per entry",
		);
	}
	return results;
}

// Replace a file whole: write a temporary file in the same folder, then rename it over the file, so an interrupted
// run leaves the old file whole.
function replaceFile(path: string, content: Buffer | string) {
	// A random name no one can know ahead, opened with "wx": the open fails when anything is already at that path.
	const temporary = join(
		dirname(path),
		`.${basename(path)}.${randomBytes(8).toString("hex")}.tmp`,
	);
	try {
		writeFileSync(temporary, content, { flag: "wx" });
		renameSync(temporary, path);
	} catch (error) {
		// EEXIST: the name was taken, so what is there isn't this run's to remove.
		if (errorCode(error) !== "EEXIST") {
			rmSync(temporary, { force: true });
		}
		throw new SyncFailure(`couldn't write ${path}: ${errorCode(error)}`);
	}
}

// How a refused entry is named after its place: " <id>" when it has a text id that keeps the message on one line.
function refusedIdPart(entry: unknown) {
	if (isJsonObject(entry) && hasText(entry.id)) {
		if (!hasControlCharacter(entry.id)) {
			return ` ${entry.id}`;
		}
	}
	return "";
}

// The digests file's bytes, and its pulled copy's text, null when there is none. A file that can't be read stops the
// run with "can't read <file> (<error code>)".
function readWithPulled(file: string, pulledPath: string) {
	let bytes: Buffer;
	try {
		bytes = readFileSync(file);
	} catch (error) {
		throw new SyncFailure(`can't read ${file} (${errorCode(error)})`);
	}
	let pulledText: string | null = null;
	if (existsSync(pulledPath)) {
		try {
			pulledText = readFileSync(pulledPath, "utf8");
		} catch (error) {
			throw new SyncFailure(`can't read ${pulledPath} (${errorCode(error)})`);
		}
	}
	return { bytes: bytes, pulledText: pulledText };
}

// Send what changed since the last pull, print what the site did with each entry, then, when nothing was refused,
// make the pulled copy a copy of the digests file.
async function push(file: string, clientId: string, clientSecret: string) {
	const pulledPath = join(dirname(file), PULLED_NAME);
	const { bytes, pulledText } = readWithPulled(file, pulledPath);

	// Every line must load before anything is sent.
	let outgoing: Outgoing[];
	try {
		outgoing = changedEntries(bytes.toString("utf8"), pulledText);
	} catch (error) {
		if (error instanceof UnloadedLine) {
			throw new SyncFailure(`line ${error.line} of ${file} ${error.problem}`);
		}
		throw error;
	}

	const base = siteBase();
	const url = `${base}/api/sync/push`;
	const headers = {
		"Content-Type": "application/json",
		"CF-Access-Client-Id": clientId,
		"CF-Access-Client-Secret": clientSecret,
	};
	let added = 0;
	let filled = 0;
	let alreadyThere = 0;
	let refused = 0;
	for (const request of requestsOf(outgoing)) {
		// biome-ignore lint/performance/noAwaitInLoops: requests go one after another so the site stores entries in file order
		const results = await sendRequest(url, headers, request);
		for (let i = 0; i < request.length; i++) {
			const one = request[i];
			const result = results[i];
			if (one === undefined || result === undefined) {
				continue;
			}
			if (result.outcome === "added") {
				added += 1;
				console.log(`added ${result.id}`);
			} else if (result.outcome === "filled") {
				filled += 1;
				console.log(`filled ${result.id} ${result.fields.join(", ")}`);
			} else if (result.outcome === "refused") {
				refused += 1;
				const idPart = refusedIdPart(one.item.entry);
				console.log(
					`refused line ${one.line} entry ${one.position}${idPart}: ${result.problems.join("; ")}`,
				);
			} else {
				alreadyThere += 1;
				console.log(`already there ${result.id}`);
			}
		}
	}
	console.log(
		`added ${added}, filled ${filled}, already there ${alreadyThere}, refused ${refused}`,
	);

	// A refused entry isn't on the site, so the pulled copy, which says what the site holds, stays as it was.
	// exitCode, not exit(): exit() could cut off output that is still being written.
	if (refused > 0) {
		process.exitCode = 1;
		return;
	}
	replaceFile(pulledPath, bytes);
}

// ---- log ----

// Send one run's log, dated `date` (the log file's name). A log the site would refuse for its size isn't sent.
async function sendLog(
	runId: string,
	date: string,
	file: string,
	clientId: string,
	clientSecret: string,
) {
	let log: string;
	try {
		log = readFileSync(file, "utf8");
	} catch (error) {
		throw new SyncFailure(`can't read ${file} (${errorCode(error)})`);
	}
	if (Buffer.byteLength(log) > MAX_LOG_BYTES) {
		throw new SyncFailure(
			`log failed: ${file} is larger than ${MAX_LOG_BYTES} bytes`,
		);
	}
	await requestWithRetry(
		`${siteBase()}/api/sync/logs`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"CF-Access-Client-Id": clientId,
				"CF-Access-Client-Secret": clientSecret,
			},
			body: JSON.stringify({ id: runId, date: date, log: log }),
		},
		"log",
		"the site",
	);
	console.log(`sent the log of run ${runId}, dated ${date}`);
}

// ---- pull ----

// The digests text pull writes for hosted lines: one line per day, oldest day first, each day's entries in the
// order given. `lines` are month files' lines (or database rows grouped by date), in hosted order.
function digestsTextOf(lines: MonthLine[]): string {
	// Each date's lines, in the order the lines give them.
	const byDate = Map.groupBy(lines, (line) => line.date);
	const dates = Array.from(byDate.keys()).sort();
	let text = "";
	for (const date of dates) {
		const entries = (byDate.get(date) || []).flatMap((line) => line.entries);
		text += `${digestLine(date, entries)}\n`;
	}
	return text;
}

// A month file name from the index, as build-site.ts writes it: "months/<name>.json", nothing that leaves the folder.
const MONTH_FILE_NAME = /^months\/[0-9A-Za-z._-]+\.json$/;

// One month file's lines, each a date and a list of entries; null when the file isn't that.
function monthFileLines(answer: unknown): MonthLine[] | null {
	if (!isJsonObject(answer) || !Array.isArray(answer.lines)) {
		return null;
	}
	const lines: MonthLine[] = [];
	for (const line of answer.lines) {
		if (
			!isJsonObject(line) ||
			typeof line.date !== "string" ||
			!Array.isArray(line.entries)
		) {
			return null;
		}
		lines.push({ date: line.date, entries: line.entries });
	}
	return lines;
}

// Every line the hosted site holds: data/index.json, then each month file it names, oldest month first. The files
// are what visitors get, so no token is needed.
async function hostedLines(): Promise<MonthLine[]> {
	const base = siteBase();
	const get = { method: "GET", headers: {}, body: null };
	const unreadable = "pull failed: the site's data can't be read";
	const index = parseAnswer(
		await requestWithRetry(`${base}/data/index.json`, get, "pull", "the site"),
	);
	if (!isJsonObject(index) || !isJsonObject(index.months)) {
		throw new SyncFailure(unreadable);
	}
	const months = index.months;
	const lines: MonthLine[] = [];
	for (const month of Object.keys(months).sort()) {
		const name = months[month];
		if (typeof name !== "string" || !MONTH_FILE_NAME.test(name)) {
			throw new SyncFailure(unreadable);
		}
		// biome-ignore lint/performance/noAwaitInLoops: one month file at a time, like a visitor's page
		const text = await requestWithRetry(
			`${base}/data/${name}`,
			get,
			"pull",
			"the site",
		);
		const monthLines = monthFileLines(parseAnswer(text));
		if (monthLines === null) {
			throw new SyncFailure(unreadable);
		}
		for (const line of monthLines) {
			lines.push(line);
		}
	}
	return lines;
}

// What pull --database needs from the environment: the API token, and the account and database ids.
type DatabaseAccess = { token: string; accountId: string; databaseId: string };

// An environment variable's value; an unset or empty one stops the run.
function requiredEnvironment(name: string) {
	const value = process.env[name] || "";
	if (!value) {
		throw new SyncFailure(`${name} must be set`);
	}
	return value;
}

// "2026-09" -> "2026-10", "2026-12" -> "2027-01".
function nextMonth(month: string) {
	const year = Number(month.slice(0, 4));
	const monthNumber = Number(month.slice(5, 7));
	if (monthNumber === 12) {
		return `${String(year + 1).padStart(4, "0")}-01`;
	}
	return `${month.slice(0, 4)}-${String(monthNumber + 1).padStart(2, "0")}`;
}

// One SQL statement's rows from D1, through Cloudflare's API.
type DatabaseQuery = (sql: string, params: string[]) => Promise<unknown[]>;

// What pull --database and count --database say when Cloudflare's API answers with something they can't read.
const DATABASE_UNREADABLE = "Cloudflare's API answer can't be read";

// The query function for D1 through Cloudflare's API with CLOUDFLARE_API_TOKEN: one statement's rows, from the API's
// {"success": true, "result": [{"results": [...]}]}.
function databaseQuery(access: DatabaseAccess): DatabaseQuery {
	const apiBase = (process.env.CLOUDFLARE_API_BASE || DEFAULT_API_BASE).replace(
		/\/+$/,
		"",
	);
	const url = `${apiBase}/accounts/${access.accountId}/d1/database/${access.databaseId}/query`;
	const headers = {
		Authorization: `Bearer ${access.token}`,
		"Content-Type": "application/json",
	};
	return async (sql: string, params: string[]) => {
		const text = await requestWithRetry(
			url,
			{
				method: "POST",
				headers: headers,
				body: JSON.stringify({ sql: sql, params: params }),
			},
			"pull",
			"Cloudflare's API",
		);
		const answer = parseAnswer(text);
		if (
			!isJsonObject(answer) ||
			answer.success !== true ||
			!Array.isArray(answer.result)
		) {
			throw new SyncFailure(DATABASE_UNREADABLE);
		}
		const first: unknown = answer.result[0];
		if (!isJsonObject(first) || !Array.isArray(first.results)) {
			throw new SyncFailure(DATABASE_UNREADABLE);
		}
		const rows: unknown[] = first.results;
		return rows;
	};
}

// Every entry D1 holds: the first and last dates (each one row through the entries_date index), then one month at a
// time through that index, in seq order within the month. Each row becomes a line of one entry; digestsTextOf joins a
// day's rows.
async function databaseLines(query: DatabaseQuery): Promise<MonthLine[]> {
	// The date in a one-row answer such as [{"date": "2026-09-01"}], or null for an empty table.
	const dateOf = (rows: unknown[]) => {
		const row = rows[0];
		if (!isJsonObject(row) || typeof row.date !== "string") {
			return null;
		}
		return row.date;
	};
	const firstDate = dateOf(
		await query("SELECT MIN(date) AS date FROM entries", []),
	);
	const lastDate = dateOf(
		await query("SELECT MAX(date) AS date FROM entries", []),
	);
	if (firstDate === null || lastDate === null) {
		return [];
	}

	const lines: MonthLine[] = [];
	const lastMonth = lastDate.slice(0, 7);
	let month = firstDate.slice(0, 7);
	if (!/^\d{4}-\d{2}$/.test(month) || !/^\d{4}-\d{2}$/.test(lastMonth)) {
		throw new SyncFailure(DATABASE_UNREADABLE);
	}
	while (month <= lastMonth) {
		const after = nextMonth(month);
		// biome-ignore lint/performance/noAwaitInLoops: one month at a time keeps each answer small
		const rows = await query(
			"SELECT id, date, json FROM entries WHERE date >= ? AND date < ? ORDER BY seq",
			[month, after],
		);
		for (const row of rows) {
			if (
				!isJsonObject(row) ||
				typeof row.date !== "string" ||
				typeof row.json !== "string"
			) {
				throw new SyncFailure(DATABASE_UNREADABLE);
			}
			const entry = parseAnswer(row.json);
			if (entry === null) {
				throw new SyncFailure(DATABASE_UNREADABLE);
			}
			lines.push({ date: row.date, entries: [entry] });
		}
		month = after;
	}
	return lines;
}

// The owner's Dislike, OK and Like marks from FEEDBACK_DAYS days ago up to today, each with its entry, through the
// feedback_date index and the entries' primary key.
export async function databaseFeedback(
	query: DatabaseQuery,
): Promise<FeedbackRow[]> {
	const rows = await query(
		"SELECT feedback.mark, feedback.date, entries.json FROM feedback " +
			"JOIN entries ON entries.id = feedback.entry_id WHERE feedback.date >= ?",
		[daysBefore(jakartaToday(), FEEDBACK_DAYS)],
	);
	const marks: FeedbackRow[] = [];
	for (const row of rows) {
		if (
			!isJsonObject(row) ||
			(row.mark !== "dislike" && row.mark !== "ok" && row.mark !== "like") ||
			typeof row.date !== "string" ||
			typeof row.json !== "string"
		) {
			throw new SyncFailure(DATABASE_UNREADABLE);
		}
		marks.push({
			mark: row.mark,
			date: row.date,
			entry: parseAnswer(row.json),
		});
	}
	return marks;
}

// The id of every entry D1 holds a read mark for, at any depth, sorted, read through `query` as databaseLines reads
// the entries. pull --database writes them to digests.read.json beside the digests file, for bringing unread papers back later.
export async function readMarkIds(query: DatabaseQuery): Promise<string[]> {
	const ids: string[] = [];
	for (const row of await query("SELECT entry_id FROM read_state", [])) {
		if (!isJsonObject(row) || typeof row.entry_id !== "string") {
			throw new SyncFailure(DATABASE_UNREADABLE);
		}
		ids.push(row.entry_id);
	}
	return ids.sort();
}

// How many of the scout's papers the database holds for `today` (a YYYY-MM-DD date in Asia/Jakarta): the entries dated
// today whose type is "paper" and that are neither ad hoc nor the surprise pick, counted as digests.ts status counts
// them, read with one query through the entries_date index. scout.yml runs it before the pull: a day with 10 or more
// ends there.
export async function countPapersToday(
	query: DatabaseQuery,
	today: string,
): Promise<number> {
	const rows = await query("SELECT json FROM entries WHERE date = ?", [today]);
	let papers = 0;
	for (const row of rows) {
		if (!isJsonObject(row) || typeof row.json !== "string") {
			throw new SyncFailure(DATABASE_UNREADABLE);
		}
		const entry = parseAnswer(row.json);
		if (entry === null) {
			throw new SyncFailure(DATABASE_UNREADABLE);
		}
		// The same rule as digests.ts status: a paper added ad hoc is not one of the scout's, and the surprise paper
		// is one on top of its topic papers.
		if (
			isJsonObject(entry) &&
			entry.type === "paper" &&
			entry.ad_hoc !== true &&
			entry.pick !== "surprise"
		) {
			papers += 1;
		}
	}
	return papers;
}

// Print "papers today: <n>" for the database, with the same token and ids as pull --database.
async function count() {
	const access: DatabaseAccess = {
		token: requiredEnvironment("CLOUDFLARE_API_TOKEN"),
		accountId: requiredEnvironment("CLOUDFLARE_ACCOUNT_ID"),
		databaseId: requiredEnvironment("D1_DATABASE_ID"),
	};
	const papers = await countPapersToday(databaseQuery(access), jakartaToday());
	console.log(`papers today: ${papers}`);
}

// Replace the digests file with what the site holds (the hosted files, or the database with --database), whatever it
// held, then make the pulled copy the same.
async function pull(file: string, fromDatabase: boolean) {
	// The token and the two ids are checked before anything is read.
	let access: DatabaseAccess | null = null;
	if (fromDatabase) {
		access = {
			token: requiredEnvironment("CLOUDFLARE_API_TOKEN"),
			accountId: requiredEnvironment("CLOUDFLARE_ACCOUNT_ID"),
			databaseId: requiredEnvironment("D1_DATABASE_ID"),
		};
	}

	const pulledPath = join(dirname(file), PULLED_NAME);
	let lines: MonthLine[];
	let readIds: string[] | null = null;
	let feedbackRows: FeedbackRow[] | null = null;
	if (access !== null) {
		const query = databaseQuery(access);
		lines = await databaseLines(query);
		readIds = await readMarkIds(query);
		feedbackRows = await databaseFeedback(query);
	} else {
		lines = await hostedLines();
	}
	const text = digestsTextOf(lines);
	replaceFile(file, text);
	replaceFile(pulledPath, text);
	// Only the database holds read marks; the hosted files never do.
	if (readIds !== null) {
		replaceFile(
			join(dirname(file), READ_MARKS_NAME),
			`${JSON.stringify(readIds)}\n`,
		);
	}
	// The scout and Jev read the recent likes and dislikes from the cache folder; they live only in the database.
	if (feedbackRows !== null) {
		const feedback = feedbackFileOf(feedbackRows);
		mkdirSync(dirname(feedbackPath()), { recursive: true });
		replaceFile(feedbackPath(), `${JSON.stringify(feedback, null, 2)}\n`);
	}

	// Count what was written: entries, and days (one line each).
	let entryCount = 0;
	const dates = new Set<string>();
	for (const line of lines) {
		entryCount += line.entries.length;
		dates.add(line.date);
	}
	console.log(`pulled ${entryCount} entries over ${dates.size} days`);
}

// Send the studies changed since the last pull-study to <LIMINAL_URL>/api/sync/study, one per request.
export async function pushStudies(
	_studyFile: string,
	_clientId: string,
	_clientSecret: string,
): Promise<void> {
	throw new Error("not implemented");
}

// Replace the study file with every study the site holds, one per line: from D1 with fromDatabase, else from the
// public study files.
export async function pullStudies(
	_studyFile: string,
	_fromDatabase: boolean,
): Promise<void> {
	throw new Error("not implemented");
}

// Check the command line, then push or pull. A SyncFailure is printed as one line with exit code 1.
async function main(args: string[]) {
	const command = args[0];
	// count takes no file: it only reads the database.
	if (command === "count") {
		if (args.length !== 2 || args[1] !== "--database") {
			console.error(USAGE);
			process.exitCode = 1;
			return;
		}
		try {
			await count();
		} catch (error) {
			if (!(error instanceof SyncFailure)) {
				throw error;
			}
			console.error(`sync.ts: ${error.message}`);
			process.exitCode = 1;
		}
		return;
	}
	const file = args[args.length - 1];
	const isPush = command === "push" && args.length === 2;
	const isPull = command === "pull" && args.length === 2;
	const isDatabasePull =
		command === "pull" && args.length === 3 && args[1] === "--database";
	// log's date is its file's name, YYYY-MM-DD.md.
	const runId = args[1] || "";
	const logName = LOG_FILE_NAME.exec(basename(file || ""));
	let logDate = "";
	if (logName !== null) {
		logDate = String(logName[1]);
	}
	const isLog =
		command === "log" &&
		args.length === 3 &&
		RUN_ID.test(runId) &&
		logDate !== "";
	// An option where the digests file goes, as in "pull --database" with no file, is a wrong command line.
	if (
		file === undefined ||
		file.startsWith("--") ||
		(!isPush && !isPull && !isDatabasePull && !isLog)
	) {
		console.error(USAGE);
		process.exitCode = 1;
		return;
	}
	try {
		if (isPull || isDatabasePull) {
			await pull(file, isDatabasePull);
			return;
		}
		// The token is checked before any file is read.
		const clientId = process.env.ACCESS_SYNC_ID;
		const clientSecret = process.env.ACCESS_SYNC_SECRET;
		if (!clientId || !clientSecret) {
			throw new SyncFailure(
				"ACCESS_SYNC_ID and ACCESS_SYNC_SECRET must both be set",
			);
		}
		if (isLog) {
			await sendLog(runId, logDate, file, clientId, clientSecret);
			return;
		}
		await push(file, clientId, clientSecret);
	} catch (error) {
		if (!(error instanceof SyncFailure)) {
			throw error;
		}
		console.error(`sync.ts: ${error.message}`);
		process.exitCode = 1;
	}
}

// Run only when called as a script, not when imported.
if (import.meta.main) {
	await main(process.argv.slice(2));
}
