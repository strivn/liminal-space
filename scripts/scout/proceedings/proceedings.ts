// Accepted papers that are not on arXiv, read from their conference's own proceedings: PoPETs for PETS, the ACL
// Anthology for ACL and ACL Findings, and AAAI's journal site for AIES. scripts/scout/search.ts finds them and keeps them in
// the cache's proceedings.json; this script appends the ones the scout picks to the digests file.
// With --crossref it appends journal papers instead, each read from its DOI's record on Crossref.
// Usage: node scripts/scout/proceedings/proceedings.ts --append <digests file> [--date YYYY-MM-DD] [--crossref]
//        [--pick surprise --pick-source <url>] <id> [<id> ...]
// An id is "doi:<doi>", or "url:<paper page>" for a paper whose page names no DOI, as search.ts prints it; with
// --crossref, only "doi:<doi>".
// --date D fills in a day the scout missed: the line is dated D (rule in scripts/lib/run-date.ts).
// Environment: POPETS_BASE, ACL_ANTHOLOGY_BASE, AAAI_OJS_BASE, CROSSREF_API (stand-ins for tests), LIMINAL_CACHE
// (the cache folder); LIMINAL_TODAY (YYYY-MM-DD) is taken as today in Asia/Jakarta, tests only.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { errorCode, isJsonObject } from "../../../shared/narrow.ts";
import { appendDigestLine, idsInText } from "../../digests/digests-file.ts";
import { cacheFolder, type Fail, failer } from "../../lib/cli.ts";
import {
	jakartaToday,
	runDateProblem,
	takeDateOption,
} from "../../lib/run-date.ts";
import {
	crossrefPaper,
	type ProceedingsPaper,
	proceedingsEntry,
	publishedAfter,
} from "./sites.ts";

const fail: Fail = failer("proceedings.ts");

const USAGE =
	"usage: node scripts/scout/proceedings/proceedings.ts --append <digests file> [--date YYYY-MM-DD] [--crossref] " +
	"[--pick surprise --pick-source <url>] <id> [<id> ...]";

// The cache folder search.ts keeps proceedings.json in.
const CACHE = cacheFolder();

// The papers proceedings.json keeps, by id; none when search.ts hasn't written it, or it doesn't load.
function keptPapers(): Map<string, ProceedingsPaper> {
	const papers = new Map<string, ProceedingsPaper>();
	const file = join(CACHE, "proceedings.json");
	if (!existsSync(file)) {
		return papers;
	}
	let kept: unknown;
	try {
		kept = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		fail(`${file} doesn't load`);
	}
	if (!isJsonObject(kept)) {
		fail(`${file} doesn't load`);
	}
	// Each answer is read as search.ts wrote it: { paper, checked }, the paper null for a title not found.
	for (const answer of Object.values(kept)) {
		if (isJsonObject(answer) && isJsonObject(answer.paper)) {
			const paper = answer.paper as ProceedingsPaper;
			papers.set(paper.id, paper);
		}
	}
	return papers;
}

// The command line after "--append <file>": --crossref, --pick and --pick-source, and the ids; null when parseArgs
// refuses it.
function readOptions(args: string[]) {
	try {
		return parseArgs({
			args: args,
			options: {
				crossref: { type: "boolean" },
				pick: { type: "string" },
				"pick-source": { type: "string" },
			},
			allowPositionals: true,
			strict: true,
		});
	} catch {
		return null;
	}
}

// Name the ids a check dropped, on one line, and make the run fail: "proceedings.ts: not found on Crossref: doi:...".
function report(problem: string, ids: string[]) {
	if (ids.length > 0) {
		console.error(`proceedings.ts: ${problem}: ${ids.join(", ")}`);
		process.exitCode = 1;
	}
}

// The entries for the ids not yet in the digests, read from Crossref one at a time; each DOI it can't give is named.
// A paper published after `day` couldn't have been in that day's digest: it is named and left out.
async function crossrefEntries(ids: string[], day: string) {
	const entries: Record<string, unknown>[] = [];
	const notFound: string[] = [];
	const incomplete: string[] = [];
	for (const id of ids) {
		// biome-ignore lint/performance/noAwaitInLoops: one request at a time keeps Crossref's service light
		const answer = await crossrefPaper(id.slice("doi:".length));
		if ("problem" in answer) {
			console.error(`proceedings.ts: Crossref ${answer.problem}: ${id}`);
			process.exitCode = 1;
		} else if ("missing" in answer && answer.missing === "not found") {
			notFound.push(id);
		} else if ("missing" in answer) {
			incomplete.push(id);
		} else if (
			answer.published !== null &&
			publishedAfter(answer.published, day)
		) {
			console.error(
				`proceedings.ts: ${id} was published on ${answer.published}, after ${day}`,
			);
			process.exitCode = 1;
		} else {
			entries.push(answer.entry);
		}
	}
	report("not found on Crossref", notFound);
	report("incomplete on Crossref, missing its title or authors", incomplete);
	return entries;
}

async function main(args: string[]): Promise<void> {
	const request = readRequest(args);
	const entries = await entriesToAppend(request);
	if (entries.length === 0) {
		fail("no papers left to write");
	}
	appendEntries(request, entries);
}

type Request = ReturnType<typeof readRequest>;

// The command line as a request: the digests file, the day, --crossref, the surprise pick and its source, and the ids
// (DOIs in lower case with --crossref); stops on anything else.
function readRequest(args: string[]) {
	// "--append <file>", then the options and ids; --date may come anywhere.
	const parsed = takeDateOption(args);
	if (parsed === null || parsed.rest[0] !== "--append") {
		fail(USAGE);
	}
	const file = parsed.rest[1];
	const options = readOptions(parsed.rest.slice(2));
	if (file === undefined || options === null) {
		fail(USAGE);
	}
	const crossref = options.values.crossref === true;
	const pick = options.values.pick;
	const pickSource = options.values["pick-source"];
	// pick_source says where the surprise paper was found, so it needs a surprise paper, and a web address.
	if (pick !== undefined && pick !== "surprise") {
		fail('--pick accepts only "surprise"');
	}
	if (pickSource !== undefined && pick === undefined) {
		fail("--pick-source needs --pick surprise");
	}
	if (pickSource !== undefined && !/^https?:\/\/[^\s/]+/.test(pickSource)) {
		fail(`--pick-source must be an http or https URL, got "${pickSource}"`);
	}
	// DOIs are the same in any case; Crossref writes them in lower case, and so does the digests file.
	let ids = [...new Set(options.positionals)];
	if (crossref) {
		ids = [...new Set(ids.map((id) => id.toLowerCase()))];
		const notDoi = ids.filter((id) => !/^doi:10\.\S+\/\S+$/.test(id));
		if (notDoi.length > 0) {
			fail(`--crossref takes only "doi:<doi>" ids, got ${notDoi.join(", ")}`);
		}
	}
	if (ids.length === 0) {
		fail(USAGE);
	}
	const today = jakartaToday();
	let day = today;
	if (parsed.date !== null) {
		const problem = runDateProblem(parsed.date, today);
		if (problem !== null) {
			fail(problem);
		}
		day = parsed.date;
	}
	return {
		file: file,
		day: day,
		crossref: crossref,
		pick: pick,
		pickSource: pickSource,
		ids: ids,
	};
}

// The entries for the ids the digests don't hold yet: read from Crossref, or from the papers search.ts kept.
async function entriesToAppend(request: Request) {
	const { file, day, crossref, ids } = request;
	let existing = new Set<string>();
	if (existsSync(file)) {
		existing = idsInText(readFileSync(file, "utf8")).other;
	}
	// A DOI in the digests written in another case is the same paper.
	if (crossref) {
		existing = new Set([...existing].map((id) => id.toLowerCase()));
	}
	const already = ids.filter((id) => existing.has(id));
	if (already.length > 0) {
		console.error(
			`proceedings.ts: already in ${file}, skipped: ${already.join(", ")}`,
		);
	}
	const wanted = ids.filter((id) => !existing.has(id));

	let entries: Record<string, unknown>[] = [];
	if (crossref) {
		entries = await crossrefEntries(wanted, day);
	} else {
		const kept = keptPapers();
		report(
			"not found in the proceedings search.ts read",
			wanted.filter((id) => !kept.has(id)),
		);
		for (const id of wanted) {
			const paper = kept.get(id);
			if (paper !== undefined) {
				entries.push(proceedingsEntry(paper));
			}
		}
	}
	return entries;
}

// Append the entries to the digests file, with the surprise mark when there is one, and name each paper that landed.
function appendEntries(request: Request, entries: Record<string, unknown>[]) {
	const { file, day, pick, pickSource } = request;
	// The surprise mark and where it was found go after the paper's own fields.
	for (const entry of entries) {
		if (pick !== undefined) {
			entry.pick = pick;
		}
		if (pickSource !== undefined) {
			entry.pick_source = pickSource;
		}
	}

	try {
		appendDigestLine(file, day, entries);
	} catch (error) {
		fail(`can't append to ${file} (${errorCode(error)})`);
	}
	for (const entry of entries) {
		console.log(`appended ${entry.id} ${entry.title}`);
	}
	let count = `${entries.length} papers`;
	if (entries.length === 1) {
		count = "1 paper";
	}
	console.log(`appended ${count} to ${file}`);
}

// Run only when called as a script, not when imported.
if (import.meta.main) {
	await main(process.argv.slice(2));
}
