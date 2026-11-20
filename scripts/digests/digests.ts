// Answer the scout's questions about a digests file, add news, articles and reports to it, and check every line.
// Usage: node scripts/digests/digests.ts status [--date YYYY-MM-DD] <digests file>
//        | add [--date YYYY-MM-DD] <digests file> <items file> | check <digests file>
// --date D fills in a day the scout missed: status and add work as if today were D (rule in scripts/lib/run-date.ts).
// add --ad-hoc (add.yml) marks every added entry "ad_hoc": true; "ad_hoc" joins the schema's fields, and check
// accepts it on news, articles and reports. The usage line leaves it out, as add.yml's own option.
// Environment: LIMINAL_TODAY (YYYY-MM-DD) is taken as today in Asia/Jakarta; tests only.
import { existsSync, readFileSync } from "node:fs";
import {
	ADDED_TYPES,
	type DigestLine,
	entryProblems,
	hasControlCharacter,
	hasText,
	isDay,
	jsonErrorPosition,
	linkLabel,
	normalizeUrl,
	readLines,
	SCHEMA_KEYS,
} from "../../shared/entry-checks.ts";
import {
	errorCode,
	isJsonObject,
	type JsonObject,
} from "../../shared/narrow.ts";
import { type Fail, failer } from "../lib/cli.ts";
import {
	daysBefore,
	jakartaToday,
	MAX_DAYS_BACK,
	runDateProblem,
	takeDateOption,
} from "../lib/run-date.ts";
import { appendDigestLine, readDigestsText } from "./digests-file.ts";

const fail: Fail = failer("digests.ts");

const USAGE =
	"usage: node scripts/digests/digests.ts status [--date YYYY-MM-DD] <digests file> | " +
	"add [--date YYYY-MM-DD] <digests file> <items file> | check <digests file>";

// What check found in a digests text: the counts it reports and every problem, in the words it prints.
type CheckResult = {
	lines: number;
	entries: number;
	problems: string[];
};

// Stop at the first line that doesn't load, naming it; status and add rely on every line loading.
function stopAtUnloadedLine(lines: DigestLine[], file: string) {
	for (const line of lines) {
		if (line.problem !== undefined) {
			fail(`line ${line.number} of ${file} ${line.problem}`);
		}
	}
}

// A digests file's text; a file that doesn't exist yet reads as empty, and any other read error stops the run.
function digestsTextOrFail(file: string) {
	try {
		return readDigestsText(file);
	} catch (error) {
		fail(`can't read ${file} (${errorCode(error)})`);
	}
}

// "1 and 3", "1, 3 and 5"
function listed(numbers: number[]) {
	if (numbers.length === 1) {
		return String(numbers[0]);
	}
	const allButLast = numbers.slice(0, -1).join(", ");
	return `${allButLast} and ${numbers[numbers.length - 1]}`;
}

// Every problem in a digests text, each as the text check prints after "digests.ts: ", with the counts check reports.
// Blank lines count neither as lines nor for the problems' line numbers, which are the file's own.
export function checkText(text: string): CheckResult {
	const problems = [];
	const idLines = new Map<string, number[]>(); // id -> the line number of each entry that has it, in file order
	let lineCount = 0;
	let entryCount = 0;
	for (const line of readLines(text)) {
		lineCount += 1;
		const at = `line ${line.number}`;
		if (line.problem !== undefined) {
			problems.push(`${at}: ${line.problem}`);
			continue;
		}
		const digest = line.digest;
		if (!isJsonObject(digest) || !isDay(digest.date)) {
			problems.push(`${at}: date must be YYYY-MM-DD`);
		}
		if (!isJsonObject(digest) || !Array.isArray(digest.entries)) {
			problems.push(`${at}: entries must be a list`);
			continue;
		}
		for (let k = 0; k < digest.entries.length; k++) {
			entryCount += 1;
			const entry: unknown = digest.entries[k];
			if (!isJsonObject(entry)) {
				problems.push(`${at}: entry ${k + 1} is not an object`);
				continue;
			}
			// Name an entry by its id, or by its place in the line when it has none or its id holds a control character,
			// which would split the message into lines.
			let label = `entry ${k + 1}`;
			if (hasText(entry.id)) {
				if (!hasControlCharacter(entry.id)) {
					label = entry.id;
				}
				const numbers = idLines.get(entry.id) || [];
				numbers.push(line.number);
				idLines.set(entry.id, numbers);
			}
			for (const problem of entryProblems(entry, "check")) {
				problems.push(`${at}: ${label}: ${problem}`);
			}
		}
	}

	// An id twice makes two entries share read state and comments on the page.
	for (const [id, numbers] of idLines) {
		// A Set keeps the order numbers first appear in.
		const distinct = Array.from(new Set(numbers));
		if (distinct.length > 1) {
			problems.push(`id ${id} is on lines ${listed(distinct)}`);
		} else if (numbers.length > 1) {
			problems.push(`id ${id} is on line ${distinct[0]} more than once`);
		}
	}
	return { lines: lineCount, entries: entryCount, problems: problems };
}

// Sort order for { date } items: newest date first; items on the same date keep their order.
function newestFirst(a: { date: string }, b: { date: string }) {
	if (a.date > b.date) {
		return -1;
	}
	if (a.date < b.date) {
		return 1;
	}
	return 0;
}

// The 7 days before `today` (YYYY-MM-DD) without a paper from the scout, oldest first; today is never listed.
export function missingDays(text: string, today: string): string[] {
	const dated = new Set<string>();
	for (const line of readLines(text)) {
		if (
			!isJsonObject(line.digest) ||
			typeof line.digest.date !== "string" ||
			!Array.isArray(line.digest.entries)
		) {
			continue;
		}
		// The newsfeed and ad hoc additions also write lines, so only a scout's paper marks the day as run.
		const entries: unknown[] = line.digest.entries;
		if (
			entries.some(
				(entry) =>
					isJsonObject(entry) &&
					entry.type === "paper" &&
					entry.ad_hoc !== true,
			)
		) {
			dated.add(line.digest.date);
		}
	}
	const missing: string[] = [];
	for (let back = MAX_DAYS_BACK; back >= 1; back--) {
		const day = daysBefore(today, back);
		if (!dated.has(day)) {
			missing.push(day);
		}
	}
	return missing;
}

// What status prints for a digests text, final line break included. `today` is the real YYYY-MM-DD date in
// Asia/Jakarta, which the days without papers count back from; `date` is the day given with --date, or null. The
// counts and the news list are those of `date || today`.
// A line that doesn't load is skipped here; the command stops before calling this when the file has one.
export function statusText(
	text: string,
	today: string,
	date: string | null,
): string {
	let day = today;
	let header = `today: ${today} (Asia/Jakarta)`;
	if (date !== null) {
		day = date;
		header = `today: ${date} (Asia/Jakarta, set by --date)`;
	}
	let missing = "none";
	const missingList = missingDays(text, today);
	if (missingList.length > 0) {
		missing = missingList.join(", ");
	}
	const output = [
		header,
		`days without papers in the last ${MAX_DAYS_BACK}: ${missing}`,
		...dayLines(text, day),
	];
	return `${output.join("\n")}\n`;
}

// What status prints after its "today:" line for a YYYY-MM-DD day: that day's counts, then the news, articles and
// reports from the 6 days before it through the newest line. Lines dated after the day are listed too: with --date,
// a story added since then is still covered.
function dayLines(text: string, today: string) {
	const weekStart = daysBefore(today, 6); // today and the 6 days before it
	let papersToday = 0;
	let surpriseToday = false;
	let othersToday = 0;
	const recent: { date: string; entry: JsonObject }[] = []; // { date, entry } for each news, article or report entry from weekStart on
	for (const line of readLines(text)) {
		if (
			line.problem !== undefined ||
			!isJsonObject(line.digest) ||
			!Array.isArray(line.digest.entries)
		) {
			continue;
		}
		const date = line.digest.date;
		if (typeof date !== "string") {
			continue;
		}
		// Array.isArray says "a list" but not of what; each entry is still unchecked.
		const entries: unknown[] = line.digest.entries;
		for (const entry of entries) {
			if (!isJsonObject(entry)) {
				continue;
			}
			if (date === today && entry.type === "paper") {
				// A paper added ad hoc (from any Claude app, at any time) is not one of the scout's, so it leaves the
				// scout's daily count alone: three added from the phone before 07:00 would otherwise leave the scout two.
				// The surprise paper is one on top of the topic papers, so it leaves the count alone too.
				if (entry.pick === "surprise") {
					surpriseToday = true;
				} else if (entry.ad_hoc !== true) {
					papersToday += 1;
				}
			}
			if (ADDED_TYPES.includes(entry.type)) {
				if (date === today) {
					othersToday += 1;
				}
				if (date >= weekStart) {
					recent.push({ date: date, entry: entry });
				}
			}
		}
	}
	// sort() is stable, so entries of one day stay in file order.
	recent.sort(newestFirst);

	let surprise = "no";
	if (surpriseToday) {
		surprise = "yes";
	}
	const output = [
		`papers today: ${papersToday}`,
		`surprise today: ${surprise}`,
		`news, articles and reports today: ${othersToday}`,
	];
	if (recent.length === 0) {
		output.push("news, articles and reports from the last 7 days: none");
	} else {
		output.push("news, articles and reports from the last 7 days:");
		for (const item of recent) {
			output.push(
				`${item.date} ${item.entry.type} ${item.entry.id} ${item.entry.title}`,
			);
		}
	}
	return output;
}

// Print the day's counts and news, articles and reports, and the days of the last 7 without a digest. `date` is the
// day given with --date, null for today. The missing days always count back from the real today.
function status(file: string, date: string | null) {
	const text = digestsTextOrFail(file);
	stopAtUnloadedLine(readLines(text), file);
	process.stdout.write(statusText(text, jakartaToday(), date));
}

// The entries in an items file: one JSON object, or a list of them. Stops when the file can't be used.
function readItems(itemsFile: string): unknown[] {
	if (!existsSync(itemsFile)) {
		fail(`the items file ${itemsFile} doesn't exist`);
	}
	let content: string;
	try {
		content = readFileSync(itemsFile, "utf8");
	} catch (error) {
		fail(`the items file ${itemsFile} can't be read (${errorCode(error)})`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (error) {
		// Name the place, never the parser's message: it can quote the file.
		const position = jsonErrorPosition(error);
		if (position === null) {
			fail(`the items file ${itemsFile} is not JSON`);
		} else {
			fail(
				`the items file ${itemsFile} is not JSON (at line ${position.line}, column ${position.column})`,
			);
		}
	}
	// One object is a list of one.
	let items: unknown[];
	if (Array.isArray(parsed)) {
		items = parsed;
	} else {
		items = [parsed];
	}
	if (items.length === 0) {
		fail(`the items file ${itemsFile} holds no entries`);
	}
	return items;
}

// An accepted entry as written to the file: the id filled in when absent, the keys in the schema's order, and
// "ad_hoc": true last when `adHoc`.
function orderedEntry(item: JsonObject, adHoc: boolean) {
	const entry: JsonObject = { id: item.id || `url:${item.url}` };
	for (const key of SCHEMA_KEYS) {
		if (key !== "id" && item[key] !== undefined) {
			entry[key] = item[key];
		}
	}
	if (adHoc) {
		entry.ad_hoc = true;
	}
	return entry;
}

// Append the items file's acceptable entries as one line dated `day`, skipping URLs the file already has. With
// `adHoc`, every entry is marked "ad_hoc": true.
function add(file: string, itemsFile: string, day: string, adHoc: boolean) {
	const text = digestsTextOrFail(file);
	const lines = readLines(text);
	stopAtUnloadedLine(lines, file);
	const items = readItems(itemsFile);

	// Every URL already in the file, of any type, in the form repeats are compared in.
	const known = new Set<string>();
	for (const line of lines) {
		if (!isJsonObject(line.digest) || !Array.isArray(line.digest.entries)) {
			continue;
		}
		// Array.isArray says "a list" but not of what; each entry is still unchecked.
		const entries: unknown[] = line.digest.entries;
		for (const entry of entries) {
			if (isJsonObject(entry) && typeof entry.url === "string") {
				known.add(normalizeUrl(entry.url));
			}
		}
	}

	const accepted: JsonObject[] = [];
	const addedNow = new Set<string>(); // normalized URLs accepted earlier in this call
	let refused = false;
	for (let k = 0; k < items.length; k++) {
		const item: unknown = items[k];
		const problems = entryProblems(item, "add");
		if (problems.length > 0) {
			console.error(
				`digests.ts: refused ${linkLabel(item, `entry ${k + 1}`)}: ${problems.join("; ")}`,
			);
			refused = true;
			continue;
		}
		// entryProblems found nothing wrong, so the item is an object with an http or https url; TypeScript can't see that.
		const valid = item as JsonObject & { url: string };
		const url = normalizeUrl(valid.url);
		if (known.has(url)) {
			console.error(`digests.ts: already in ${file}, skipped: ${valid.url}`);
			continue;
		}
		if (addedNow.has(url)) {
			console.error(
				`digests.ts: already added in this call, skipped: ${valid.url}`,
			);
			continue;
		}
		addedNow.add(url);
		accepted.push(orderedEntry(valid, adHoc));
	}
	if (accepted.length === 0) {
		fail("nothing added");
	}

	try {
		appendDigestLine(file, day, accepted);
	} catch (error) {
		fail(`can't append to ${file} (${errorCode(error)})`);
	}
	for (const entry of accepted) {
		console.log(`added ${entry.id} ${entry.title}`);
	}

	// The accepted entries are written, but a refused one is still a failure the caller must see.
	// exitCode, not exit(): exit() could cut off output that is still being written.
	if (refused) {
		process.exitCode = 1;
	}
}

// Name every problem in the file, or say it is well formed.
function check(file: string) {
	if (!existsSync(file)) {
		fail(`${file} doesn't exist`);
	}
	const result = checkText(digestsTextOrFail(file));
	if (result.problems.length > 0) {
		for (const problem of result.problems) {
			console.error(`digests.ts: ${problem}`);
		}
		process.exitCode = 1;
		return;
	}
	console.log(`ok: ${result.lines} lines, ${result.entries} entries`);
}

// Stop with the usage line.
function usage(): never {
	console.error(USAGE);
	process.exit(1);
}

function main(args: string[]) {
	// --date given twice or without a value, or given to check, is a wrong command line.
	const parsed = takeDateOption(args);
	if (parsed === null) {
		usage();
	}
	const date = parsed.date;
	// --ad-hoc may stand anywhere after add, once.
	const rest = parsed.rest.filter((arg) => arg !== "--ad-hoc");
	const adHocCount = parsed.rest.length - rest.length;
	const command = rest[0];
	const length = rest.length;
	// The length checks already say these exist; the undefined checks tell TypeScript.
	const file = rest[1];
	const itemsFile = rest[2];
	if (adHocCount > 1 || (adHocCount === 1 && command !== "add")) {
		usage();
	}
	if (command === "check" && length === 2 && file !== undefined) {
		if (date !== null) {
			usage();
		}
		check(file);
		return;
	}
	const isStatus = command === "status" && length === 2;
	const isAdd = command === "add" && length === 3;
	if (file === undefined || (!isStatus && !isAdd)) {
		usage();
	}

	// A --date that can't be filled in stops here, before any file is read.
	const today = jakartaToday();
	if (date !== null) {
		const problem = runDateProblem(date, today);
		if (problem !== null) {
			fail(problem);
		}
	}
	if (isStatus) {
		status(file, date);
	} else if (itemsFile !== undefined) {
		add(file, itemsFile, date || today, adHocCount === 1);
	}
}

// Run only when called as a script, not when imported.
if (import.meta.main) {
	main(process.argv.slice(2));
}
