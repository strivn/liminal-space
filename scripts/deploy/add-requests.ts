// Handle the connector's add requests in add.yml.
// Usage: node scripts/deploy/add-requests.ts run <digests file> <results file>
//        node scripts/deploy/add-requests.ts report <results file> <push outcome> [<push output file>]
// run reads the queued requests (and any a run that died left running) from <LIMINAL_URL>/api/sync/requests, marks
// each one running, and appends what it asks for with the scout's scripts, which get no token in their environment:
// papers with `arxiv.ts --append <digests file> --ad-hoc -- <ids>`, then figure.ts; DOIs with `proceedings.ts --append
// <digests file> --crossref --ad-hoc -- <ids>`; a paper's metadata with `paper.ts --append <digests file> --ad-hoc
// <metadata file>`, a file for each paper;
// links with `digests.ts add <digests file> <items file> --ad-hoc`, then describe.ts. It reads what each script printed
// to tell, for every id or link, "added", "already there" or "failed" with the reason, and keeps each request's result
// in the results file as it goes. A request is "failed" when nothing in it was added or already there, else "done".
// Request text never reaches a shell: each id is an argument of its own, and links go to the script in a file.
// When $GITHUB_OUTPUT is set, run writes "handled=<n>" and "added=<n>" to it.
// report, after `sync.ts push`, sends each request's status and result to the same address. <push output file> holds
// what push printed: an entry it names refused is reported failed with the site's reason, and the rest of what was
// appended stays added, whatever push's exit code. When that file is missing or push stopped before its last line,
// <push outcome> (the push step's outcome) decides: unless it is "success", everything appended is reported failed.
// Each script gets a time limit and is ended at it: a paper or link whose add (arxiv.ts, digests.ts) was ended is
// "failed", saying it took longer than its time limit; one whose figure or description (figure.ts, describe.ts) was
// ended stays added without it.
// Environment: ACCESS_SYNC_ID and ACCESS_SYNC_SECRET, the sync token as sync.ts sends it; LIMINAL_URL, default
// https://ivan.wiryadi.com/liminal-space; ADD_SCRIPT_TIMEOUT_MS, each script's time limit in milliseconds, default
// 300000 (tests shorten it).
import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isArxivId, normalizeId } from "../../shared/arxiv-id.ts";
import {
	type AddItemResult,
	type AddPayload,
	isDoiId,
	type QueuedAnswer,
	type RequestUpdate,
} from "../../shared/connector-protocol.ts";
import {
	errorCode,
	isJsonObject,
	type JsonObject,
} from "../../shared/narrow.ts";
import { type PaperClaim, paperClaimOf } from "../../shared/paper-claim.ts";
import { requestWithRetry, SyncFailure, siteBase } from "./site-requests.ts";

const USAGE =
	"usage: node scripts/deploy/add-requests.ts run <digests file> <results file> | " +
	"report <results file> <push outcome> [<push output file>]";
// What a request's items say until its scripts have run: a run that stops halfway reports this.
const STOPPED = "the add run stopped before it finished";
// The environment variables holding tokens, kept from the scripts run reads with.
const SECRET_NAMES = [
	"ACCESS_SYNC_ID",
	"ACCESS_SYNC_SECRET",
	"CLOUDFLARE_API_TOKEN",
];

// One queued request as the Worker lists it.
type Queued = QueuedAnswer["requests"][number];

// A request's final status and result, as report sends it.
type Finished = RequestUpdate & {
	result: NonNullable<RequestUpdate["result"]>;
};

// What a script run printed, and how it ended: its exit code, or timedOut when it was stopped at its time limit.
export type ScriptRun = {
	status: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
};

// The time limit of each script a run starts, in milliseconds, from ADD_SCRIPT_TIMEOUT_MS's value: 5 minutes when it
// is unset. Stops with a SyncFailure naming the variable when the value is not a positive whole number.
export function scriptTimeoutMs(value: string | undefined): number {
	if (value === undefined || value === "") {
		return DEFAULT_SCRIPT_TIMEOUT_MS;
	}
	if (!/^[1-9]\d*$/.test(value) || Number(value) > MAX_TIMER_MS) {
		throw new SyncFailure(
			`ADD_SCRIPT_TIMEOUT_MS must be a positive whole number of milliseconds, at most ${MAX_TIMER_MS}`,
		);
	}
	return Number(value);
}

// 5 minutes: figure.ts on 10 papers takes about 150 s, and a request's two scripts at the limit, for each of a run's
// requests that hangs, still leave add.yml's 20 minutes room to report.
const DEFAULT_SCRIPT_TIMEOUT_MS = 300000;
// The longest a timer can run (32 bits): past it Node warns and uses 1 ms.
const MAX_TIMER_MS = 2147483647;

// What a script said about one id or link; reason is set for "failed".
type Outcome = { outcome: AddItemResult["outcome"]; reason?: string };

// The headers that carry the sync token. Stops when it isn't set.
function syncHeaders(): Record<string, string> {
	const clientId = process.env.ACCESS_SYNC_ID;
	const clientSecret = process.env.ACCESS_SYNC_SECRET;
	if (!clientId || !clientSecret) {
		throw new SyncFailure(
			"ACCESS_SYNC_ID and ACCESS_SYNC_SECRET must both be set",
		);
	}
	return {
		"Content-Type": "application/json",
		"CF-Access-Client-Id": clientId,
		"CF-Access-Client-Secret": clientSecret,
	};
}

// The queued requests, oldest first, as the Worker lists them. Stops when the answer isn't that list.
async function fetchQueued(headers: Record<string, string>): Promise<Queued[]> {
	const text = await requestWithRetry(
		`${siteBase()}/api/sync/requests`,
		{ method: "GET", headers: headers, body: null },
		"add-requests",
		"the site",
	);
	let answer: unknown;
	try {
		answer = JSON.parse(text);
	} catch {
		answer = null;
	}
	if (!isJsonObject(answer) || !Array.isArray(answer.requests)) {
		throw new SyncFailure("the site's list of requests can't be read");
	}
	const list: Queued[] = [];
	for (const one of answer.requests) {
		if (
			!isJsonObject(one) ||
			typeof one.id !== "string" ||
			(one.kind !== "papers" && one.kind !== "links") ||
			!isJsonObject(one.payload)
		) {
			throw new SyncFailure("the site's list of requests can't be read");
		}
		list.push({
			id: one.id,
			kind: one.kind,
			payload: one.payload as AddPayload,
		});
	}
	return list;
}

// Send one request's new status, and its result once it has one.
async function sendUpdate(
	headers: Record<string, string>,
	update: RequestUpdate,
): Promise<void> {
	await requestWithRetry(
		`${siteBase()}/api/sync/requests`,
		{ method: "POST", headers: headers, body: JSON.stringify(update) },
		"add-requests",
		"the site",
	);
}

// This process's environment without the tokens: the scripts it runs read pages and arXiv, and need neither the sync
// token nor Cloudflare's.
function scriptEnvironment(): NodeJS.ProcessEnv {
	const kept: NodeJS.ProcessEnv = {};
	for (const name of Object.keys(process.env)) {
		if (!SECRET_NAMES.includes(name)) {
			kept[name] = process.env[name];
		}
	}
	return kept;
}

// Run a script without a shell or token; end it after `timeoutMs`.
export function runScript(
	script: string,
	args: string[],
	timeoutMs: number,
): ScriptRun {
	const path = fileURLToPath(new URL(script, import.meta.url));
	const ran = spawnSync(process.execPath, [path].concat(args), {
		encoding: "utf8",
		env: scriptEnvironment(),
		timeout: timeoutMs,
		killSignal: "SIGKILL",
	});
	process.stdout.write(ran.stdout || "");
	process.stderr.write(ran.stderr || "");
	const timedOut =
		ran.error !== undefined && errorCode(ran.error) === "ETIMEDOUT";
	if (timedOut) {
		console.error(
			`add-requests.ts: ${script.replace("./", "")} took longer than ${timeoutMs} ms and was stopped`,
		);
	}
	return {
		status: ran.status,
		stdout: ran.stdout || "",
		stderr: ran.stderr || "",
		timedOut: timedOut,
	};
}

// The non-empty lines of a script's output.
function linesOf(text: string) {
	return text.split("\n").filter((line) => line.trim() !== "");
}

// Why a script failed for the items it named no outcome for: that it was stopped at its time limit, else the last
// line it printed on stderr that no item claimed.
function leftoverReason(script: string, run: ScriptRun, last: string | null) {
	if (run.timedOut) {
		return `${script} took longer than its time limit and was stopped`;
	}
	if (last !== null) {
		return last;
	}
	return `${script} ended with exit code ${run.status} without naming it`;
}

// What arxiv.ts did with each id it was given, read from its lines, keyed by the id as arxiv.ts names it:
//   appended arxiv:<id> <title>                                   added
//   arxiv.ts: already in <file>, skipped: <id>, <id>              already there
//   arxiv.ts: <problem>: <id>, <id>                               failed, <problem> (not an arXiv id, not found on arXiv, ...)
//   arxiv.ts: not fetched because OAI-PMH <what>: <id> (<url>), ...   failed
// An id it named nowhere failed with the last other line it printed on stderr.
// proceedings.ts --crossref says the same about a DOI, "appended doi:<doi> <title>" and "proceedings.ts: ..." lines, and
// names a DOI it can't give "<problem>: <id>" ("not found on Crossref", "Crossref answered HTTP 503 (<url>)").
// `script` is the script's name, and `idOf` reads an id from the one "appended <id> <title>" prints: the key an id
// was asked for under, or null when it isn't one of this script's.
function paperOutcomes(
	script: string,
	asked: string[],
	run: ScriptRun,
	idOf: (printed: string) => string | null,
) {
	const outcomes = new Map<string, Outcome>();
	for (const line of linesOf(run.stdout)) {
		const appended = line.match(/^appended (\S+) /);
		const id = idOf(appended?.[1] ?? "");
		if (id !== null) {
			outcomes.set(id, { outcome: "added" });
		}
	}
	let last: string | null = null;
	const prefix = `${script}: `;
	for (const line of linesOf(run.stderr)) {
		if (!line.startsWith(prefix)) {
			continue;
		}
		const body = line.slice(prefix.length);
		// The OAI-PMH line names each id with the request that failed for it.
		const oai = "not fetched because OAI-PMH ";
		if (body.startsWith(oai)) {
			const colon = body.indexOf(": ");
			const what = body.slice(oai.length, colon);
			for (const match of body.slice(colon + 2).matchAll(/([^\s,()]+) \(/g)) {
				if (match[1] !== undefined) {
					outcomes.set(match[1], {
						outcome: "failed",
						reason: `not fetched: OAI-PMH ${what}`,
					});
				}
			}
			continue;
		}
		// "<problem>: <id>, <id>", when every name after the last ": " is an id asked for.
		const colon = body.lastIndexOf(": ");
		let named: string[] = [];
		if (colon > 0) {
			named = body.slice(colon + 2).split(", ");
		}
		if (named.length === 0 || !named.every((id) => asked.includes(id))) {
			last = body;
			continue;
		}
		const problem = body.slice(0, colon);
		for (const id of named) {
			if (problem.startsWith("already in ") && problem.endsWith(", skipped")) {
				outcomes.set(id, { outcome: "already there" });
			} else {
				outcomes.set(id, { outcome: "failed", reason: problem });
			}
		}
	}
	return {
		outcomes: outcomes,
		leftover: leftoverReason(script, run, last),
	};
}

// One id's or link's result from what the script said about it. One it named nothing for, or that failed without a
// reason, failed with the script's leftover reason.
function itemResult(
	id: string,
	found: Outcome | undefined,
	leftover: string,
): AddItemResult {
	if (found === undefined) {
		return { id: id, outcome: "failed", reason: leftover };
	}
	if (found.outcome === "failed") {
		return { id: id, outcome: "failed", reason: found.reason || leftover };
	}
	return { id: id, outcome: found.outcome };
}

// The id paper.ts gives a paper's metadata in the digests: "doi:<doi>" in lower case, else "url:<its page>".
function claimEntryId(claim: PaperClaim) {
	if (claim.doi !== undefined) {
		return `doi:${claim.doi.toLowerCase()}`;
	}
	return `url:${claim.url}`;
}

// How a paper's metadata is named in a request's result: its DOI id, else its page's address (as a link is).
function claimId(claim: PaperClaim) {
	if (claim.doi !== undefined) {
		return claimEntryId(claim);
	}
	return claim.url;
}

// The paper metadata a request holds, each as a PaperClaim, or the reasons it isn't one; the Worker checked it before
// queueing it, and it is checked again here because it came from a chat.
function metadataOf(payload: AddPayload): (PaperClaim | string)[] {
	if (!("metadata" in payload) || !Array.isArray(payload.metadata)) {
		return [];
	}
	return payload.metadata.map((paper) => {
		const claim = paperClaimOf(paper);
		if (Array.isArray(claim)) {
			return `not a paper's metadata: ${claim.join("; ")}`;
		}
		return claim;
	});
}

// Append the papers a request gave by their metadata with paper.ts, one run each with the metadata in a file of its
// own (never on the command line): each paper's outcome, under its DOI id or its address.
function handleMetadata(
	file: string,
	metadata: (PaperClaim | string)[],
	folder: string,
	requestId: string,
	timeoutMs: number,
): AddItemResult[] {
	const items: AddItemResult[] = [];
	for (let k = 0; k < metadata.length; k++) {
		const claim = metadata[k];
		if (claim === undefined) {
			continue;
		}
		if (typeof claim === "string") {
			items.push({ id: `paper ${k + 1}`, outcome: "failed", reason: claim });
			continue;
		}
		const claimFile = join(
			folder,
			`${requestId.replace(/[^A-Za-z0-9-]/g, "_")}-paper-${k + 1}.json`,
		);
		writeFileSync(claimFile, JSON.stringify(claim));
		const run = runScript(
			"../scout/web/paper.ts",
			["--append", file, "--ad-hoc", claimFile],
			timeoutMs,
		);
		const entryId = claimEntryId(claim);
		const read = paperOutcomes("paper.ts", [entryId], run, (printed) =>
			printed === entryId ? printed : null,
		);
		const item = itemResult(
			claimId(claim),
			read.outcomes.get(entryId),
			read.leftover,
		);
		// paper.ts says "refused <id>: <each check that failed>"; the id is the item's already.
		if (item.reason?.startsWith(`refused ${entryId}: `)) {
			item.reason = item.reason.slice(`refused ${entryId}: `.length);
		}
		items.push(item);
	}
	return items;
}

// Append a request's papers: arXiv ids with arxiv.ts, then their Figure 1; DOIs with proceedings.ts --crossref; a
// paper's metadata with paper.ts. Each id's outcome is under the id as the request gave it.
function handlePapers(
	file: string,
	given: string[],
	metadata: (PaperClaim | string)[],
	folder: string,
	requestId: string,
	timeoutMs: number,
): AddItemResult[] {
	// An id that is neither never reaches a script's command line (it could read as an option).
	const items: AddItemResult[] = [];
	const ids: string[] = [];
	const dois: string[] = [];
	for (const id of given) {
		const normalized = normalizeId(id);
		if (isArxivId(normalized)) {
			ids.push(normalized);
		} else if (isDoiId(id)) {
			dois.push(id.toLowerCase());
		}
	}
	let outcomes = new Map<string, Outcome>();
	let leftover = "";
	// "--" ends arxiv.ts's options: whatever follows is an id, even one starting with "-".
	if (ids.length > 0) {
		const run = runScript(
			"../scout/arxiv/arxiv.ts",
			["--append", file, "--ad-hoc", "--"].concat(ids),
			timeoutMs,
		);
		const read = paperOutcomes("arxiv.ts", ids, run, (printed) =>
			printed.startsWith("arxiv:") ? printed.slice("arxiv:".length) : null,
		);
		outcomes = read.outcomes;
		leftover = read.leftover;
	}
	let doiOutcomes = new Map<string, Outcome>();
	let doiLeftover = "";
	if (dois.length > 0) {
		const run = runScript(
			"../scout/proceedings/proceedings.ts",
			["--append", file, "--crossref", "--ad-hoc", "--"].concat(dois),
			timeoutMs,
		);
		const read = paperOutcomes("proceedings.ts", dois, run, (printed) =>
			printed.startsWith("doi:") ? printed : null,
		);
		doiOutcomes = read.outcomes;
		doiLeftover = read.leftover;
	}
	const added: string[] = [];
	for (const id of given) {
		const normalized = normalizeId(id);
		if (isArxivId(normalized)) {
			const item = itemResult(id, outcomes.get(normalized), leftover);
			items.push(item);
			if (item.outcome === "added") {
				added.push(normalized);
			}
		} else if (isDoiId(id)) {
			items.push(
				itemResult(id, doiOutcomes.get(id.toLowerCase()), doiLeftover),
			);
		} else {
			const kind = id.startsWith("doi:") ? "a DOI" : "an arXiv id";
			items.push({ id: id, outcome: "failed", reason: `not ${kind}` });
		}
	}
	items.push(...handleMetadata(file, metadata, folder, requestId, timeoutMs));
	// A paper without a Figure 1 is fine; figure.ts names what it couldn't find in the job's log. One it didn't reach
	// before its time limit stays added, without a figure. figure.ts reads arXiv papers only.
	if (added.length > 0) {
		runScript("../scout/arxiv/figure.ts", [file].concat(added), timeoutMs);
	}
	return items;
}

// How digests.ts names a link: its url, else its title in double quotes, else "entry <n>".
function linkNames(link: JsonObject, number: number) {
	const names = [`entry ${number}`];
	if (typeof link.url === "string") {
		names.push(link.url, `url:${link.url}`);
	}
	if (typeof link.id === "string") {
		names.push(link.id);
	}
	if (typeof link.title === "string") {
		names.push(`"${link.title}"`);
	}
	return names;
}

// Record an outcome for the first link `name` names; false when it names none.
function setOutcome(
	outcomes: Map<number, Outcome>,
	links: JsonObject[],
	name: string,
	outcome: Outcome,
) {
	for (let k = 0; k < links.length; k++) {
		const link = links[k];
		if (link !== undefined && linkNames(link, k + 1).includes(name)) {
			outcomes.set(k, outcome);
			return true;
		}
	}
	return false;
}

// What digests.ts add did with each link, read from its lines, by the link's place in the request:
//   added <id> <title>                                            added
//   digests.ts: already in <file>, skipped: <url>                 already there (also "already added in this call")
//   digests.ts: refused <url, "title" or entry n>: <problems>     failed
// A link it named nowhere failed with the last other line it printed on stderr.
function linkOutcomes(links: JsonObject[], run: ScriptRun) {
	const outcomes = new Map<number, Outcome>();
	for (const line of linesOf(run.stdout)) {
		const added = line.match(/^added (\S+)/);
		if (added !== null && added[1] !== undefined) {
			setOutcome(outcomes, links, added[1], { outcome: "added" });
		}
	}
	let last: string | null = null;
	const prefix = "digests.ts: ";
	for (const line of linesOf(run.stderr)) {
		if (!line.startsWith(prefix)) {
			continue;
		}
		const body = line.slice(prefix.length);
		const skipped = body.match(
			/^already (?:in .+|added in this call), skipped: (.+)$/,
		);
		const refused = body.match(/^refused (.+?): (.+)$/);
		let claimed = false;
		if (skipped !== null && skipped[1] !== undefined) {
			claimed = setOutcome(outcomes, links, skipped[1], {
				outcome: "already there",
			});
		} else if (refused !== null && refused[1] !== undefined) {
			claimed = setOutcome(outcomes, links, refused[1], {
				outcome: "failed",
				reason: `refused: ${refused[2]}`,
			});
		}
		if (!claimed && body !== "nothing added") {
			last = body;
		}
	}
	return {
		outcomes: outcomes,
		leftover: leftoverReason("digests.ts", run, last),
	};
}

// Append a request's links, then copy each publisher's description: each link's outcome, under its url.
function handleLinks(
	file: string,
	links: JsonObject[],
	folder: string,
	requestId: string,
	timeoutMs: number,
): AddItemResult[] {
	// The links go to digests.ts in a file, never on its command line.
	const itemsFile = join(
		folder,
		`${requestId.replace(/[^A-Za-z0-9-]/g, "_")}.json`,
	);
	writeFileSync(itemsFile, JSON.stringify(links));
	const run = runScript(
		"../digests/digests.ts",
		["add", file, itemsFile, "--ad-hoc"],
		timeoutMs,
	);
	const read = linkOutcomes(links, run);
	const items: AddItemResult[] = [];
	const added: string[] = [];
	for (let k = 0; k < links.length; k++) {
		const id = linkId(links[k], k);
		const item = itemResult(id, read.outcomes.get(k), read.leftover);
		items.push(item);
		if (item.outcome === "added") {
			added.push(id);
		}
	}
	// No model runs here, so a page without a description keeps none; describe.ts names it in the job's log.
	if (added.length > 0) {
		runScript("../scout/web/describe.ts", [file].concat(added), timeoutMs);
	}
	return items;
}

// How a request's link is named in its result: its url, else "link <n>", counting from 1.
function linkId(link: unknown, index: number) {
	if (isJsonObject(link) && typeof link.url === "string") {
		return link.url;
	}
	return `link ${index + 1}`;
}

// The ids or links a request names, for its result before the scripts have run.
function namesOf(request: Queued): string[] {
	const payload = request.payload;
	if ("papers" in payload && Array.isArray(payload.papers)) {
		const names = payload.papers.map((id) => String(id));
		metadataOf(payload).forEach((claim, k) => {
			names.push(typeof claim === "string" ? `paper ${k + 1}` : claimId(claim));
		});
		return names;
	}
	const names: string[] = [];
	if ("links" in payload && Array.isArray(payload.links)) {
		for (let k = 0; k < payload.links.length; k++) {
			names.push(linkId(payload.links[k], k));
		}
	}
	return names;
}

// A request's status from its items: failed when nothing in it was added or already there.
function statusOf(items: AddItemResult[]): "done" | "failed" {
	if (items.some((item) => item.outcome !== "failed")) {
		return "done";
	}
	return "failed";
}

// Write the results file whole, so a run stopped at any point leaves what it knew.
function saveResults(resultsFile: string, results: Finished[]) {
	writeFileSync(resultsFile, `${JSON.stringify(results, null, "\t")}\n`);
}

// The run command: handle every queued request in turn, oldest first.
async function run(file: string, resultsFile: string) {
	// Read first: a limit that can't be used stops the run before the queue is read, so no request is marked running.
	const timeoutMs = scriptTimeoutMs(process.env.ADD_SCRIPT_TIMEOUT_MS);
	const headers = syncHeaders();
	const requests = await fetchQueued(headers);
	console.log(`${requests.length} queued requests`);
	const folder = mkdtempSync(join(tmpdir(), "liminal-add-"));
	const results: Finished[] = [];
	let added = 0;
	for (const request of requests) {
		// Marked running first, and kept in the results file as stopped until its scripts are done.
		// biome-ignore lint/performance/noAwaitInLoops: requests append to one digests file, one after another
		await sendUpdate(headers, { id: request.id, status: "running" });
		const result: Finished = {
			id: request.id,
			status: "failed",
			result: {
				items: namesOf(request).map((name) => ({
					id: name,
					outcome: "failed",
					reason: STOPPED,
				})),
			},
		};
		results.push(result);
		saveResults(resultsFile, results);

		console.log(`request ${request.id}: ${request.kind}`);
		let items: AddItemResult[];
		if (request.kind === "papers") {
			const payload = request.payload;
			let ids: string[] = [];
			if ("papers" in payload && Array.isArray(payload.papers)) {
				ids = payload.papers.map((id) => String(id));
			}
			items = handlePapers(
				file,
				ids,
				metadataOf(payload),
				folder,
				request.id,
				timeoutMs,
			);
		} else {
			const payload = request.payload;
			let links: JsonObject[] = [];
			if ("links" in payload && Array.isArray(payload.links)) {
				links = payload.links.filter((link) => isJsonObject(link));
			}
			items = handleLinks(file, links, folder, request.id, timeoutMs);
		}
		result.status = statusOf(items);
		result.result.items = items;
		saveResults(resultsFile, results);
		for (const item of items) {
			if (item.outcome === "added") {
				added += 1;
			}
		}
		console.log(`request ${request.id}: ${result.status}`);
	}
	if (process.env.GITHUB_OUTPUT) {
		appendFileSync(
			process.env.GITHUB_OUTPUT,
			`handled=${results.length}\nadded=${added}\n`,
		);
	}
}

// What `sync.ts push` refused, by entry id, from what it printed: its "refused line <n> entry <n> <id>: <problems>"
// lines. null when the output can't be read or holds no last line "added <n>, filled <n>, already there <n>, refused
// <n>": push stopped before the site answered for every entry.
function pushRefusals(outputFile: string | null): Map<string, string> | null {
	if (outputFile === null || !existsSync(outputFile)) {
		return null;
	}
	const lines = linesOf(readFileSync(outputFile, "utf8"));
	const last = lines[lines.length - 1] || "";
	if (!/^added \d+, filled \d+, already there \d+, refused \d+$/.test(last)) {
		return null;
	}
	const refused = new Map<string, string>();
	for (const line of lines) {
		const match = line.match(/^refused line \d+ entry \d+ (\S+): (.+)$/);
		if (match !== null && match[1] !== undefined && match[2] !== undefined) {
			refused.set(match[1], match[2]);
		}
	}
	return refused;
}

// The id an item's entry has in the digests, as push names it: "arxiv:<id>" for an arXiv paper, "doi:<doi>" in lower
// case for a DOI, "url:<url>" for a link or a paper known by its page.
function entryIdOf(item: AddItemResult) {
	const normalized = normalizeId(item.id);
	if (isArxivId(normalized)) {
		return `arxiv:${normalized}`;
	}
	if (isDoiId(item.id)) {
		return item.id.toLowerCase();
	}
	return `url:${item.id}`;
}

// The report command: send every request's status and result. Each is sent even when another fails.
async function report(
	resultsFile: string,
	pushOutcome: string,
	pushOutput: string | null,
) {
	if (!existsSync(resultsFile)) {
		console.log("no requests were handled");
		return;
	}
	const headers = syncHeaders();
	const results: Finished[] = JSON.parse(readFileSync(resultsFile, "utf8"));
	const refusals = pushRefusals(pushOutput);
	for (const result of results) {
		for (const item of result.result.items) {
			if (item.outcome !== "added") {
				continue;
			}
			if (refusals !== null) {
				// Push answered for every entry: one it names refused isn't on the site, the others are.
				const problems = refusals.get(entryIdOf(item));
				if (problems !== undefined) {
					item.outcome = "failed";
					item.reason = `appended, but the site refused it: ${problems}`;
				}
			} else if (pushOutcome !== "success") {
				// Without push's answer, nothing appended is known to have reached the site.
				item.outcome = "failed";
				item.reason = "appended, but the push to the site failed";
			}
		}
		result.status = statusOf(result.result.items);
	}
	const sent = await Promise.allSettled(
		results.map((result) => sendUpdate(headers, result)),
	);
	let failed = 0;
	for (let k = 0; k < sent.length; k++) {
		const outcome = sent[k];
		const result = results[k];
		if (outcome === undefined || result === undefined) {
			continue;
		}
		if (outcome.status === "rejected") {
			failed += 1;
			console.error(
				`add-requests.ts: request ${result.id} not reported: ${String(outcome.reason)}`,
			);
		} else {
			console.log(`reported ${result.id} ${result.status}`);
		}
	}
	if (failed > 0) {
		process.exitCode = 1;
	}
}

// Check the command line, then run or report. A SyncFailure is printed as one line with exit code 1.
async function main(args: string[]) {
	const command = args[0];
	const first = args[1];
	const second = args[2];
	const third = args[3];
	let fits = args.length === 3;
	if (command === "report") {
		fits = args.length === 3 || args.length === 4;
	}
	if (!fits || first === undefined || second === undefined) {
		console.error(USAGE);
		process.exitCode = 1;
		return;
	}
	try {
		if (command === "run") {
			await run(first, second);
		} else if (command === "report") {
			await report(first, second, third || null);
		} else {
			console.error(USAGE);
			process.exitCode = 1;
		}
	} catch (error) {
		if (!(error instanceof SyncFailure)) {
			throw error;
		}
		console.error(`add-requests.ts: ${error.message}`);
		process.exitCode = 1;
	}
}

// Run only when called as a script, not when imported.
if (import.meta.main) {
	await main(process.argv.slice(2));
}
