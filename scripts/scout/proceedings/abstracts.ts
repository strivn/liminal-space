// Fill in Semantic Scholar's abstract for the day's DOI papers that came without one (Crossref has none for Elsevier's
// and Springer Nature's papers). Runs after the scout, whose commands never see the key.
// Usage: node scripts/scout/proceedings/abstracts.ts <digests file> [--date YYYY-MM-DD]
// Environment: SEMANTIC_SCHOLAR_API_KEY; SEMANTIC_SCHOLAR_PAUSE_MS (tests only). A paper that gets no abstract is
// named; a missing key or a failed request also makes the exit code 1.
import { setTimeout as sleep } from "node:timers/promises";
import { isJsonObject, type JsonObject } from "../../../shared/narrow.ts";
import { readDigests, writeChangedLines } from "../../digests/digests-file.ts";
import { type Fail, failer } from "../../lib/cli.ts";
import CONSTANTS from "../../lib/constants.json" with { type: "json" };
import {
	jakartaToday,
	runDateProblem,
	takeDateOption,
} from "../../lib/run-date.ts";
import { semanticScholarAbstract } from "./semantic-scholar.ts";

const fail: Fail = failer("abstracts.ts");

const USAGE =
	"usage: node scripts/scout/proceedings/abstracts.ts <digests file> [--date YYYY-MM-DD]";
// Time between requests; a key allows one a second.
const PAUSE_MS = Number(
	process.env.SEMANTIC_SCHOLAR_PAUSE_MS || CONSTANTS.burstDelayMs,
);

// A DOI paper with no abstract.
function lacksAbstract(entry: unknown): entry is JsonObject {
	return (
		isJsonObject(entry) &&
		entry.type === "paper" &&
		typeof entry.id === "string" &&
		entry.id.startsWith("doi:") &&
		(typeof entry.abstract !== "string" || entry.abstract === "")
	);
}

async function main(args: string[]) {
	const parsed = takeDateOption(args);
	const file = parsed?.rest[0];
	if (parsed === null || file === undefined || parsed.rest.length !== 1) {
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

	const read = readDigests(file, (line, problem) =>
		fail(`line ${line} of ${file} ${problem}`),
	);
	const wanted: { index: number; entry: JsonObject }[] = [];
	for (const { index, digest } of read.digests) {
		if (!isJsonObject(digest) || digest.date !== day) {
			continue;
		}
		for (const entry of Array.isArray(digest.entries) ? digest.entries : []) {
			if (lacksAbstract(entry)) {
				wanted.push({ index: index, entry: entry });
			}
		}
	}
	if (wanted.length === 0) {
		console.log(`no DOI paper of ${day} lacks an abstract`);
		return;
	}
	const key = process.env.SEMANTIC_SCHOLAR_API_KEY;
	if (!key) {
		const ids = wanted.map(({ entry }) => entry.id).join(", ");
		console.error(
			`abstracts.ts: SEMANTIC_SCHOLAR_API_KEY is not set; no abstract asked for ${ids}`,
		);
		process.exitCode = 1;
		return;
	}

	const changed = new Set<number>();
	for (const [k, { index, entry }] of wanted.entries()) {
		if (k > 0) {
			// biome-ignore lint/performance/noAwaitInLoops: one request a second, as the key allows
			await sleep(PAUSE_MS);
		}
		const id = String(entry.id);
		const answer = await semanticScholarAbstract(id.slice("doi:".length), key);
		if ("abstract" in answer) {
			entry.abstract = answer.abstract;
			changed.add(index);
		} else if ("problem" in answer) {
			console.error(`abstracts.ts: Semantic Scholar ${answer.problem}: ${id}`);
			process.exitCode = 1;
		} else if (answer.missing === "not found") {
			console.error(`abstracts.ts: Semantic Scholar doesn't know ${id}`);
		} else {
			console.error(`abstracts.ts: Semantic Scholar has no abstract for ${id}`);
		}
	}
	if (changed.size > 0) {
		writeChangedLines(file, read, changed, (real, code) =>
			fail(`can't write ${real} (${code})`),
		);
	}
	let added = 0;
	for (const { entry } of wanted) {
		if (typeof entry.abstract === "string") {
			added += 1;
		}
	}
	let noun = "abstracts";
	if (added === 1) {
		noun = "abstract";
	}
	console.log(`added ${added} ${noun} to ${file}`);
}

// Run only when called as a script, not when imported.
if (import.meta.main) {
	await main(process.argv.slice(2));
}
