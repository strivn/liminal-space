// Turn arXiv ids into one digests.js line, copying metadata exactly from arXiv's API so no model retypes it.
// When the API fails, the same metadata comes from arXiv's OAI-PMH service instead.
// Usage: node scripts/scout/arxiv/arxiv.ts [--append <file>] [--date YYYY-MM-DD] [--pick surprise [--pick-source <url>]]
//                               [--venue <venue> --venue-source <url>] <id> [<id> ...]
// --date D fills in a day the scout missed: the line is dated D, and a paper first submitted after D is dropped.
// --ad-hoc (add.yml) marks every appended paper "ad_hoc": true, after its other fields; status leaves such papers out
// of "papers today". The usage line leaves it out, as add.yml's own option.
// Environment: ARXIV_API, ARXIV_OAI (stand-ins for tests); LIMINAL_TODAY (YYYY-MM-DD) is taken as today in
// Asia/Jakarta and ARXIV_PAUSE_MS as the pause between requests, tests only.
import {
	accessSync,
	constants,
	existsSync,
	readFileSync,
	statSync,
} from "node:fs";
import { dirname } from "node:path";
import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import { isArxivId, normalizeId } from "../../../shared/arxiv-id.ts";
import { errorCode } from "../../../shared/narrow.ts";
import {
	appendDigestLine,
	digestLine,
	idsInText,
} from "../../digests/digests-file.ts";
import { type Fail, failer } from "../../lib/cli.ts";
import CONSTANTS from "../../lib/constants.json" with { type: "json" };
import { jakartaToday, runDateProblem } from "../../lib/run-date.ts";
import {
	ARXIV_PAUSE_MS,
	type ArxivResponse,
	apiFailed,
	arxivRequest,
	field,
	OAI,
	oaiError,
	type Paper,
	parseFeed,
	parseOaiRecord,
	rejectedId,
	text,
	whatHappened,
} from "./api.ts";

const fail: Fail = failer("arxiv.ts");

const API = process.env.ARXIV_API || CONSTANTS.arxivApi;
const USAGE =
	"usage: node scripts/scout/arxiv/arxiv.ts [--append <file>] [--date YYYY-MM-DD] [--pick surprise [--pick-source <url>]] " +
	"[--venue <venue> --venue-source <url>] <id> [<id> ...]";
// The options for node:util's parseArgs. Each but --ad-hoc takes a value, written "--append <file>" or
// "--append=<file>". --venue is a conference acceptance found outside arXiv; --venue-source and --pick-source are the
// pages the scout read. --date is the day the line is dated, when the scout fills in a day it missed. --ad-hoc marks
// papers added from a Claude app.
const OPTIONS = {
	append: { type: "string" },
	date: { type: "string" },
	pick: { type: "string" },
	venue: { type: "string" },
	"venue-source": { type: "string" },
	"pick-source": { type: "string" },
	"ad-hoc": { type: "boolean" },
} satisfies ParseArgsOptionsConfig;

// A paper OAI-PMH didn't give: the request that failed, what happened, and whether asking again won't help.
type OaiFailure = { id: string; url: string; what: string; lasting: boolean };

// The command line, read: the digests file to append to, the pick, the venue, their sources, whether the papers are
// added ad hoc, and the ids.
type Options = {
	file: string | null;
	date: string | null;
	pick: string | null;
	pickSource: string | null;
	venue: string | null;
	venueSource: string | null;
	adHoc: boolean;
	ids: string[];
};

// Name the ids a check dropped, on one line: "arxiv.ts: not found on arXiv: 2507.99999, 2507.99998".
function report(problem: string, ids: string[]) {
	if (ids.length > 0) {
		console.error(`arxiv.ts: ${problem}: ${ids.join(", ")}`);
	}
}

// Stop unless an option's value is a web address: "conference list", "javascript:alert(1)" or "https://" alone is
// not a source.
function checkWebAddress(option: string, value: string) {
	const hasWebScheme =
		value.startsWith("http://") || value.startsWith("https://");
	// URL.canParse follows the browser's URL rules, under which an http or https address with no host doesn't parse.
	if (!hasWebScheme || !URL.canParse(value)) {
		fail(`${option} must be an http or https URL, got "${value}"`);
	}
}

// The command line parsed strictly; stops with Node's reason, on one line, when parseArgs refuses it.
function parseStrictly(args: string[]) {
	try {
		return parseArgs({
			args: args,
			options: OPTIONS,
			allowPositionals: true,
			strict: true,
		});
	} catch (error) {
		// Node's message can run over several lines and may or may not end in a full stop ("Option '--pick <value>'
		// argument missing"): the reason goes on one line and ends in exactly one full stop before the usage line.
		// parseArgs throws a TypeError, which always has a message.
		if (!(error instanceof Error)) {
			throw error;
		}
		const reason = error.message.replace(/\s+/g, " ").trim().replace(/\.$/, "");
		fail(`${reason}. ${USAGE}`);
	}
}

// Stop on an option the script doesn't know, or on one given twice.
function checkOptionNames(args: string[]) {
	// An option the script doesn't know is named as typed ("--pik" in "--pik surprise" or "--pik=surprise").
	// A loose parse lists every option without refusing any; the strict parse below would refuse it with Node's wording.
	const loose = parseArgs({
		args: args,
		options: OPTIONS,
		allowPositionals: true,
		strict: false,
		tokens: true,
	});
	for (const token of loose.tokens) {
		if (token.kind === "option" && !Object.hasOwn(OPTIONS, token.name)) {
			fail(`unknown option "${token.rawName}". ${USAGE}`);
		}
	}
	// parseArgs keeps the last of a repeated option, so a second "--append <file>" would replace the first: an allow
	// rule that names the first file must not let a later one through.
	const seen = new Set<string>();
	for (const token of loose.tokens) {
		if (token.kind !== "option") continue;
		if (seen.has(token.name)) {
			fail(`"--${token.name}" is given more than once. ${USAGE}`);
		}
		seen.add(token.name);
	}
}

// Split the command line into the digest file, the pick, the venue, their sources and the ids; stop on anything else.
function readOptions(args: string[]) {
	checkOptionNames(args);
	// The strict parse refuses an option without its value, such as a final "--append".
	const parsed = parseStrictly(args);

	const values = parsed.values;
	const options: Options = {
		file: null,
		date: null,
		pick: null,
		pickSource: null,
		venue: null,
		venueSource: null,
		adHoc: values["ad-hoc"] === true,
		ids: parsed.positionals,
	};
	if (values.append !== undefined) {
		if (values.append === "") {
			fail(`--append needs a file. ${USAGE}`);
		}
		// "--append 1706.03762 ..." forgot the file: the id would become a new file and never be fetched.
		if (isArxivId(normalizeId(values.append)) && !existsSync(values.append)) {
			fail(
				`--append needs a file, but got "${values.append}", which looks like an arXiv id. ${USAGE}`,
			);
		}
		options.file = values.append;
	}
	// A --date that can't be filled in stops here, before arXiv is asked.
	if (values.date !== undefined) {
		if (values.date === "") {
			fail(`--date needs a date. ${USAGE}`);
		}
		const problem = runDateProblem(values.date, jakartaToday());
		if (problem !== null) {
			fail(problem);
		}
		options.date = values.date;
	}
	if (values.pick !== undefined) {
		if (values.pick !== "surprise") {
			fail('--pick accepts only "surprise"');
		}
		options.pick = values.pick;
	}

	// A venue without the page that lists it can't be checked later, and a page without a venue says nothing.
	const venue = values.venue;
	const venueSource = values["venue-source"];
	const hasVenue = venue !== undefined;
	const hasVenueSource = venueSource !== undefined;
	if (hasVenue !== hasVenueSource) {
		fail("--venue and --venue-source go together");
	}
	// "--venue=" or "--venue ' '" names no venue: the entry would lose its venue and source, or show a blank one.
	if (hasVenue && venue.trim() === "") {
		fail("--venue needs a venue name");
	}
	if (hasVenueSource) {
		checkWebAddress("--venue-source", venueSource);
	}
	if (values["pick-source"] !== undefined) {
		checkWebAddress("--pick-source", values["pick-source"]);
		// pick_source says where the surprise paper was found, so it needs a surprise paper.
		if (options.pick !== "surprise") {
			fail("--pick-source needs --pick surprise");
		}
		options.pickSource = values["pick-source"];
	}
	// Both or neither, as checked above.
	if (hasVenue && hasVenueSource) {
		options.venue = venue;
		options.venueSource = venueSource;
	}
	return options;
}

// The papers OAI-PMH has for these ids, two requests per paper, and what happened to the rest.
// failed: { id, url, what, lasting }; lasting means asking again won't help (an OAI-PMH error, a record without a date).
async function fetchFromOai(ids: string[]) {
	const result: {
		papers: Paper[];
		notFound: string[];
		rejected: string[];
		failed: OaiFailure[];
	} = { papers: [], notFound: [], rejected: [], failed: [] };
	for (const id of ids) {
		const formats: Record<string, string> = {}; // format -> the record's XML
		const urls: Record<string, string> = {}; // format -> the URL it was asked with
		for (const format of ["arXiv", "arXivRaw"]) {
			// biome-ignore lint/performance/noAwaitInLoops: arXiv asks for spaced-out requests; arxivRequest waits between them, so they go one at a time
			const answer = await arxivRequest(
				`${OAI}?verb=GetRecord&metadataPrefix=${format}&identifier=oai:arXiv.org:${id}`,
			);
			let error = null;
			if (answer.ok) {
				error = oaiError(answer.body);
			}
			if (error !== null && error.code === "idDoesNotExist") {
				if (error.reason.includes("Invalid arXiv_id structure")) {
					result.rejected.push(id);
				} else {
					result.notFound.push(id);
				}
				break;
			}
			if (error !== null) {
				result.failed.push({
					id: id,
					url: answer.url,
					what: `answered with error ${error.code} "${error.reason}"`,
					lasting: true,
				});
				break;
			}
			if (!answer.ok || !answer.body.includes("<record>")) {
				result.failed.push({
					id: id,
					url: answer.url,
					what: whatHappened(answer, "an OAI-PMH record"),
					lasting: false,
				});
				break;
			}
			formats[format] = answer.body;
			urls[format] = answer.url;
		}
		if (formats.arXiv && formats.arXivRaw) {
			const paper = parseOaiRecord(formats.arXiv, formats.arXivRaw, id);
			if (paper.published === "") {
				// The version dates come from the arXivRaw record, so that is the request named.
				result.failed.push({
					id: id,
					// Set in the same step as formats.arXivRaw, which was just checked; TypeScript can't link the two.
					url: urls.arXivRaw as string,
					what: "gave a record without a readable first-version date",
					lasting: true,
				});
			} else {
				result.papers.push(paper);
			}
		}
	}
	return result;
}

// Stop with a one-line reason when `file` can't be read and appended to.
function checkAppendTarget(file: string) {
	const folder = dirname(file);
	if (!existsSync(folder)) {
		fail(`can't append to ${file}: its folder does not exist`);
	}
	if (!statSync(folder).isDirectory()) {
		fail(`can't append to ${file}: its folder is not a folder`);
	}
	if (existsSync(file) && statSync(file).isDirectory()) {
		fail(`can't append to ${file}: it is a folder`);
	}
	// A new file needs a writable folder; an existing one must be readable (for the repeat check) and writable.
	try {
		if (existsSync(file)) {
			accessSync(file, constants.R_OK | constants.W_OK);
		} else {
			accessSync(folder, constants.W_OK);
		}
	} catch (error) {
		fail(`can't append to ${file}: it can't be written (${errorCode(error)})`);
	}
}

// The first required field an entry lacks: "title", "authors" or "date"; null when it has them all or there is no entry.
function missingField(paper: Paper | undefined) {
	if (!paper) {
		return null;
	}
	if (paper.title.trim() === "") {
		return "title";
	}
	if (
		paper.authors.length === 0 ||
		paper.authors.some((name) => name.trim() === "")
	) {
		return "authors";
	}
	if (!/^\d{4}-\d{2}-\d{2}$/.test(paper.published)) {
		return "date";
	}
	return null;
}

// "1 paper", "2 papers"
function papersCount(count: number) {
	if (count === 1) {
		return "1 paper";
	}
	return `${count} papers`;
}

// The ids to ask arXiv for, each once in the order given, without the malformed ones and, with --append, without those
// the file already holds; also the malformed ones, for the exit code.
function idsToAsk(options: Options) {
	// Normalize, and keep each id once, in the order given.
	const wanted: string[] = [];
	for (const raw of options.ids) {
		const id = normalizeId(raw);
		if (!wanted.includes(id)) {
			wanted.push(id);
		}
	}
	if (wanted.length === 0) {
		fail(USAGE);
	}

	// Drop ids that can't be arXiv ids before asking arXiv: one of them would make it reject the whole call.
	const malformed = wanted.filter((id) => !isArxivId(id));
	// An empty argument would print as nothing after the colon; show it as "".
	report(
		"not an arXiv id",
		malformed.map((id) => id || '""'),
	);
	let toFetch = wanted.filter((id) => isArxivId(id));

	// With --append, skip ids the file already holds. A file that doesn't exist yet holds none.
	if (options.file && existsSync(options.file)) {
		const existing = idsInText(readFileSync(options.file, "utf8")).arxiv;
		report(
			`already in ${options.file}, skipped`,
			toFetch.filter((id) => existing.has(id)),
		);
		toFetch = toFetch.filter((id) => !existing.has(id));
	}
	return { malformed: malformed, toFetch: toFetch };
}

// What fetching the ids gave: the ids still wanted (those arXiv rejected are gone), their papers, the ids arXiv has no
// entry for, the ids it rejected, and the papers neither source gave.
type Fetched = {
	toFetch: string[];
	papers: Paper[];
	missing: string[];
	rejected: string[];
	notFetched: OaiFailure[];
};

// Ask arXiv's API for the papers, dropping the ids it rejects; its OAI-PMH service gives them when the API fails.
async function fetchPapers(ids: string[]): Promise<Fetched> {
	let toFetch = ids;
	// One call for all ids keeps within arXiv's request to space out repeated calls.
	// If arXiv still rejects an id as malformed, drop it and ask again for the rest (arxivRequest waits 3 s).
	// If the API fails, fetch the papers still wanted from OAI-PMH instead.
	const rejected: string[] = [];
	let papers: Paper[] = [];
	let missing: string[] = [];
	let notFetched: OaiFailure[] = []; // { id, url, what, lasting } for papers neither source gave
	while (toFetch.length > 0) {
		// biome-ignore lint/performance/noAwaitInLoops: each retry asks again without the ids arXiv rejected in the answer before
		const answer = await arxivRequest(
			`${API}?id_list=${toFetch.join(",")}&max_results=${toFetch.length}`,
		);
		if (apiFailed(answer)) {
			const seconds = (toFetch.length * 2 * ARXIV_PAUSE_MS) / 1000;
			console.error(
				`arxiv.ts: arXiv API ${whatHappened(answer, "an arXiv feed")} (${answer.url}); ` +
					`fetching ${papersCount(toFetch.length)} from OAI-PMH instead, about ${seconds} s`,
			);
			const fromOai = await fetchFromOai(toFetch);
			papers = fromOai.papers;
			missing = fromOai.notFound;
			report("rejected by arXiv", fromOai.rejected);
			rejected.push(...fromOai.rejected);
			notFetched = fromOai.failed;
			break;
		}
		if (answer.ok) {
			papers = parseFeed(answer.body);
			// arXiv answers a missing id with HTTP 200 and no entry.
			const found = new Set(papers.map((paper) => paper.id));
			missing = toFetch.filter((id) => !found.has(`arxiv:${id}`));
			break;
		}
		// apiFailed returned false, so arXiv did answer; TypeScript can't see that check inside apiFailed.
		const response = answer as ArxivResponse;
		const badId = rejectedId(response.body);
		if (response.status !== 400 || badId === null || !toFetch.includes(badId)) {
			let message = `arXiv API answered HTTP ${response.status} for ${response.url}`;
			const arxivSays = text(field(response.body, "summary"));
			if (arxivSays) {
				message += `: ${arxivSays}`;
			}
			fail(message);
		}
		report("rejected by arXiv", [badId]);
		rejected.push(badId);
		toFetch = toFetch.filter((id) => id !== badId);
	}
	return {
		toFetch: toFetch,
		papers: papers,
		missing: missing,
		rejected: rejected,
		notFetched: notFetched,
	};
}

// The next step for papers OAI-PMH didn't give: wait and rerun, or (when asking again won't help) check them.
function nextStep(lasting: boolean, ids: string[], appending: boolean) {
	if (lasting) {
		const pages = ids.map((id) => `https://arxiv.org/abs/${id}`).join(", ");
		return `asking again won't help; check ${pages}`;
	}
	if (appending) {
		return "arXiv is overloaded or unreachable; run the same command again later; ids already in the file are skipped";
	}
	return "arXiv is overloaded or unreachable; run the same command again later";
}

// One stderr line for one group, whether or not other papers were written: each id with the OAI-PMH request
// that failed for it, then what to do next.
// "arxiv.ts: not fetched because OAI-PMH answered HTTP 503: 1706.03762 (<url>), hep-th/9901001 (<url>). <rest>"
function notFetchedLine(
	what: string,
	group: OaiFailure[],
	nothingWritten: boolean,
	appending: boolean,
) {
	// What to call the output in messages: a preview prints, --append appends.
	let written = "printed";
	if (appending) {
		written = "appended";
	}
	const ids = group.map((failure) => failure.id);
	const named = group
		.map((failure) => `${failure.id} (${failure.url})`)
		.join(", ");
	let lasting = false;
	const first = group[0];
	if (first !== undefined) {
		lasting = first.lasting;
	}
	let rest: string;
	if (nothingWritten) {
		rest = `Nothing was ${written}: ${nextStep(lasting, ids, appending)}.`;
	} else {
		let step = "run the same command again later for these ids";
		if (lasting) {
			step = nextStep(true, ids, appending);
		}
		rest = `The other papers were ${written}; ${step}.`;
	}
	return `arxiv.ts: not fetched because OAI-PMH ${what}: ${named}. ${rest}`;
}

// arXiv sorts results by id; restore the order asked for. An entry missing its title, authors or date
// would show as a broken card, so it is dropped and named instead.
// With --date, a paper first submitted after that day couldn't have been in its digest: it is dropped and named.
function entriesToWrite(fetched: Fetched, options: Options) {
	const byId = new Map<string, Paper>(
		fetched.papers.map((paper) => [paper.id, paper]),
	);
	const entries: Paper[] = [];
	const incomplete: string[] = [];
	const tooNew: string[] = [];
	for (const id of fetched.toFetch) {
		const paper = byId.get(`arxiv:${id}`);
		const gap = missingField(paper);
		if (gap) {
			console.error(`arxiv.ts: incomplete on arXiv, missing its ${gap}: ${id}`);
			incomplete.push(id);
		} else if (
			paper &&
			options.date !== null &&
			paper.published > options.date
		) {
			console.error(
				`arxiv.ts: arxiv:${id} was first submitted on ${paper.published}, after ${options.date}`,
			);
			tooNew.push(id);
		} else if (paper) {
			addOutsideFacts(paper, options);
			entries.push(paper);
		}
	}
	return { entries: entries, incomplete: incomplete, tooNew: tooNew };
}

// Facts from outside arXiv go after arXiv's own fields, in this order, and only when given:
// pick, pick_source, venue, venue_source, ad_hoc. JSON.stringify writes keys in the order they were set.
function addOutsideFacts(paper: Paper, options: Options) {
	if (options.pick) {
		paper.pick = options.pick;
	}
	if (options.pickSource) {
		paper.pick_source = options.pickSource;
	}
	if (options.venue) {
		paper.venue = options.venue;
		// readOptions sets venueSource whenever it sets venue; TypeScript can't link the two fields.
		paper.venue_source = options.venueSource as string;
	}
	if (options.adHoc) {
		paper.ad_hoc = true;
	}
}

// Print the line, or append it to the --append file and name each paper that landed.
function writeEntries(options: Options, day: string, entries: Paper[]) {
	if (options.file) {
		// The target was checked before fetching; a failure here (a dangling link, a change meanwhile) still gets one line.
		try {
			appendDigestLine(options.file, day, entries);
		} catch (error) {
			fail(
				`can't append to ${options.file} (${errorCode(error)}): the papers were fetched but not written; ` +
					"fix the path and run the same command again",
			);
		}
		// Each paper by id and title, in the order asked, so the caller sees what landed without opening the file.
		for (const entry of entries) {
			console.log(`appended ${entry.id} ${entry.title}`);
		}
		console.log(`appended ${papersCount(entries.length)} to ${options.file}`);
	} else {
		process.stdout.write(`${digestLine(day, entries)}\n`);
	}
}

async function main(args: string[]) {
	const options = readOptions(args);

	// A file that can't be written fails here, before arXiv is asked, not after with a stack trace.
	if (options.file) {
		checkAppendTarget(options.file);
	}
	const asked = idsToAsk(options);
	const fetched = await fetchPapers(asked.toFetch);
	report("not found on arXiv", fetched.missing);

	// Papers OAI-PMH couldn't give, grouped by what went wrong: what -> its failures, each { id, url, what, lasting }.
	// The same "what" always has the same "lasting", so a group's first failure speaks for all of it.
	const failures = Map.groupBy(fetched.notFetched, (failure) => failure.what);
	const appending = options.file !== null;
	const day = options.date || jakartaToday();
	const checked = entriesToWrite(fetched, options);

	// Nothing to write. Papers OAI-PMH couldn't give are still named, each with what to do next.
	if (checked.entries.length === 0) {
		if (failures.size === 0) {
			fail("no papers left to write");
		}
		for (const [what, group] of failures) {
			console.error(notFetchedLine(what, group, true, appending));
		}
		process.exitCode = 1; // not exit(): it could cut off the lines above
		return;
	}
	writeEntries(options, day, checked.entries);

	// Papers OAI-PMH couldn't give, with the next step.
	for (const [what, group] of failures) {
		console.error(notFetchedLine(what, group, false, appending));
	}

	// The papers that could be fetched are written, but a dropped id is still a failure the caller must see.
	// exitCode, not exit(): exit() could cut off output that is still being written.
	if (
		asked.malformed.length > 0 ||
		fetched.rejected.length > 0 ||
		fetched.missing.length > 0 ||
		fetched.notFetched.length > 0 ||
		checked.incomplete.length > 0 ||
		checked.tooNew.length > 0
	) {
		process.exitCode = 1;
	}
}

// Run only when called as a script, not when imported.
if (import.meta.main) {
	await main(process.argv.slice(2));
}
