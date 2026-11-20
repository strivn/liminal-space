// Run the scout's whole search plan in one call and print compact candidate lines: one arXiv search per
// topic over the last 60 days, from the "Search phrases" section of interests.md; every accepted-paper list in its
// "Conferences" section, read whole, with the arXiv id of each title that holds a topic phrase; and each topic's news
// over the last 2 days from Google News, from its line in the "News phrases" section. Hugging Face's most upvoted
// papers join the topic Jev puts them in (scripts/scout/hugging-face/hugging-face.ts). Papers accepted at a conference of those lists come
// first.
// Usage: node scripts/scout/search.ts [--date YYYY-MM-DD] <digests file>
//        node scripts/scout/search.ts <digests file> [--query "<phrases>"] [--author "<name>"]
// --query and --author run an ad-hoc search instead of the plan, for papers asked for in chat: one arXiv search over
// all time in relevance order, for abstracts holding the phrases (written as in "Search phrases") and/or papers by the
// author, at most 25 printed. It reads no interests.md, lists or news, and writes nothing to the cache.
// --date D fills in a day the scout missed (rule in scripts/lib/run-date.ts): the plan runs as if the scout ran at 08:30
// Asia/Jakarta on D. The arXiv window ends on D, a list published after D is left out, and news searches ask for the
// days around D and keep the 48 hours before 08:30 on D.
// A list title arXiv doesn't have is looked for in its conference's proceedings (scripts/scout/proceedings/proceedings.ts): PoPETs, the
// ACL Anthology and AAAI's journal site. A paper found there joins the pool under its "doi:" or "url:" id.
// Environment: ARXIV_API, NEWS_RSS, INTERESTS_FILE, POPETS_BASE, ACL_ANTHOLOGY_BASE, AAAI_OJS_BASE (stand-ins for
// tests), LIMINAL_CACHE (the cache folder); LIMINAL_TODAY (YYYY-MM-DD) is taken as today in Asia/Jakarta,
// ARXIV_RETRY_MINUTE_MS as the length of a minute between arXiv retries, ARXIV_PAUSE_MS as the pause between arXiv
// requests (scripts/scout/arxiv/arxiv.ts) and PROCEEDINGS_PAUSE_MS as the pause between requests to the proceedings sites, tests
// only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isArxivId, normalizeId } from "../../shared/arxiv-id.ts";
import { errorCode } from "../../shared/narrow.ts";
import { idsInText, readDigestsText } from "../digests/digests-file.ts";
import { type Fail, failer, REPO } from "../lib/cli.ts";
import {
	daysBefore,
	jakartaToday,
	runDateProblem,
	takeDateOption,
} from "../lib/run-date.ts";
import { arxivRequest, whatHappened } from "./arxiv/api.ts";
import type { Lookup, ReadList, Run } from "./arxiv/search.ts";
import { listLines, lookUpTitles, readCandidates } from "./arxiv/search.ts";
import type { HuggingFacePaper } from "./hugging-face/hugging-face.ts";
import { huggingFacePapers } from "./hugging-face/hugging-face.ts";
import { searchNews } from "./news/news.ts";
import type { ConferenceList, Topic } from "./plan/interests.ts";
import {
	conferenceLists,
	newsPhrases,
	phrasesQuery,
	searchPhrases,
} from "./plan/interests.ts";
import { readKept, writeKept } from "./plan/kept.ts";
import type { Pool, TopicResult } from "./plan/pool.ts";
import {
	addHuggingFaceToPool,
	addListedToPool,
	candidateLines,
	keepScores,
	outputText,
	prunePool,
	readPool,
	writePool,
} from "./plan/pool.ts";
import { splitParts } from "./plan/title-match.ts";
import {
	fillAbstracts,
	keptStrings,
	keptTopic,
	keptTopics,
	SEARCH_DAYS,
	searchTopic,
	topicCandidates,
} from "./plan/topic-search.ts";
import type { ProceedingsAnswer } from "./proceedings/lookup.ts";
import {
	addProceedingsToPool,
	lookUpProceedings,
} from "./proceedings/lookup.ts";
import { matchingPapers, readLists } from "./proceedings/venue-lists.ts";

const fail: Fail = failer("search.ts");

const USAGE =
	'usage: node scripts/scout/search.ts [--date YYYY-MM-DD] <digests file>, or node scripts/scout/search.ts <digests file> --cached, or node scripts/scout/search.ts <digests file> [--query "<phrases>"] [--author "<name>"]';
// The plan's printed text, kept in the cache folder for --cached: { day, at, text, failed, topics, rest, venues },
// failed being whether a source failed (the run's exit code), so a replay exits the same way. topics holds each
// topic's counts without its candidates, rest the list and news lines, and venues the venues of interests.md's lists:
// a replay rebuilds the topic lines from the pool as score.ts left it (keptTopics). The scout's own search then
// prints the morning fill step's output instead of asking arXiv, the lists, Hugging Face and Google News again.
const OUTPUT_FILE = "output.json";
const INTERESTS_FILE = process.env.INTERESTS_FILE || join(REPO, "interests.md");

// How much is read and printed. The caps keep the whole output under Claude Code's 30,000-character inline limit.
const ADHOC_LINES = 25;

// Every paper id in the digests file: arXiv ids without "arxiv:", versions ignored, and "doi:" and "url:" ids as
// written; none when the file doesn't exist yet.
function digestIds(file: string): Set<string> {
	let text: string;
	try {
		text = readDigestsText(file);
	} catch (error) {
		fail(`can't read ${file} (${errorCode(error)})`);
	}
	const ids = idsInText(text);
	return new Set([...ids.arxiv, ...ids.other]);
}

// Hugging Face's papers for the run's day, read once that day: huggingface.json keeps them with the day they were read
// for and the day they were read on, so the scout's own search, after the fill step, reuses them. A failed list is
// named and adds nothing; the pool keeps the papers of earlier runs.
async function readHuggingFace(day: string, today: string, run: Run) {
	const kept = readKept("huggingface.json");
	if (kept.day === day && kept.readOn === today && Array.isArray(kept.papers)) {
		// Read as this function wrote them, unchecked.
		return kept.papers as HuggingFacePaper[];
	}
	const days = [];
	for (let back = 6; back >= 0; back--) {
		days.push(daysBefore(day, back));
	}
	const answer = await huggingFacePapers(days, day === today);
	if ("problem" in answer) {
		console.error(`search.ts: Hugging Face ${answer.problem}`);
		run.failed = true;
		return [];
	}
	writeKept("huggingface.json", {
		day: day,
		readOn: today,
		papers: answer.papers,
	});
	return answer.papers;
}

// An --author name as arXiv's au: field finds it: accents taken off ("Schölkopf" -> "Scholkopf"). NFD splits each
// accented letter into its letter and a combining mark (\p{M}), which is then dropped.
function withoutAccents(name: string) {
	return name.normalize("NFD").replace(/\p{M}/gu, "");
}

// The ad-hoc query: --query phrases, comma-separated as in "Search phrases", searched in abstracts; an --author name in
// au:; both together as au:"<name>" AND (<phrases>). No submittedDate: the search covers all time.
function adhocQuery(query: string | null, author: string | null): string {
	let phrases = "";
	if (query !== null) {
		phrases = phrasesQuery(splitParts(query, ","));
	}
	if (author === null) {
		return phrases;
	}
	const name = `au:"${withoutAccents(author.trim())}"`;
	if (query === null) {
		return name;
	}
	return `${name} AND (${phrases})`;
}

// The ad-hoc search: one arXiv search for --query phrases and/or an --author name, over all time, in relevance order,
// printing its candidate lines. Reads no interests.md, lists or news; writes nothing to the cache.
async function adhocSearch(
	digestsFile: string,
	query: string | null,
	author: string | null,
): Promise<void> {
	// The header names what was asked, as given: query "<phrases>", author "<name>", or both, query first.
	const asked = [];
	if (query !== null) {
		asked.push(`query "${query}"`);
	}
	if (author !== null) {
		asked.push(`author "${author}"`);
	}
	const label = asked.join(", ");
	const read = await readCandidates(
		adhocQuery(query, author),
		"relevance",
		ADHOC_LINES,
		digestIds(digestsFile),
		arxivRequest,
	);
	const answer = read.stoppedBy;
	if (answer !== null) {
		// There is no fallback for a search (OAI-PMH fetches papers by id), so the only advice is to wait.
		if (answer.status === 400) {
			console.error(`search.ts: arXiv rejected the query (${answer.url})`);
		} else {
			console.error(
				`search.ts: arXiv ${whatHappened(answer, "an arXiv feed")} (${answer.url}); try again in a few minutes`,
			);
		}
		process.exitCode = 1;
		if (read.found === null) {
			return;
		}
	}
	const lines = candidateLines(
		label,
		read.found || 0,
		read.alreadyIn,
		read.unused,
		ADHOC_LINES,
	);
	process.stdout.write(`${lines.join("\n")}\n`);
}

// An ad-hoc search's arguments: one digests file, and --query and/or --author, each once, with a value that isn't blank
// (a --query of only commas counts as blank). null when they can't be used, including with --date, which only the
// plan takes.
function adhocArgs(args: string[]) {
	let query: string | null = null;
	let author: string | null = null;
	const rest: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === undefined) {
			continue;
		}
		if (arg === "--date" || arg.startsWith("--date=")) {
			return null;
		}
		if (arg !== "--query" && arg !== "--author") {
			rest.push(arg);
			continue;
		}
		i += 1;
		const value = args[i];
		if (value === undefined || value.trim() === "") {
			return null;
		}
		if (arg === "--query") {
			if (query !== null || splitParts(value, ",").length === 0) {
				return null;
			}
			query = value;
		} else {
			if (author !== null) {
				return null;
			}
			author = value;
		}
	}
	const digestsFile = rest[0];
	if (rest.length !== 1 || digestsFile === undefined) {
		return null;
	}
	return { digestsFile: digestsFile, query: query, author: author };
}

// The kept text without the candidate lines whose paper is now in the digests (a paper added since the plan ran, by
// the scout's earlier step or ad hoc). A candidate line starts "<YYYY-MM-DD> <id> " where the id is an arXiv id or a
// "doi:"/"url:" id (candidateLine); a news line starts with a date too, but its second word is a source, which no
// digest id equals. Headers keep the morning's counts. The text's trailing newline is kept.
export function withoutDigested(text: string, inDigests: Set<string>): string {
	const lines = text.split("\n").filter((line) => {
		const match = line.match(/^\d{4}-\d{2}-\d{2} (\S+) /);
		if (match === null) {
			return true;
		}
		const id = match[1] || "";
		if (id.startsWith("doi:") || id.startsWith("url:")) {
			return !inDigests.has(id);
		}
		// isArxivId reads a normalized id: the version, which digestIds leaves out, goes first.
		const paper = normalizeId(id);
		return !(isArxivId(paper) && inDigests.has(paper));
	});
	return lines.join("\n");
}

async function main(args: string[]): Promise<void> {
	// News ages are measured from here: lookups can take minutes before the news is read.
	const startedAt = Date.now();
	// --query or --author asks for an ad-hoc search instead of the plan; arguments it can't use stop here, before any
	// request.
	if (args.includes("--query") || args.includes("--author")) {
		const adhoc = adhocArgs(args);
		if (adhoc === null) {
			console.error(USAGE);
			process.exit(1);
		}
		await adhocSearch(adhoc.digestsFile, adhoc.query, adhoc.author);
		return;
	}
	const plan = planRequest(args, startedAt);
	if (plan.cached && printKept(plan.digestsFile, plan.today)) {
		return;
	}
	await runPlan(plan);
}

type Plan = ReturnType<typeof planRequest>;

// What the plan was asked: whether to replay the kept output, the digests file, the real day, the run's day and --date
// (null without one), and the moment the news ages are measured from. Arguments it can't use stop here, before any
// request.
function planRequest(args: string[], startedAt: number) {
	let runStart = startedAt;
	// --cached asks for the output kept today instead of a run. It is taken out first, so the digests file is still the
	// one argument left; with --date it is refused, since a kept output is today's, not D's.
	const cached = args.includes("--cached");
	const plain = args.filter((arg) => arg !== "--cached");
	// The digests file is the one argument left besides --date.
	const parsed = takeDateOption(plain);
	let digestsFile: string | undefined;
	if (parsed !== null && parsed.rest.length === 1) {
		digestsFile = parsed.rest[0];
	}
	if (
		parsed === null ||
		digestsFile === undefined ||
		(cached && parsed.date !== null)
	) {
		console.error(USAGE);
		process.exit(1);
	}
	// A --date that can't be filled in stops here, before any request. With one, the run moment is 08:30 on that day
	// in Asia/Jakarta (UTC+7 all year), the scout's scheduled time.
	// `today` stays the real day: kept answers and list copies are dated by when they were asked.
	const today = jakartaToday();
	const date = parsed.date;
	let day = today;
	if (date !== null) {
		const problem = runDateProblem(date, today);
		if (problem !== null) {
			fail(problem);
		}
		day = date;
		runStart = Date.parse(`${date}T08:30:00+07:00`);
	}
	return {
		cached: cached,
		digestsFile: digestsFile,
		today: today,
		day: day,
		date: date,
		runStart: runStart,
	};
}

// --cached: the output kept today is printed and nothing is asked; a run says so on stderr, with when the kept run
// was. The topic lines are rebuilt from the pool as it is now, so Jev's scores given since the kept run order them,
// as a plan run after the scoring would; the counts, list and news lines are the kept run's. Without a kept output
// (none, yesterday's, one of the wrong shape, or a file that doesn't load, which readKept names), this prints
// nothing and says so by returning false, and the plan runs and keeps its output.
function printKept(digestsFile: string, today: string): boolean {
	const kept = readKept(OUTPUT_FILE);
	const results = keptTopics(kept.topics);
	const rest = keptStrings(kept.rest);
	const venues = keptStrings(kept.venues);
	if (
		kept.day === today &&
		results !== null &&
		rest !== null &&
		venues !== null
	) {
		console.error(`search.ts: printed from the run kept at ${kept.at}`);
		// A kept run that named a failure replays with its exit code, so "a non-zero exit means a source failed" still
		// holds; a kept file without the field (older) counts as not failed.
		if (kept.failed === true) {
			console.error(
				"search.ts: the kept run named a failure; see the fill step's log",
			);
			process.exitCode = 1;
		}
		const pool = readPool();
		for (const result of results) {
			topicCandidates(result, pool, today, venues);
		}
		process.stdout.write(
			withoutDigested(outputText(results, rest), digestIds(digestsFile)),
		);
		return true;
	}
	return false;
}

// interests.md's markdown and its search topics. Everything that can stop the run is checked before the first request.
function readInterests() {
	let markdown: string;
	try {
		markdown = readFileSync(INTERESTS_FILE, "utf8");
	} catch (error) {
		fail(`can't read ${INTERESTS_FILE} (${errorCode(error)})`);
	}
	const topics = searchPhrases(markdown);
	if (topics === null) {
		fail(`${INTERESTS_FILE} has no "Search phrases" section`);
	}
	// A section of prose only, or of topic lines without phrases, leaves nothing to search.
	if (topics.length === 0) {
		fail('the "Search phrases" section in interests.md has no topic lines');
	}
	return { markdown: markdown, topics: topics };
}

// The conference lists that were out on --date (all of them without one), and a line naming each that wasn't.
function listsOnTime(markdown: string, date: string | null) {
	// With --date, a list published after that day wasn't out yet: it is left out, and named.
	const lists: ConferenceList[] = [];
	const notYetOut: string[] = [];
	for (const list of conferenceLists(markdown)) {
		if (date !== null && list.published !== null && list.published > date) {
			notYetOut.push(
				`${list.venue} list published on ${list.published}, after ${date}: left out`,
			);
		} else {
			lists.push(list);
		}
	}
	return { lists: lists, notYetOut: notYetOut };
}

// Search arXiv for each topic into the pool, which first drops what the window or the digests now leave out.
async function searchTopics(
	topics: Topic[],
	day: string,
	inDigests: Set<string>,
) {
	// The window is the 60 days ending on the run's day in Asia/Jakarta, written YYYYMMDD as arXiv's submittedDate wants it.
	const start = daysBefore(day, SEARCH_DAYS).replaceAll("-", "");
	const end = day.replaceAll("-", "");

	// failed: some source failed, so the exit code is 1; arxivStopped: an arXiv request failed, so none follow.
	const run: Run = { failed: false, arxivStopped: false };
	// The pool, without what the window or the digests now leave out; the topic searches add to it.
	const pool = readPool();
	// The scores of papers now on the page, kept for bringing unread papers back later, before the pool drops them.
	const scores = readKept("scores.json");
	const scoresBefore = JSON.stringify(scores);
	keepScores(pool, inDigests, scores);
	if (JSON.stringify(scores) !== scoresBefore) {
		writeKept("scores.json", scores);
	}
	prunePool(pool, inDigests, day);
	const results: TopicResult[] = [];
	for (const topic of topics) {
		results.push(
			// biome-ignore lint/performance/noAwaitInLoops: arXiv asks for one request at a time; each topic's search waits for the one before
			await searchTopic(topic, start, end, day, inDigests, pool, run),
		);
	}
	return { run: run, pool: pool, results: results };
}

// What the conference lists gave: each list as read, the arXiv lookups of its titles, and how many titles wait.
type Listed = {
	read: ReadList[];
	lookups: Record<string, Lookup>;
	waiting: Set<string>;
};

// Read the conference lists, look the titles up on arXiv and in their proceedings, and add the papers of the lists and
// of Hugging Face to the pool.
async function addListsToPool(
	lists: ConferenceList[],
	topics: Topic[],
	pool: Pool,
	inDigests: Set<string>,
	plan: Plan,
	run: Run,
): Promise<Listed> {
	const { day, today } = plan;
	// Conference lists: read every list, then look up the arXiv ids of the titles that hold a topic phrase.
	const keptLists = readKept("lists.json");
	const read = await readLists(lists, keptLists, today, run);
	if (lists.length > 0) {
		writeKept("lists.json", keptLists);
	}
	for (const list of read) {
		list.matching = matchingPapers(list.titles, topics);
	}
	// lookups.json is written by lookUp: its answers are read as lookUp wrote them, unchecked.
	const lookups = readKept("lookups.json") as Record<string, Lookup>;
	const lookedUp = await lookUpTitles(read, lookups, today, run);
	// Found papers kept without an abstract get one, so list papers can join the pool and be scored.
	await fillAbstracts(lookups, run);
	writeKept("lookups.json", lookups);
	// Papers not on arXiv are looked for in their proceedings; proceedings.json is written only when it learned something.
	const keptProceedings = readKept("proceedings.json") as Record<
		string,
		ProceedingsAnswer
	>;
	if (await lookUpProceedings(read, lookups, keptProceedings, today, run)) {
		writeKept("proceedings.json", keptProceedings);
	}
	addListedToPool(pool, read, lookups, topics, inDigests, day);
	addProceedingsToPool(pool, read, keptProceedings, topics, inDigests, day);
	// Hugging Face's most upvoted papers join the pool; Jev's topic places them (topicCandidates).
	addHuggingFaceToPool(
		pool,
		await readHuggingFace(day, today, run),
		inDigests,
		day,
	);
	return { read: read, lookups: lookups, waiting: lookedUp.waiting };
}

// The plan's lines after the topics: the lists left out, each list's lines, how many titles wait, and the news.
async function listAndNewsLines(
	listed: Listed,
	notYetOut: string[],
	interests: { markdown: string; topics: Topic[] },
	inDigests: Set<string>,
	plan: Plan,
	run: Run,
) {
	const output: string[] = [];
	for (const line of notYetOut) {
		output.push(line);
	}
	for (const list of listed.read) {
		for (const line of listLines(
			list,
			listed.lookups,
			listed.waiting,
			inDigests,
			run,
		)) {
			output.push(line);
		}
	}
	output.push(`titles still to look up: ${listed.waiting.size}`);

	// Each topic's news phrases; a topic without a line, or a file without the section, falls back to its search phrases.
	const news = newsPhrases(interests.markdown) || [];
	for (const topic of interests.topics) {
		const own = news.find((entry) => entry.topic === topic.topic);
		for (const line of await searchNews(
			topic,
			own,
			plan.runStart,
			plan.date,
			run,
		)) {
			output.push(line);
		}
	}
	return output;
}

// Print the plan's text and keep it for --cached; the run exits 1 when a source failed.
function printPlan(
	results: TopicResult[],
	output: string[],
	venues: string[],
	plan: Plan,
	run: Run,
) {
	const text = outputText(results, output);
	process.stdout.write(text);
	// Kept for --cached after a plain run only: with --date the text is D's, not today's.
	if (plan.date === null) {
		writeKept(OUTPUT_FILE, {
			day: plan.today,
			at: new Date().toISOString(),
			text: text,
			failed: run.failed,
			topics: results.map(keptTopic),
			rest: output,
			venues: venues,
		});
	}
	// exitCode, not exit(): exit() could cut off output that is still being written.
	if (run.failed) {
		process.exitCode = 1;
	}
}

// The plan: search every topic, read the conference lists and Hugging Face into the pool, then print the candidates.
async function runPlan(plan: Plan) {
	const interests = readInterests();
	const { lists, notYetOut } = listsOnTime(interests.markdown, plan.date);
	const inDigests = digestIds(plan.digestsFile);
	const { run, pool, results } = await searchTopics(
		interests.topics,
		plan.day,
		inDigests,
	);
	const listed = await addListsToPool(
		lists,
		interests.topics,
		pool,
		inDigests,
		plan,
		run,
	);
	const venues = lists.map((list) => list.venue);
	for (const result of results) {
		topicCandidates(result, pool, plan.day, venues);
	}
	writePool(pool);
	const output = await listAndNewsLines(
		listed,
		notYetOut,
		interests,
		inDigests,
		plan,
		run,
	);
	printPlan(results, output, venues, plan, run);
}

// Run only when called as a script, not when imported.
if (import.meta.main) {
	await main(process.argv.slice(2));
}
