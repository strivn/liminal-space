// Add OpenAlex topics to papers.
// Usage: node scripts/scout/openalex/topics.ts <digests file> [--all]
// Papers added in the last 30 days, or every paper with --all. A paper OpenAlex has not classified, or whose title
// differs, is left as it is. Any OpenAlex failure leaves the file unchanged and exits 1.
// Environment: OPENALEX_API, OPENALEX_PAUSE_MS and OPENALEX_TIMEOUT_MS (stand-ins for tests).
import { setTimeout as sleep } from "node:timers/promises";
import { isArxivId, normalizeId } from "../../../shared/arxiv-id.ts";
import { isJsonObject, type JsonObject } from "../../../shared/narrow.ts";
import {
	type EntryOpenAlex,
	OPENALEX_CAPS,
	type OpenAlexTopic,
} from "../../../shared/openalex.ts";
import { readDigests, writeChangedLines } from "../../digests/digests-file.ts";
import { type Fail, failer } from "../../lib/cli.ts";
import CONSTANTS from "../../lib/constants.json" with { type: "json" };
import { htmlToText } from "../../lib/html.ts";
import { request } from "../../lib/http.ts";
import { daysBefore, jakartaToday } from "../../lib/run-date.ts";

const fail: Fail = failer("topics.ts");
const USAGE =
	"usage: node scripts/scout/openalex/topics.ts <digests file> [--all]";
const OPENALEX_API = process.env.OPENALEX_API || "https://api.openalex.org";
const PAUSE_MS = Number(
	process.env.OPENALEX_PAUSE_MS || CONSTANTS.burstDelayMs,
);
const TIMEOUT_MS = Number(
	process.env.OPENALEX_TIMEOUT_MS || CONSTANTS.requestTimeoutMs,
);
// OpenAlex answers 50 papers in about 100 KB.
const MAX_ANSWER_BYTES = 5 * 1024 * 1024;
// OpenAlex's default page is 25 and it drops the rest without a word.
const PER_PAGE = 50;
const RECENT_DAYS = 30;
const SELECT = "title,doi,primary_topic,topics,keywords,locations";
const ARXIV_DOI_PREFIX = "10.48550/arXiv.";
// An arXiv page or PDF address, with or without its version.
const ARXIV_ADDRESS =
	/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/(.+?)(?:v\d+)?(?:\.pdf)?$/i;

// A paper to ask about: its id, its title and the DOI to ask for.
export type OpenAlexQuestion = { id: string; title: string; doi: string };

// A title with case, TeX, HTML tags and punctuation set aside.
function titleKey(title: string) {
	return htmlToText(title)
		.normalize("NFKC")
		.replace(/[$_{}\\^]/g, "")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "");
}

function nameOf(value: unknown) {
	if (!isJsonObject(value) || typeof value.display_name !== "string") {
		return null;
	}
	const name = value.display_name.trim();
	if (name === "" || name.length > OPENALEX_CAPS.text) {
		return null;
	}
	return name;
}

function topicOf(value: unknown): OpenAlexTopic | null {
	if (!isJsonObject(value) || typeof value.score !== "number") {
		return null;
	}
	const name = nameOf(value);
	const field = nameOf(value.field);
	if (
		name === null ||
		field === null ||
		!(value.score >= 0 && value.score <= 1)
	) {
		return null;
	}
	return {
		name: name,
		field: field,
		score: Math.round(value.score * 1e4) / 1e4,
	};
}

// The main topic first, then the others, without a topic twice.
function topicsOf(work: JsonObject) {
	const listed = Array.isArray(work.topics) ? work.topics : [];
	const topics: OpenAlexTopic[] = [];
	const seen = new Set<string>();
	for (const value of [work.primary_topic, ...listed]) {
		const topic = topicOf(value);
		if (topic !== null && !seen.has(topic.name)) {
			seen.add(topic.name);
			topics.push(topic);
		}
	}
	return topics.slice(0, OPENALEX_CAPS.topics);
}

function keywordsOf(work: JsonObject) {
	const listed = Array.isArray(work.keywords) ? work.keywords : [];
	const names = listed.map(nameOf).filter((name) => name !== null);
	return [...new Set(names)].slice(0, OPENALEX_CAPS.keywords);
}

// The arXiv ids a work is held at: OpenAlex merges a preprint with its published version, so the work's own DOI may
// be the published one.
function arxivIdsOf(work: JsonObject) {
	const ids: string[] = [];
	for (const location of Array.isArray(work.locations) ? work.locations : []) {
		if (!isJsonObject(location)) {
			continue;
		}
		for (const address of [location.landing_page_url, location.pdf_url]) {
			const id = String(address).match(ARXIV_ADDRESS)?.[1];
			if (id !== undefined) {
				ids.push(id);
			}
		}
	}
	return ids;
}

function doiOf(work: JsonObject) {
	if (typeof work.doi !== "string") {
		return null;
	}
	return work.doi.replace(/^https?:\/\/doi\.org\//i, "").toLowerCase();
}

// The paper each work of an answer is, by its DOI or its arXiv address, with the topics and keywords it brings.
// A work whose title differs from the paper's, or that has no topics, brings nothing.
export function topicsFromAnswer(
	questions: OpenAlexQuestion[],
	answer: unknown,
): Map<string, EntryOpenAlex> {
	const byDoi = new Map<string, OpenAlexQuestion>();
	const byArxiv = new Map<string, OpenAlexQuestion>();
	for (const question of questions) {
		byDoi.set(question.doi.toLowerCase(), question);
		if (question.id.startsWith("arxiv:")) {
			byArxiv.set(normalizeId(question.id), question);
		}
	}
	const found = new Map<string, EntryOpenAlex>();
	const results =
		isJsonObject(answer) && Array.isArray(answer.results) ? answer.results : [];
	for (const work of results) {
		if (!isJsonObject(work)) {
			continue;
		}
		const doi = doiOf(work);
		let question = doi === null ? undefined : byDoi.get(doi);
		for (const id of arxivIdsOf(work)) {
			question ??= byArxiv.get(id);
		}
		if (question === undefined || found.has(question.id)) {
			continue;
		}
		if (titleKey(String(work.title)) !== titleKey(question.title)) {
			console.error(
				`topics.ts: OpenAlex's title for ${question.id} differs from the paper's, so it gets no topics: ${String(work.title)}`,
			);
			continue;
		}
		const topics = topicsOf(work);
		if (topics.length > 0) {
			found.set(question.id, { topics: topics, keywords: keywordsOf(work) });
		}
	}
	return found;
}

// A paper to ask about, and every entry of it in the file.
type Target = {
	question: OpenAlexQuestion;
	entries: JsonObject[];
	lines: number[];
};

// The DOI to ask for, or null when the id is no arXiv paper or DOI, or the DOI would break the filter.
function doiToAsk(id: string) {
	let doi: string | null = null;
	if (id.startsWith("arxiv:") && isArxivId(normalizeId(id))) {
		doi = ARXIV_DOI_PREFIX + normalizeId(id);
	}
	if (id.startsWith("doi:")) {
		doi = id.slice("doi:".length);
	}
	if (doi === null || /[,|]/.test(doi)) {
		return null;
	}
	return doi;
}

async function main(args: string[]) {
	const [file, flag] = args;
	if (
		file === undefined ||
		(flag !== undefined && flag !== "--all") ||
		args.length > 2
	) {
		fail(USAGE);
	}
	const since = daysBefore(jakartaToday(), RECENT_DAYS);
	const read = readDigests(file, (line, problem) =>
		fail(`line ${line} of ${file} ${problem}`),
	);
	const targets = new Map<string, Target>();
	for (const { index, digest } of read.digests) {
		if (!isJsonObject(digest) || !Array.isArray(digest.entries)) {
			continue;
		}
		if (
			flag === undefined &&
			!(typeof digest.date === "string" && digest.date >= since)
		) {
			continue;
		}
		for (const entry of digest.entries) {
			if (
				!isJsonObject(entry) ||
				entry.type !== "paper" ||
				entry.openalex !== undefined
			) {
				continue;
			}
			const id = String(entry.id);
			const doi = doiToAsk(id);
			if (doi === null || typeof entry.title !== "string") {
				continue;
			}
			const target = targets.get(id) ?? {
				question: { id: id, title: entry.title, doi: doi },
				entries: [],
				lines: [],
			};
			target.entries.push(entry);
			target.lines.push(index);
			targets.set(id, target);
		}
	}
	const questions = [...targets.values()].map((target) => target.question);
	if (questions.length === 0) {
		console.log("no paper needs OpenAlex topics");
		return;
	}

	const found = new Map<string, EntryOpenAlex>();
	for (let start = 0; start < questions.length; start += PER_PAGE) {
		if (start > 0) {
			// biome-ignore lint/performance/noAwaitInLoops: one request a second
			await sleep(PAUSE_MS);
		}
		const batch = questions.slice(start, start + PER_PAGE);
		const dois = batch.map((question) => encodeURIComponent(question.doi));
		const url = `${OPENALEX_API}/works?filter=doi:${dois.join("|")}&per_page=${PER_PAGE}&select=${SELECT}`;
		const response = await request(url, {
			timeoutMs: TIMEOUT_MS,
			maxBytes: MAX_ANSWER_BYTES,
		});
		if ("problem" in response) {
			fail(`OpenAlex ${response.problem}; no topics were added`);
		}
		if (!response.ok) {
			fail(
				`OpenAlex answered HTTP ${response.status}, so its free budget may be spent; no topics were added`,
			);
		}
		let answer: unknown;
		try {
			answer = JSON.parse(response.text());
		} catch {
			fail(
				"OpenAlex answered with something that isn't JSON; no topics were added",
			);
		}
		if (!isJsonObject(answer) || !Array.isArray(answer.results)) {
			fail("OpenAlex answered with no results; no topics were added");
		}
		for (const [id, openalex] of topicsFromAnswer(batch, answer)) {
			found.set(id, openalex);
		}
	}

	const changed = new Set<number>();
	for (const [id, openalex] of found) {
		const target = targets.get(id);
		for (const entry of target?.entries ?? []) {
			entry.openalex = openalex;
		}
		for (const line of target?.lines ?? []) {
			changed.add(line);
		}
	}
	if (changed.size > 0) {
		writeChangedLines(file, read, changed, (path, code) =>
			fail(`${path} not written: ${code ?? "unknown error"}`),
		);
	}
	console.log(`OpenAlex topics: ${found.size} of ${questions.length} papers`);
}

// Run only when called as a script, not when imported.
if (import.meta.main) {
	await main(process.argv.slice(2));
}
