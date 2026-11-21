// List candidates for the daily surprise paper from science outlets' stories, so the scout picks by one fixed rule:
// the papers linked by Quanta Magazine's stories of the last 7 days, then by Nature's news stories of those days, each
// story's own page read for its links. An AI or machine-learning paper is never a candidate.
// Usage: node scripts/scout/surprise.ts [--date YYYY-MM-DD] <digests file>
// --date D fills in a day the scout missed: the 7 days are D and the 6 days before it (rule in scripts/lib/run-date.ts).
// Environment: QUANTA_API, QUANTA_SITE, NATURE_FEED, NATURE_SITE, ARXIV_API, CROSSREF_API (stand-ins for tests);
// SURPRISE_PAGE_PAUSE_MS (the pause between story pages, 0 in tests); LIMINAL_TODAY (YYYY-MM-DD) is taken as today in Asia/Jakarta, tests only.
import { existsSync, readFileSync } from "node:fs";
import { decodeHTML } from "entities";
import { isArxivId } from "../../shared/arxiv-id.ts";
import { readLines } from "../../shared/entry-checks.ts";
import { errorCode, isJsonObject } from "../../shared/narrow.ts";
import { idsInText } from "../digests/digests-file.ts";
import { type Fail, failer } from "../lib/cli.ts";
import CONSTANTS from "../lib/constants.json" with { type: "json" };
import { htmlToText } from "../lib/html.ts";
import { request } from "../lib/http.ts";
import {
	daysBefore,
	jakartaToday,
	runDateProblem,
	takeDateOption,
} from "../lib/run-date.ts";
import { apiFailed, arxivRequest, parseFeed } from "./arxiv/api.ts";
import { crossrefPaper } from "./proceedings/sites.ts";

const fail: Fail = failer("surprise.ts");

const QUANTA_API =
	process.env.QUANTA_API || "https://www.quantamagazine.org/wp-json/wp/v2";
// A story page is read only on its outlet's own site: the addresses come from the outlet's API or feed.
const QUANTA_SITE =
	process.env.QUANTA_SITE || "https://www.quantamagazine.org/";
const NATURE_FEED =
	process.env.NATURE_FEED || "https://www.nature.com/nature.rss";
const NATURE_SITE = process.env.NATURE_SITE || "https://www.nature.com/";
const ARXIV_API = process.env.ARXIV_API || CONSTANTS.arxivApi;
const USAGE =
	"usage: node scripts/scout/surprise.ts [--date YYYY-MM-DD] <digests file>";
// "The last 7 days": today and the 6 days before it.
const DAYS = 7;
// A story's paper is the first it links that was published in this many days before the story; older ones are
// background it cites.
const RECENT_DAYS = 365;
// The pause between two story pages of one site.
export const PAGE_PAUSE_MS = Number(
	process.env.SURPRISE_PAGE_PAUSE_MS || CONSTANTS.burstDelayMs,
);
const QUANTA_HEADING =
	"quanta (stories from the last 7 days that link a paper, newest first):";
const NATURE_HEADING =
	"nature (news stories from the last 7 days that link a paper, newest first):";

// arXiv's AI and machine-learning categories: a paper whose primary category is one of them is never a candidate.
const AI_CATEGORIES = [
	"cs.AI",
	"cs.LG",
	"cs.CL",
	"cs.CV",
	"cs.NE",
	"cs.MA",
	"cs.RO",
	"cs.IR",
	"stat.ML",
];
// Words in a journal's name that make it an AI journal ("Nature Machine Intelligence", "Neural Computation").
const AI_JOURNAL =
	/artificial intelligence|machine intelligence|machine learning|neural networks|neural computation|computational linguistics/i;

// A link to an arXiv abstract page or PDF: "https://arxiv.org/abs/2610.01234", "https://www.arxiv.org/pdf/2609.55555v2.pdf",
// "https://arxiv.org/abs/math/0309136". Group 1 is the id without its version.
// The lookbehind keeps hosts such as "notarxiv.org" out; (?!\d) keeps "2610.012345" from reading as "2610.01234".
// The "i" flag lets "arXiv.org" match; isArxivId then refuses ids in the wrong case, such as "Math/0309136".
const ARXIV_LINK =
	/(?<![\w.-])(?:www\.)?arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?(?!\d)/gi;
// A doi.org link's DOI, escaped or not: "https://doi.org/10.1038%2Fs41591-026-04661-7". Group 1 is the DOI as written,
// without a query or fragment the link may carry.
const DOI_LINK = /^https?:\/\/(?:dx\.)?doi\.org\/(10\.[^?#\s]+)(?:[?#]\S*)?$/i;
// arXiv's own DOIs, 10.48550/arXiv.<id>: the paper is the arXiv paper. Group 1 is the id.
const ARXIV_DOI = /^10\.48550\/arxiv\.(.+)$/i;
// Nature's news stories are DOIs too (10.1038/d41586-...): a story, not a paper.
const NATURE_NEWS_DOI = /^10\.1038\/d41586-/i;

// A story of one outlet: its day (YYYY-MM-DD), title and address.
export type Story = { date: string; title: string; url: string };

// A story and the papers its page links, in link order.
type StoryPapers = { story: Story; ids: string[] };

// What arXiv or Crossref say about a paper: its field (an arXiv primary category or a journal) and its date as
// precise as the record gives it; null for what can't be read.
export type PaperFacts = { field: string | null; published: string | null };

// What a GET read: the body, or a problem in words that finish "<source> ...".
type TextAnswer = { body: string } | { problem: string };

// Any text as one line: runs of whitespace, line breaks included, become one space.
function oneLine(value: unknown) {
	return String(value || "")
		.replace(/\s+/g, " ")
		.trim();
}

// Rendered HTML as one line.
function plainText(html: string) {
	return oneLine(htmlToText(String(html || "")));
}

// The `rendered` text of a WordPress field such as title; "" when the field is missing.
function rendered(field: unknown) {
	if (isJsonObject(field) && typeof field.rendered === "string") {
		return field.rendered;
	}
	return "";
}

// Newest first by date; sort() is stable, so stories of one day keep the order they came in.
function newestFirst(stories: Story[]) {
	return stories.sort((a, b) => b.date.localeCompare(a.date));
}

// The arXiv papers an HTML text links, in link order, each once, without versions: ["2609.55555", "math/0309136"].
export function arxivIdsInHtml(html: unknown): string[] {
	const ids: string[] = [];
	for (const match of String(html || "").matchAll(ARXIV_LINK)) {
		const id = match[1];
		if (id !== undefined && isArxivId(id) && !ids.includes(id)) {
			ids.push(id);
		}
	}
	return ids;
}

// The paper one href points at: "arxiv:<id>" for an arXiv page or an arXiv DOI, "doi:<doi>" (lower case, as Crossref
// writes DOIs) for another doi.org link; null for anything else, Nature's own news DOIs included.
function paperOfHref(href: string): string | null {
	const arxiv = arxivIdsInHtml(href)[0];
	if (arxiv !== undefined) {
		return `arxiv:${arxiv}`;
	}
	const doiLink = href.match(DOI_LINK);
	if (doiLink === null || doiLink[1] === undefined) {
		return null;
	}
	let doi: string;
	try {
		doi = decodeURIComponent(doiLink[1]).toLowerCase();
	} catch {
		return null;
	}
	const arxivDoi = doi.match(ARXIV_DOI);
	if (
		arxivDoi !== null &&
		arxivDoi[1] !== undefined &&
		isArxivId(arxivDoi[1])
	) {
		return `arxiv:${arxivDoi[1]}`;
	}
	if (NATURE_NEWS_DOI.test(doi)) {
		return null;
	}
	return `doi:${doi}`;
}

// The papers a story page links, in link order, each once: "arxiv:<id>" for an arXiv link or an arXiv DOI,
// "doi:<doi>" for another doi.org link. Only href attributes count: a DOI in the text is not a link, and links to a
// journal's own pages are left out, since Nature's pages list other papers that way under "latest content".
export function paperIdsInHtml(html: string): string[] {
	const ids: string[] = [];
	for (const match of html.matchAll(/\shref\s*=\s*"([^"]*)"/gi)) {
		const id = paperOfHref(decodeHTML(match[1] || "").trim());
		if (id !== null && !ids.includes(id)) {
			ids.push(id);
		}
	}
	return ids;
}

// Quanta posts from its WordPress API -> its stories dated startDate or later, newest first. A post without a readable
// date can't be placed in the window and is left out.
export function quantaStories(posts: unknown[], startDate: string): Story[] {
	const stories: Story[] = [];
	for (const post of posts) {
		if (
			isJsonObject(post) &&
			typeof post.date === "string" &&
			/^\d{4}-\d{2}-\d{2}/.test(post.date) &&
			post.date.slice(0, 10) >= startDate &&
			typeof post.link === "string"
		) {
			stories.push({
				date: post.date.slice(0, 10),
				title: plainText(rendered(post.title)),
				url: post.link,
			});
		}
	}
	return newestFirst(stories);
}

// The text of an RSS item's element, its CDATA unwrapped and entities decoded; "" when the item has none.
function itemField(item: string, tag: string) {
	const found = item.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
	if (found === null) {
		return "";
	}
	const text = (found[1] || "").replace(
		/^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/,
		"$1",
	);
	return oneLine(decodeHTML(text));
}

// Nature's feed -> its news stories (addresses /articles/d...) dated startDate or later, newest first. The feed's
// research articles (/articles/s...) are papers, not stories about one.
export function natureStories(xml: string, startDate: string): Story[] {
	const stories: Story[] = [];
	for (const match of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/g)) {
		const item = match[0];
		const url = itemField(item, "link");
		const date = itemField(item, "dc:date").slice(0, 10);
		if (
			/\/articles\/d\d/.test(url) &&
			/^\d{4}-\d{2}-\d{2}$/.test(date) &&
			date >= startDate
		) {
			stories.push({ date: date, title: itemField(item, "title"), url: url });
		}
	}
	return newestFirst(stories);
}

// Why a paper is an AI paper, given its arXiv primary category or its journal: the category or journal; null when
// it isn't one.
export function aiReason(field: string): string | null {
	if (AI_CATEGORIES.includes(field) || AI_JOURNAL.test(field)) {
		return field;
	}
	return null;
}

// The ids the digests file already holds: "arxiv:<id>" without versions, and "doi:" ids. A file that doesn't exist yet
// holds none. A line that doesn't load stops the run: the marks would be unreliable.
function idsAlreadyInDigests(file: string): Set<string> {
	if (!existsSync(file)) {
		return new Set();
	}
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		fail(`can't read ${file} (${errorCode(error)})`);
	}
	for (const line of readLines(text)) {
		// Only the line number, without parseLine's column.
		if (line.problem !== undefined) {
			fail(`line ${line.number} of ${file} doesn't load`);
		}
	}
	// The same checks arxiv.ts and proceedings.ts --append use to skip ids, so a line not marked here is one they add.
	const known = new Set<string>();
	const ids = idsInText(text);
	for (const id of ids.arxiv) {
		known.add(`arxiv:${id}`);
	}
	for (const id of ids.other) {
		known.add(id.toLowerCase());
	}
	return known;
}

// One GET with the user agent and a 30 s limit. Requests are awaited one by one, so only one is open at a time.
async function getText(url: string): Promise<TextAnswer> {
	const answer = await request(url);
	if ("problem" in answer) {
		return { problem: `${answer.problem} (${url})` };
	}
	if (!answer.ok) {
		return { problem: `answered HTTP ${answer.status} (${url})` };
	}
	return { body: answer.text() };
}

// Wait `ms` milliseconds.
function pause(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Each story with the papers it links, read from its own page, one page at a time with a pause between them. A page on
// another site than `site` is not read; a page that fails is named and its story left out.
async function storyPapers(
	outlet: string,
	stories: Story[],
	site: string,
): Promise<StoryPapers[]> {
	const read: StoryPapers[] = [];
	let first = true;
	for (const story of stories) {
		if (!story.url.startsWith(site)) {
			console.error(
				`surprise.ts: ${outlet} story not read, its address is not on ${site}: ${story.url}`,
			);
			continue;
		}
		if (!first) {
			// biome-ignore lint/performance/noAwaitInLoops: one page at a time, a second apart, keeps the site's load light
			await pause(PAGE_PAUSE_MS);
		}
		first = false;
		const answer = await getText(story.url);
		if ("problem" in answer) {
			console.error(`surprise.ts: ${outlet} story page ${answer.problem}`);
			continue;
		}
		read.push({ story: story, ids: paperIdsInHtml(answer.body) });
	}
	return read;
}

// Quanta's stories since startDate, with the papers their pages link; null when Quanta's API failed (said on stderr).
// endDate, given with --date, is the last day: Quanta is asked for stories before the day after it, and a later story
// it sends anyway is left out. null for no end.
async function quantaCandidates(startDate: string, endDate: string | null) {
	let url = `${QUANTA_API}/posts?after=${startDate}T00:00:00&per_page=50&_fields=date,link,title`;
	if (endDate !== null) {
		url += `&before=${daysBefore(endDate, -1)}T00:00:00`;
	}
	const answer = await getText(url);
	if ("problem" in answer) {
		console.error(`surprise.ts: Quanta ${answer.problem}`);
		return null;
	}
	let posts: unknown;
	try {
		posts = JSON.parse(answer.body);
	} catch {
		posts = null;
	}
	if (!Array.isArray(posts)) {
		console.error(
			`surprise.ts: Quanta answered something that isn't a list (${url})`,
		);
		return null;
	}
	let stories = quantaStories(posts, startDate);
	if (endDate !== null) {
		stories = stories.filter((story) => story.date <= endDate);
	}
	return storyPapers("Quanta", stories, QUANTA_SITE);
}

// Nature's news stories from startDate to endDate (today without --date), with the papers their pages cite; null when
// the feed failed (said on stderr).
async function natureCandidates(startDate: string, endDate: string) {
	const answer = await getText(NATURE_FEED);
	if ("problem" in answer) {
		console.error(`surprise.ts: Nature ${answer.problem}`);
		return null;
	}
	const stories = natureStories(answer.body, startDate).filter(
		(story) => story.date <= endDate,
	);
	return storyPapers("Nature", stories, NATURE_SITE);
}

// What arXiv says about each arXiv paper, by "arxiv:<id>": its primary category and first submission day, in one
// request; null when arXiv can't be asked. A paper arXiv doesn't give is missing from the map.
async function arxivFacts(ids: string[]) {
	const facts = new Map<string, PaperFacts>();
	if (ids.length === 0) {
		return facts;
	}
	const bare = ids.map((id) => id.slice("arxiv:".length));
	const answer = await arxivRequest(
		`${ARXIV_API}?id_list=${bare.join(",")}&max_results=${bare.length}`,
	);
	if (apiFailed(answer) || !answer.ok) {
		console.error(
			`surprise.ts: arXiv ${answer.problem || `answered HTTP ${answer.status}`} (${answer.url}); ` +
				"arXiv papers' fields are unknown",
		);
		return null;
	}
	for (const paper of parseFeed(answer.body)) {
		facts.set(paper.id, {
			field: paper.category || null,
			published: paper.published || null,
		});
	}
	return facts;
}

// What Crossref says about a DOI paper: its journal and date, each null when the record lacks it or can't be read
// (named). null when Crossref doesn't know the DOI: it is registered elsewhere, as a Zenodo dataset is with DataCite,
// and proceedings.ts --crossref couldn't add it either.
async function doiFacts(id: string): Promise<PaperFacts | null> {
	const answer = await crossrefPaper(id.slice("doi:".length));
	if ("entry" in answer) {
		if (typeof answer.entry.source === "string") {
			return { field: answer.entry.source, published: answer.published };
		}
		console.error(`surprise.ts: Crossref names no journal for ${id}`);
		return { field: null, published: answer.published };
	}
	if ("problem" in answer) {
		console.error(`surprise.ts: Crossref ${answer.problem}: ${id}`);
	} else if (answer.missing === "not found") {
		console.error(`surprise.ts: Crossref doesn't know ${id}; passed over`);
		return null;
	} else {
		console.error(
			`surprise.ts: Crossref's record of ${id} has no title or author`,
		);
	}
	return { field: null, published: null };
}

// True when a date as precise as its record ("2025", "2025-11" or "2025-11-03") is on or after `cutoff` (YYYY-MM-DD),
// compared as far as the date goes.
function onOrAfter(published: string, cutoff: string) {
	return published >= cutoff.slice(0, published.length);
}

// What one link of a story is, checked in this order: a paper already in the digests; not the story's paper (a DOI
// Crossref doesn't know, given as null facts, or a paper published before `cutoff`), so the walk goes on; a paper whose
// field can't be read; an AI paper; or the story's paper.
export type Verdict =
	| "in digests"
	| "passed over"
	| "field unknown"
	| "AI paper"
	| "story's paper";

// The verdict on one link, from whether the digests hold it and what arXiv or Crossref say about it.
export function paperVerdict(
	inDigests: boolean,
	facts: PaperFacts | null,
	cutoff: string,
): Verdict {
	if (inDigests) {
		return "in digests";
	}
	if (facts === null) {
		return "passed over";
	}
	if (facts.published !== null && !onOrAfter(facts.published, cutoff)) {
		return "passed over";
	}
	if (facts.field === null) {
		return "field unknown";
	}
	if (aiReason(facts.field) !== null) {
		return "AI paper";
	}
	return "story's paper";
}

// The section lines of each channel, one per story: its paper, the first it links that was published in the 365 days
// before it. A paper in the digests gives its line marked "(in digests)", one whose date or field can't be read gives
// it marked "(field unknown)". When the story's paper is an AI paper, the story gives no line and the paper is named.
// Crossref is asked only for DOIs a story's walk reaches, each once.
async function sectionLines(
	channels: (StoryPapers[] | null)[],
	known: Set<string>,
): Promise<(string[] | null)[]> {
	// arXiv is asked once, for every arXiv paper not in the digests.
	const arxivIds: string[] = [];
	for (const stories of channels) {
		for (const read of stories || []) {
			for (const id of read.ids) {
				if (
					id.startsWith("arxiv:") &&
					!known.has(id) &&
					!arxivIds.includes(id)
				) {
					arxivIds.push(id);
				}
			}
		}
	}
	const fromArxiv = await arxivFacts(arxivIds);
	const fromCrossref = new Map<string, PaperFacts | null>();

	// The story's line, or null for none.
	async function storyLine(read: StoryPapers) {
		const { story, ids } = read;
		const cutoff = daysBefore(story.date, RECENT_DAYS);
		for (const id of ids) {
			let text = `${story.date} ${id} ${story.title} ${story.url}`;
			const inDigests = known.has(id);
			let facts: PaperFacts | null = { field: null, published: null };
			// A paper in the digests is not asked for: its line is marked whatever arXiv or Crossref would say.
			if (!inDigests && id.startsWith("arxiv:") && fromArxiv !== null) {
				facts = fromArxiv.get(id) || facts;
			} else if (!inDigests && id.startsWith("doi:")) {
				if (!fromCrossref.has(id)) {
					// biome-ignore lint/performance/noAwaitInLoops: the walk stops at the story's paper, so later DOIs are never asked
					fromCrossref.set(id, await doiFacts(id));
				}
				facts = fromCrossref.get(id) || null;
			}
			const verdict = paperVerdict(inDigests, facts, cutoff);
			if (verdict === "passed over") {
				continue;
			}
			if (verdict === "in digests") {
				return `${text} (in digests)`;
			}
			if (verdict === "field unknown") {
				return `${text} (field unknown)`;
			}
			// The last two verdicts come with a field; TypeScript can't follow paperVerdict.
			let field = "";
			if (facts !== null && facts.field !== null) {
				field = facts.field;
			}
			if (verdict === "AI paper") {
				console.error(
					`surprise.ts: left out ${id}, an AI paper (${field}), linked from ${story.url}`,
				);
				return null;
			}
			if (id.startsWith("doi:")) {
				text += ` | ${field}`;
			}
			return text;
		}
		return null;
	}

	const sections: (string[] | null)[] = [];
	for (const stories of channels) {
		if (stories === null) {
			sections.push(null);
			continue;
		}
		const lines: string[] = [];
		for (const read of stories) {
			// biome-ignore lint/performance/noAwaitInLoops: Crossref is asked one DOI at a time, in story order
			const printed = await storyLine(read);
			if (printed !== null) {
				lines.push(printed);
			}
		}
		sections.push(lines);
	}
	return sections;
}

// Print a section: its heading and lines, or the heading with " none" or " not available" (when the channel failed).
function printSection(heading: string, lines: string[] | null) {
	if (lines === null) {
		console.log(`${heading} not available`);
	} else if (lines.length === 0) {
		console.log(`${heading} none`);
	} else {
		console.log(heading);
		for (const line of lines) {
			console.log(line);
		}
	}
}

async function main(args: string[]) {
	const parsed = takeDateOption(args);
	let file: string | undefined;
	if (parsed !== null && parsed.rest.length === 1) {
		file = parsed.rest[0];
	}
	if (parsed === null || file === undefined || file === "") {
		console.error(USAGE);
		process.exitCode = 1;
		return;
	}
	// A --date that can't be filled in stops here, before the file is read or any request.
	const today = jakartaToday();
	const date = parsed.date;
	if (date !== null) {
		const problem = runDateProblem(date, today);
		if (problem !== null) {
			fail(problem);
		}
	}
	const known = idsAlreadyInDigests(file);
	const lastDay = date || today;
	const firstDay = daysBefore(lastDay, DAYS - 1);

	// One channel that fails doesn't stop the other; the fields are checked once both are read.
	const quanta = await quantaCandidates(firstDay, date);
	const nature = await natureCandidates(firstDay, lastDay);
	const [quantaLines, natureLines] = await sectionLines(
		[quanta, nature],
		known,
	);
	printSection(QUANTA_HEADING, quantaLines || null);
	printSection(NATURE_HEADING, natureLines || null);

	// exitCode, not exit(): exit() could cut off output that is still being written.
	if (quanta === null && nature === null) {
		process.exitCode = 1;
	}
}

// Run only when called as a script, not when imported.
if (import.meta.main) {
	await main(process.argv.slice(2));
}
