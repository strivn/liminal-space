// Unit tests for the exports of scripts/scout/search.ts, derived from the scout-search
// contract: reading interests.md's two sections, building the arXiv and Google News queries, matching list titles to topic
// phrases, normalising titles, reading each list format, parsing CSV and cutting text. Expected values are written out by
// hand. The list formats are short excerpts of the real pages in tests/fixtures/lists. Nothing here contacts arXiv, Google
// News or a conference site.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import type { Paper } from "../../scripts/scout/arxiv/api.ts";
import type * as ArxivSearch from "../../scripts/scout/arxiv/search.ts";
import type * as Interests from "../../scripts/scout/plan/interests.ts";
import type * as PoolModule from "../../scripts/scout/plan/pool.ts";
import type * as TitleMatch from "../../scripts/scout/plan/title-match.ts";
import type * as VenueLists from "../../scripts/scout/proceedings/venue-lists.ts";
import type * as Search from "../../scripts/scout/search.ts";
import { allowLocal } from "./local-server.ts";

const SCRIPT = new URL("../../scripts/scout/search.ts", import.meta.url);
const ARXIV_SEARCH = new URL(
	"../../scripts/scout/arxiv/search.ts",
	import.meta.url,
);
const INTERESTS_MODULE = new URL(
	"../../scripts/scout/plan/interests.ts",
	import.meta.url,
);
const POOL = new URL("../../scripts/scout/plan/pool.ts", import.meta.url);
const TITLE_MATCH = new URL(
	"../../scripts/scout/plan/title-match.ts",
	import.meta.url,
);
const VENUE_LISTS = new URL(
	"../../scripts/scout/proceedings/venue-lists.ts",
	import.meta.url,
);
const listFixture = (name: string) =>
	readFileSync(new URL(`../fixtures/lists/${name}`, import.meta.url), "utf8");

// TMPDIR and LIMINAL_CACHE point at a fresh folder before the script is first imported (the tests import it later, after
// this module's top level has run, as setting os.environ before the first `import` in Python), so nothing set up on import
// lands in the repo. The folder is deleted when this file's tests end.
const TEST_TMPDIR = mkdtempSync(join(tmpdir(), "liminal-unit-search-"));
process.env.TMPDIR = TEST_TMPDIR;
process.env.LIMINAL_CACHE = join(TEST_TMPDIR, "cache");
// The same way, arXiv's 3 s pause between requests is 0, and a minute of retry waiting lasts 100 ms.
const TEST_MINUTE_MS = 100;
process.env.ARXIV_PAUSE_MS = "0";
process.env.ARXIV_RETRY_MINUTE_MS = String(TEST_MINUTE_MS);
afterAll(() => {
	rmSync(TEST_TMPDIR, { recursive: true, force: true });
});

// interests.md laid out as the real file is: a Topics section of numbered prose lines first, then "Search phrases" (with
// a prose line), then "Conferences" (with prose lines), then a section whose lines look like topics and lists but aren't.
const INTERESTS = [
	"# Interests",
	"What the scout looks for.",
	"",
	"## Topics, highest priority first",
	"1. AI interpretability and control: probes, sparse",
	"   autoencoders, circuits, steering",
	"2. Societal impacts of AI: economics and labour",
	"",
	"## Search phrases",
	"One line per topic: its number, then phrases separated by commas.",
	"1. sparse autoencoder, activation steering, deception & language model",
	"2. labor market",
	"",
	"## Conferences",
	"Main-track and workshop papers from these conferences rank above arXiv-only papers.",
	"Accepted lists for 2026:",
	"- AIES: https://www.aies-conference.com/2026/paper-sessions/",
	"- AIES: https://www.aies-conference.com/2026/poster-sessions/",
	"- PETS: https://petsymposium.org/2026/paperlist.php (published 2026-10-01)",
	"- NeurIPS: https://neurips.cc/static/virtual/data/neurips-2026-orals-posters.json",
	"",
	"## Surprise (one per day)",
	"3. surprise, not a topic",
	"- Not a list: https://example.org/surprise",
].join("\n");

// The Background's two topics, as the Search phrases section writes them.
const TOPIC_1 = [
	"sparse autoencoder",
	"activation steering",
	"deception & language model",
];
const TOPIC_2 = ["labor market"];

// ---- interests.md ----

// Topic numbers are compared as text, so a number or a string both pass; the contract doesn't fix the type.
test("The Search phrases section gives each topic its phrases as written, and nothing outside it is read", async () => {
	const { searchPhrases }: typeof Interests = await import(
		INTERESTS_MODULE.href
	);
	const found = searchPhrases(INTERESTS);
	assert.ok(found !== null, "a Search phrases section");
	const topics = found.map((entry) => {
		return { topic: String(entry.topic), phrases: entry.phrases };
	});
	assert.deepEqual(topics, [
		{
			topic: "1",
			phrases: [
				"sparse autoencoder",
				"activation steering",
				"deception & language model",
			],
		},
		{ topic: "2", phrases: ["labor market"] },
	]);
});

// The CLI stops on this before any request ('the "Search phrases" section in interests.md has no topic lines'). The
// numbered lines of the sections around it are not topic lines of "Search phrases".
test("A Search phrases section holding only prose gives no topics, whatever numbered lines other sections hold", async () => {
	const { searchPhrases }: typeof Interests = await import(
		INTERESTS_MODULE.href
	);
	const markdown = [
		"# Interests",
		"",
		"## Topics, highest priority first",
		"1. AI interpretability and control: probes, sparse autoencoders, steering",
		"2. Societal impacts of AI: economics and labour",
		"",
		"## Search phrases",
		"One line per topic: its number, then phrases separated by commas.",
		"",
		"## Surprise (one per day)",
		"3. surprise, not a topic",
	].join("\n");
	assert.deepEqual(searchPhrases(markdown), []);
});

// A missing publication date is compared as null, so null, undefined or an empty string all pass.
test("The Conferences section gives each list its venue, URL and publication date, and two lists may share a venue", async () => {
	const { conferenceLists }: typeof Interests = await import(
		INTERESTS_MODULE.href
	);
	const lists = conferenceLists(INTERESTS).map((entry) => {
		return {
			venue: entry.venue,
			url: entry.url,
			published: entry.published || null,
		};
	});
	assert.deepEqual(lists, [
		{
			venue: "AIES",
			url: "https://www.aies-conference.com/2026/paper-sessions/",
			published: null,
		},
		{
			venue: "AIES",
			url: "https://www.aies-conference.com/2026/poster-sessions/",
			published: null,
		},
		{
			venue: "PETS",
			url: "https://petsymposium.org/2026/paperlist.php",
			published: "2026-10-01",
		},
		{
			venue: "NeurIPS",
			url: "https://neurips.cc/static/virtual/data/neurips-2026-orals-posters.json",
			published: null,
		},
	]);
});

// ---- Queries ----

// start and end are the Jakarta dates as arXiv's submittedDate takes them, YYYYMMDD.
test('A topic\'s arXiv query joins its phrases with OR, asks for both halves of "A & B", and covers the dates given', async () => {
	const { topicQuery }: typeof Interests = await import(INTERESTS_MODULE.href);
	assert.equal(
		topicQuery(TOPIC_1, "20260906", "20261006"),
		'submittedDate:[202609060000 TO 202610062359] AND (abs:"sparse autoencoder" OR abs:"activation steering" OR (abs:"deception" AND abs:"language model"))',
	);
	assert.equal(
		topicQuery(TOPIC_2, "20260906", "20261006"),
		'submittedDate:[202609060000 TO 202610062359] AND (abs:"labor market")',
	);
});

// The script adds " when:2d" itself when it builds the URL.
test('A topic\'s Google News queries: its plain phrases quoted and joined with OR, then each "A & B" alone', async () => {
	const { newsQueries }: typeof Interests = await import(INTERESTS_MODULE.href);
	assert.deepEqual(newsQueries(TOPIC_1), [
		'("sparse autoencoder" OR "activation steering")',
		'"deception" "language model"',
	]);
	assert.deepEqual(newsQueries(TOPIC_2), ['("labor market")']);
});

test('A topic of "A & B" phrases only has no OR query', async () => {
	const { newsQueries }: typeof Interests = await import(INTERESTS_MODULE.href);
	assert.deepEqual(newsQueries(["AI & jobs", "AI & labor market"]), [
		'"AI" "jobs"',
		'"AI" "labor market"',
	]);
});

// ---- Matching list titles to topic phrases ----

test("A phrase matches its words in order and next to each other, whatever their case and punctuation", async () => {
	const { phraseMatches }: typeof TitleMatch = await import(TITLE_MATCH.href);
	assert.equal(
		phraseMatches(
			"activation steering",
			"Don’t Steer Blindly: ACTIVATION Steering for LLMs (Extended Abstract)",
		),
		true,
	);
	assert.equal(
		phraseMatches("labor market", "Labor-Market Effects of Writing Assistants"),
		true,
	);
	assert.equal(
		phraseMatches("sparse autoencoder", "Sparse Autoencoder Circuits"),
		true,
	);
	assert.equal(
		phraseMatches(
			"activation steering",
			"Steering Activation Vectors Toward Honesty",
		),
		false,
		"words out of order",
	);
	assert.equal(
		phraseMatches("sparse autoencoder", "Sparse Linear Autoencoders"),
		false,
		"words not next to each other",
	);
});

test('A title word may be the phrase word plus "s" or "es", and the other way round too', async () => {
	const { phraseMatches }: typeof TitleMatch = await import(TITLE_MATCH.href);
	assert.equal(
		phraseMatches(
			"sparse autoencoder",
			"Sparse Autoencoders Find Deception Features in Language Models",
		),
		true,
	);
	assert.equal(
		phraseMatches("gender bias", "Gender Biases in Hiring Models"),
		true,
	);
	// Until 2026-11-05 a phrase's plural didn't stand for a title's singular. The Rule "A title word stands for a phrase
	// word when the two share a stem" compares stems both ways ("models" and "model" share "model"), so it does now.
	assert.equal(
		phraseMatches("language models", "A Language Model for Contract Law"),
		true,
	);
});

test("Phrase words match whole title words only", async () => {
	const { phraseMatches }: typeof TitleMatch = await import(TITLE_MATCH.href);
	assert.equal(
		phraseMatches("labor market", "Laboratory Marketplaces for Robots"),
		false,
	);
	assert.equal(
		phraseMatches("market", "Supermarket Pricing with Reinforcement Learning"),
		false,
	);
});

test('"A & B" matches when the title holds both phrases, each anywhere', async () => {
	const { phraseMatches }: typeof TitleMatch = await import(TITLE_MATCH.href);
	const phrase = "deception & language model";
	assert.equal(
		phraseMatches(
			phrase,
			"Sparse Autoencoders Find Deception Features in Language Models",
		),
		true,
	);
	assert.equal(
		phraseMatches(phrase, "Language Models Learn Deception Early"),
		true,
	);
	assert.equal(phraseMatches(phrase, "Deception in Poker Bots"), false);
	assert.equal(
		phraseMatches(phrase, "Language Model Calibration at Scale"),
		false,
	);
});

test("A title holding none of the phrase does not match", async () => {
	const { phraseMatches }: typeof TitleMatch = await import(TITLE_MATCH.href);
	assert.equal(
		phraseMatches("sparse autoencoder", "Fairness of Loan Approval Models"),
		false,
	);
	assert.equal(
		phraseMatches("labor market", "Fairness of Loan Approval Models"),
		false,
	);
});

// ---- Stems: when a title word stands for a phrase word (Rule "A title word stands for a phrase word when the two share
// a stem", 2026-11-05). A stem is the word without one ending, the longest that fits (ability, ities, ions, ion, ives, ive,
// able, ings, ing, ity, ics, ic, als, al, ies, ed, es, cy, ly, s), with a "t" kept after "cy" comes off "ncy", then
// without a final "e"; shorter than 3 letters, it is the word itself; "s" is no ending after "ss", "us", "is" or "ias".
// words() lowercases before sameWord compares, so stemOf gets lowercase words. ----

// Pairs the feature names as sharing a stem, with the word each pair's stem comes from.
const SHARING_PAIRS: [string, string][] = [
	["sycophantic", "sycophancy"],
	["agents", "agent"],
	["agentic", "agent"],
	["deceptive", "deception"],
	["jailbreaking", "jailbreak"],
	["interpretable", "interpretability"],
	["probing", "probe"],
	["models", "model"],
	["llms", "llm"],
	["biases", "bias"],
];

// Pairs that only begin alike: a shared stem here would make a list title stand for a phrase it has nothing to do with.
const DIFFERING_PAIRS: [string, string][] = [
	["module", "model"],
	["age", "agent"],
	["label", "labor"],
	["policy", "police"],
	["private", "privacy"],
	["jails", "jailbreak"],
];

test("Word pairs the feature names, such as sycophantic and sycophancy, share a stem", async () => {
	const { stemOf }: typeof TitleMatch = await import(TITLE_MATCH.href);
	for (const [a, b] of SHARING_PAIRS) {
		assert.equal(
			stemOf(a),
			stemOf(b),
			`${a} and ${b} share a stem: ${stemOf(a)} vs ${stemOf(b)}`,
		);
	}
});

test("Words that only begin alike do not share a stem", async () => {
	const { stemOf }: typeof TitleMatch = await import(TITLE_MATCH.href);
	for (const [a, b] of DIFFERING_PAIRS) {
		assert.notEqual(
			stemOf(a),
			stemOf(b),
			`${a} and ${b} both stem to ${stemOf(a)}`,
		);
	}
});

test("A stem is the word without one ending, the longest that fits, and without a final e", async () => {
	const { stemOf }: typeof TitleMatch = await import(TITLE_MATCH.href);
	// "ability" is taken whole, not "ity" (leaving "interpretabil") nor "y".
	assert.equal(stemOf("interpretability"), "interpret");
	assert.equal(stemOf("interpretable"), "interpret");
	// "ion" and "ive" come off whole; "ic" too.
	assert.equal(stemOf("deception"), "decept");
	assert.equal(stemOf("deceptive"), "decept");
	assert.equal(stemOf("sycophantic"), "sycophant");
	assert.equal(stemOf("agentic"), "agent");
	// "es" is taken whole, leaving "prob" (not "s", which would leave "probe").
	assert.equal(stemOf("probes"), "prob");
	// Without an ending, a final "e" still goes: "probe" -> "prob", so it meets "probing".
	assert.equal(stemOf("probe"), "prob");
	assert.equal(stemOf("probing"), "prob");
	// A word with no ending and no final "e" is its own stem.
	assert.equal(stemOf("labor"), "labor");
	assert.equal(stemOf("market"), "market");
	// "police" only loses its "e"; "policy" loses "cy": the two stems differ.
	assert.equal(stemOf("police"), "polic");
	assert.notEqual(stemOf("policy"), "polic");
});

test('A word ending in "ncy" keeps a "t" when "cy" comes off', async () => {
	const { stemOf }: typeof TitleMatch = await import(TITLE_MATCH.href);
	assert.equal(stemOf("sycophancy"), "sycophant");
	assert.equal(stemOf("agency"), "agent");
});

test("A stem shorter than 3 letters is the word itself", async () => {
	const { stemOf }: typeof TitleMatch = await import(TITLE_MATCH.href);
	// "age" without its final "e" would be "ag" (2 letters), so "age" stays and never stands for "agent".
	assert.equal(stemOf("age"), "age");
	// "ions" is an ending whole: nothing would be left.
	assert.equal(stemOf("ions"), "ions");
	// "ally" without "ly" would be "al" (2 letters).
	assert.equal(stemOf("ally"), "ally");
	// "its" without "s" would be "it" (2 letters).
	assert.equal(stemOf("its"), "its");
	// Three letters is long enough: "llms" -> "llm", so it meets "llm".
	assert.equal(stemOf("llms"), "llm");
	assert.equal(stemOf("jails"), "jail");
});

test('A lone "s" is not an ending after "ss", "us", "is" or "ias"', async () => {
	const { stemOf }: typeof TitleMatch = await import(TITLE_MATCH.href);
	assert.equal(stemOf("class"), "class");
	assert.equal(stemOf("consensus"), "consensus");
	assert.equal(stemOf("analysis"), "analysis");
	assert.equal(stemOf("bias"), "bias");
	// "es" still is: "biases" -> "bias".
	assert.equal(stemOf("biases"), "bias");
});

test("A title word standing for a phrase word by its stem makes the phrase match", async () => {
	const { phraseMatches }: typeof TitleMatch = await import(TITLE_MATCH.href);
	assert.equal(phraseMatches("sycophancy", "Sycophantic Reward Models"), true);
	assert.equal(
		phraseMatches("agent coordination", "Agentic Coordination Under Pressure"),
		true,
	);
	assert.equal(
		phraseMatches("deception", "Deceptive Language Models Under Pressure"),
		true,
	);
	assert.equal(
		phraseMatches("jailbreak", "Jailbreaking Vision Models with Patches"),
		true,
	);
	assert.equal(phraseMatches("probe", "Linear Probing of Hidden States"), true);
	assert.equal(
		phraseMatches("interpretability", "Interpretable Reward Models"),
		true,
	);
});

test("A title word that only begins like a phrase word does not make the phrase match", async () => {
	const { phraseMatches }: typeof TitleMatch = await import(TITLE_MATCH.href);
	assert.equal(phraseMatches("privacy", "Private Set Intersection"), false);
	assert.equal(
		phraseMatches("jailbreak", "Jails and Breakthroughs in Reform"),
		false,
	);
	assert.equal(phraseMatches("policy", "Police Patrol Routing"), false);
	assert.equal(phraseMatches("model", "Module Composition in Robots"), false);
});

test("Stems do not loosen the order of the words or their being next to each other", async () => {
	const { phraseMatches }: typeof TitleMatch = await import(TITLE_MATCH.href);
	assert.equal(
		phraseMatches("activation steering", "Steering Activation Maps"),
		false,
		"words out of order",
	);
	assert.equal(
		phraseMatches("agent coordination", "Agentic Multi-Party Coordination"),
		false,
		"words not next to each other",
	);
});

// ---- Normalised titles: how a list title and an arXiv title are compared, and the key of a kept answer ----

test("Normalising drops a trailing parenthetical, case, curly quotes and punctuation", async () => {
	const { normaliseTitle }: typeof TitleMatch = await import(TITLE_MATCH.href);
	assert.equal(
		normaliseTitle(
			"Don’t Steer Blindly: ACTIVATION Steering for LLMs (Extended Abstract)",
		),
		"don t steer blindly activation steering for llms",
	);
	assert.equal(
		normaliseTitle("Don't Steer Blindly: Activation Steering for LLMs"),
		"don t steer blindly activation steering for llms",
	);
	assert.equal(
		normaliseTitle("Sparse Autoencoder Probes"),
		"sparse autoencoder probes",
	);
});

test("Only a trailing parenthetical is dropped", async () => {
	const { normaliseTitle }: typeof TitleMatch = await import(TITLE_MATCH.href);
	assert.equal(
		normaliseTitle("Steering (and Probing) Language Models"),
		"steering and probing language models",
	);
});

// U+FB03 "ﬃ" and U+FB01 "ﬁ" are single characters that NFKC spells out as letters.
test("Normalising applies NFKC and collapses whitespace", async () => {
	const { normaliseTitle }: typeof TitleMatch = await import(TITLE_MATCH.href);
	assert.equal(normaliseTitle("Eﬃcient ﬁne-tuning"), "efficient fine tuning");
	assert.equal(
		normaliseTitle("  Sparse   Autoencoders\n Revisited "),
		"sparse autoencoders revisited",
	);
});

// ---- Each list format, read whole ----

test("AIES paper sessions: every WordPress table, the title in the second of three cells, entities decoded", async () => {
	const { listTitles }: typeof VenueLists = await import(VENUE_LISTS.href);
	const titles = listTitles(
		"https://www.aies-conference.com/2026/paper-sessions/",
		listFixture("aies-paper-sessions.html"),
	);
	assert.deepEqual(titles, [
		"The Mitigation Paradox: How AI-Disinformation Experts Converge on Threats but Polarize on Solutions",
		"Mediational Opacity: How AI Reshapes Our Epistemic Environments, and How to Audit It",
		"“Always Want to Use It for Everything”: Understanding Young Adults’ Perceptions of AI Dependence",
		"ABLEIST: Intersectional Disability Bias in LLM-Generated Hiring Scenarios",
	]);
});

test("AIES poster sessions: the title in the third of three cells, since the URL names posters", async () => {
	const { listTitles }: typeof VenueLists = await import(VENUE_LISTS.href);
	const titles = listTitles(
		"https://www.aies-conference.com/2026/poster-sessions/",
		listFixture("aies-poster-sessions.html"),
	);
	assert.deepEqual(titles, [
		"The Unfalsifiable Delusion: Mass Surveillance Infrastructure and Disparate Impact on Americans with Paranoia-Spectrum Conditions",
		"LLMs on the Political Compass: Prompt-Conditioned Positioning and Directional Drift",
		"CompanionSim: Synthetic Data for Evaluating Anthropomorphism in Human-AI Relationships",
	]);
});

// The excerpt has 5 physical lines for 3 records: one abstract holds a line break, doubled quotes and commas.
test("FAccT: the Title column of a CSV whose quoted fields hold commas, quotes and line breaks", async () => {
	const { listTitles }: typeof VenueLists = await import(VENUE_LISTS.href);
	const titles = listTitles(
		"https://facctconference.org/static/docs/facct2026-final.csv",
		listFixture("facct.csv"),
	);
	assert.deepEqual(titles, [
		"Real-Time Group Dynamics with LLM Facilitation: Evidence from a Charity Allocation Task",
		"From Vulnerable Data Subjects to Vulnerabilizing Data Practices: Navigating the Protection Paradox in AI-Based Analyses of Platformized Lives",
		"The Jungkook Effect: Celebrity Data, Fan Cultures, and the Ethics of Generative AI",
	]);
});

// The page's menu items are <li> too, outside the accepted lists; they are not titles.
test("PETS: the text before the first tag of each item in every accepted list", async () => {
	const { listTitles }: typeof VenueLists = await import(VENUE_LISTS.href);
	const titles = listTitles(
		"https://petsymposium.org/2026/paperlist.php",
		listFixture("pets.html"),
	);
	assert.deepEqual(titles, [
		"How We Define Privacy Literacy: Teaching Experiences & Challenges of Community-Engaged Privacy Educators",
		"Obscura: Enabling Ephemeral Proxies for Traffic Encapsulation in WebRTC Media Streams Against Cost-Effective Censors",
		"SilhouetteTell: Practical Video Identification Leveraging Blurred Recordings of Video Subtitles",
	]);
});

// The second entry is the one Markdown broke ("T*: ..."): its title is read up to the line break, without the authors.
test("ACL: each item of the page content up to its first line break, tags stripped", async () => {
	const { listTitles }: typeof VenueLists = await import(VENUE_LISTS.href);
	const titles = listTitles(
		"https://2026.aclweb.org/program/accepted_papers/",
		listFixture("acl.html"),
	);
	assert.equal(titles.length, 3);
	assert.equal(
		titles[0],
		"OctoTools: A Multi-Agent Framework with Extensible Tools for Complex Reasoning",
	);
	const second = titles[1];
	assert.ok(typeof second === "string", "a second title, as text");
	assert.ok(
		second.includes(
			"Progressive Block Scaling for Masked Diffusion Language Models Through Trajectory Aware Reinforcement Learning",
		),
		second,
	);
	assert.ok(
		!second.includes("Hanchen Xia"),
		`no authors in the title: ${second}`,
	);
	assert.equal(
		titles[2],
		"How Long Reasoning Chains Influence LLMs’ Judgment of Answer Factuality",
	);
});

// Six rows, three papers: one poster row three times, its oral row under another id with the same OpenReview id, and a
// journal-track row with no OpenReview id.
test("NeurIPS: results[].name, a paper counted once however many rows it has", async () => {
	const { listTitles }: typeof VenueLists = await import(VENUE_LISTS.href);
	const titles = listTitles(
		"https://neurips.cc/static/virtual/data/neurips-2026-orals-posters.json",
		listFixture("neurips.json"),
	);
	assert.deepEqual(titles, [
		"The Power of a Random Sample in Online Algorithms",
		"No Model Required: Text Entropy Rate Filtering Prevents Iterative Fine-Tuning Collapse",
		"Sublinear Variational Optimization of Gaussian Mixture Models with Millions to Billions of Parameters",
	]);
});

test("A page in none of the known formats gives no titles", async () => {
	const { listTitles }: typeof VenueLists = await import(VENUE_LISTS.href);
	const page = [
		"<!doctype html>",
		'<html lang="en"><head><title>COLM 2026 Accepted Papers</title></head><body>',
		'<div class="paper"><span class="paper-title">Activation Steering for Long Documents</span></div>',
		"</body></html>",
	].join("\n");
	assert.deepEqual(
		listTitles("https://colmweb.org/AcceptedPapers.html", page),
		[],
	);
});

// ---- CSV (RFC 4180) ----

test("CSV: quoted fields keep their commas, doubled quotes and line breaks", async () => {
	const { parseCsv }: typeof VenueLists = await import(VENUE_LISTS.href);
	const text =
		'Paper ID,Title\n31,"Celebrity Data, Fan Cultures"\n29,"Says ""vulnerable"" here\nand goes on"\n';
	assert.deepEqual(parseCsv(text), [
		["Paper ID", "Title"],
		["31", "Celebrity Data, Fan Cultures"],
		["29", 'Says "vulnerable" here\nand goes on'],
	]);
});

test("CSV: empty fields, CRLF line ends, and a last record with or without a line break", async () => {
	const { parseCsv }: typeof VenueLists = await import(VENUE_LISTS.href);
	assert.deepEqual(parseCsv("a,,c\n"), [["a", "", "c"]]);
	assert.deepEqual(parseCsv("a,b\r\n1,2\r\n"), [
		["a", "b"],
		["1", "2"],
	]);
	assert.deepEqual(parseCsv("a,b\n1,2"), [
		["a", "b"],
		["1", "2"],
	]);
});

test("CSV: the FAccT excerpt is a header and three records of four fields", async () => {
	const { parseCsv }: typeof VenueLists = await import(VENUE_LISTS.href);
	const rows = parseCsv(listFixture("facct.csv"));
	assert.equal(rows.length, 4);
	assert.deepEqual(rows[0], ["Paper ID", "Title", "Authors", "Abstract"]);
	const third = rows[2];
	assert.ok(third !== undefined, "a third row");
	assert.deepEqual(third.slice(0, 3), [
		"29",
		"From Vulnerable Data Subjects to Vulnerabilizing Data Practices: Navigating the Protection Paradox in AI-Based Analyses of Platformized Lives",
		"Delfina S. Martinez Pandiani; Ella Streefkerk; Laurens Naudts; Paula Helm",
	]);
	assert.equal(
		third[3],
		"We argue that the ethical integrity of data science depends not just on who is studied, but on how technical " +
			'pipelines transform "vulnerable" individuals into data subjects.\nWe develop this argument through an AI for ' +
			"Social Good (AI4SG) case.",
	);
});

// ---- Cutting ----

test('A text over the limit is cut to one character less than the limit and ends in "…", and a text that fits is left alone', async () => {
	const { cut }: typeof Interests = await import(INTERESTS_MODULE.href);
	assert.equal(cut("Sparse autoencoders", 10), "Sparse au…");
	assert.equal(cut("abcdef", 5), "abcd…");
	assert.equal(cut("abcde", 5), "abcde");
	assert.equal(cut("Short title", 100), "Short title");
});

// The feature's lengths: titles at 100 characters, venue notes at 60.
test("A 150-character title is cut to 100 characters and a 200-character venue note to 60", async () => {
	const { cut }: typeof Interests = await import(INTERESTS_MODULE.href);
	const title =
		"Sparse Autoencoder Features Reveal How Open Language Models Encode Refusal, Sycophancy and Deception Across Seven " +
		"Families of Chat Models Made in 2026";
	const comment =
		"Accepted at the NeurIPS 2026 Workshop on Mechanistic Interpretability; 31 pages, 14 figures and 9 tables; code, " +
		"trained dictionaries and evaluation data are released under an open licence for all uses";
	assert.equal(title.length, 150);
	assert.equal(comment.length, 200);
	assert.equal(
		cut(title, 100),
		"Sparse Autoencoder Features Reveal How Open Language Models Encode Refusal, Sycophancy and Deceptio…",
	);
	assert.equal(
		cut(comment, 60),
		"Accepted at the NeurIPS 2026 Workshop on Mechanistic Interp…",
	);
});

// ---- Venue notes: hasAcceptanceHint says whether a paper has one ----

// A paper as arxiv.ts reads it, with this comment and journal reference when given.
function paperWith(comment: string | null, journalRef: string | null): Paper {
	const found: Paper = {
		id: "arxiv:2609.10000",
		type: "paper",
		title: "Fixture paper for the venue note",
		authors: ["Ada Example"],
		published: "2026-09-30",
	};
	if (comment !== null) {
		found.comment = comment;
	}
	if (journalRef !== null) {
		found.journal_ref = journalRef;
	}
	return found;
}

// The venue note a comment gives a line (its ending is " | <note>"), or null where the line ends with its title.
const COMMENT_NOTES: [string, string | null][] = [
	["Accepted to ICML 2026", "Accepted to ICML 2026"],
	[
		"To appear in the Proceedings of AIES",
		"To appear in the Proceedings of AIES",
	],
	["COLM'26", "COLM'26"],
	["Published in TMLR", "Published in TMLR"],
	["12 pages, facct 2026 main track", "facct 2026 main track"],
	[
		"9 pages; Accepted at AIES 2026; code at github.com/x/y",
		"Accepted at AIES 2026",
	],
	["Under review at ICLR 2027", null],
	["Submitted to NeurIPS 2026", null],
	["In submission; code at github.com/x/y", null],
	["9 pages, 4 figures", null],
	["Compares GPT 2024 and Llama 3", null],
	["Under submission to NeurIPS 2026", null],
	["Code for our CHI 2026 submission", null],
	[
		"Accepted at ICML 2026; extended version under review at JMLR",
		"Accepted at ICML 2026",
	],
	["PoPETs 2026", "PoPETs 2026"],
	["USENIX Security 2026", "USENIX Security 2026"],
	["NeurIPS2026", "NeurIPS2026"],
];

for (const [comment, note] of COMMENT_NOTES) {
	test(`A comment "${comment}" and no journal reference: the venue note is ${JSON.stringify(note)}`, async () => {
		const { hasAcceptanceHint, venueNote }: typeof PoolModule = await import(
			POOL.href
		);
		assert.equal(venueNote(paperWith(comment, null)), note);
		assert.equal(hasAcceptanceHint(paperWith(comment, null)), note !== null);
	});
}

test("A journal reference gives a paper a venue note, whatever its comment", async () => {
	const { hasAcceptanceHint }: typeof PoolModule = await import(POOL.href);
	assert.equal(
		hasAcceptanceHint(
			paperWith(null, "Transactions on Machine Learning Research, 2026"),
		),
		true,
	);
	assert.equal(
		hasAcceptanceHint(
			paperWith("12 pages", "Proceedings of AIES 2026, pp. 101-115"),
		),
		true,
	);
});

test("A paper with neither a comment nor a journal reference has no venue note", async () => {
	const { hasAcceptanceHint }: typeof PoolModule = await import(POOL.href);
	assert.equal(hasAcceptanceHint(paperWith(null, null)), false);
});

// Title pairs for the looser match: the list's title, then arXiv's, as the two sites wrote them (2026-10-27), and
// whether they name the same paper. The last two are the near misses that must stay apart.
const NEAR_TITLES: [string, string, boolean][] = [
	[
		"Mechanistic Interpretability Should Prioritize Feature Consistency in SAEs",
		"Position: Mechanistic Interpretability Should Prioritize Feature Consistency in SAEs",
		true,
	],
	[
		"dX-Privacy for Text and the Curse of Dimensionality",
		"$d_X$-Privacy for Text and the Curse of Dimensionality",
		true,
	],
	[
		"Gaze3P: Gaze-Based Prediction of Perceived Privacy",
		"Gaze3P: Gaze-Based Prediction of User-Perceived Privacy",
		true,
	],
	[
		"Privacy vs Profit: The Impact of Google's Manifest Version 3",
		"Privacy vs. Profit: The Impact of Google's Manifest Version 3 (MV3)",
		true,
	],
	[
		"Who bears privacy risk in synthetic data?",
		"Who bears privacy risk in federated data?",
		false,
	],
	[
		"FHEON: A Configurable Framework for Developing Privacy-Preserving Encrypted Neural Networks",
		"FHEON: A Configurable Framework for Developing Privacy-Preserving Neural Networks Using Homomorphic Encryption",
		false,
	],
	["Privacy", "Privacy in Practice", false],
];

for (const [listed, arxiv, same] of NEAR_TITLES) {
	test(`The list title "${listed}" and the arXiv title "${arxiv}" name the same paper: ${same}`, async () => {
		const { titlesMatch }: typeof TitleMatch = await import(TITLE_MATCH.href);
		assert.equal(titlesMatch(listed, arxiv), same);
		assert.equal(titlesMatch(arxiv, listed), same);
	});
}

test("A title search by words asks arXiv for the four longest words of four letters or more, longest first", async () => {
	const { wordsQuery }: typeof TitleMatch = await import(TITLE_MATCH.href);
	assert.equal(
		wordsQuery("Privacy vs Profit: The Impact of Google's Manifest Version 3"),
		"ti:manifest AND ti:privacy AND ti:version AND ti:profit",
	);
	assert.equal(
		wordsQuery("$d_X$-Privacy for Text and the Curse of Dimensionality"),
		"ti:dimensionality AND ti:privacy AND ti:curse AND ti:text",
	);
	assert.equal(wordsQuery("Robust RAG"), "ti:robust");
	assert.equal(wordsQuery("AI vs ML"), "");
});

// A venue note against the venues of interests.md's conference lists: the name with no letter on either side, in any case.
const LISTED_VENUES = ["NeurIPS", "ACL", "ACL Findings", "PETS"];
const NOTES_NAMING_ONE = [
	"Accepted at NeurIPS 2026",
	"accepted at neurips 2026 (spotlight)",
	"NeurIPS2026",
	"Findings of ACL 2026",
	"Proceedings of ACL 2026",
];
const NOTES_NAMING_NONE = [
	"Accepted at EACL 2026",
	"NAACL 2026 main conference",
	"Springer CCIS, vol. 2104",
	"Accepted at APSEC 2026",
	"Transactions on Machine Learning Research, 2026",
];

for (const note of NOTES_NAMING_ONE) {
	test(`The venue note "${note}" names a listed conference`, async () => {
		const { namesListedVenue }: typeof PoolModule = await import(POOL.href);
		assert.equal(namesListedVenue(note, LISTED_VENUES), true);
	});
}

for (const note of NOTES_NAMING_NONE) {
	test(`The venue note "${note}" names no listed conference`, async () => {
		const { namesListedVenue }: typeof PoolModule = await import(POOL.href);
		assert.equal(namesListedVenue(note, LISTED_VENUES), false);
	});
}

test("No venue note names a conference when interests.md lists none", async () => {
	const { namesListedVenue }: typeof PoolModule = await import(POOL.href);
	assert.equal(namesListedVenue("Accepted at NeurIPS 2026", []), false);
});

// ---- News phrases ----

test("The News phrases section gives each topic its news phrases, read as Search phrases are", async () => {
	const { newsPhrases }: typeof Interests = await import(INTERESTS_MODULE.href);
	const markdown = INTERESTS.replace(
		"## Conferences",
		[
			"## News phrases",
			"Written for headlines.",
			"1. AI deception, chatbot & privacy",
			"",
			"## Conferences",
		].join("\n"),
	);
	assert.deepEqual(newsPhrases(markdown), [
		{ topic: 1, phrases: ["AI deception", "chatbot & privacy"] },
	]);
});

test("Without a News phrases section there are no news phrases", async () => {
	const { newsPhrases }: typeof Interests = await import(INTERESTS_MODULE.href);
	assert.equal(newsPhrases(INTERESTS), null);
});

// ---- Hugging Face papers in the pool ----

// A Hugging Face paper as scripts/scout/hugging-face/hugging-face.ts gives it, first submitted on 2026-10-27, with `upvotes`.
function huggingFacePaper(id: string, upvotes: number) {
	return {
		id: id,
		title: `Paper ${id}`,
		abstract: `Abstract ${id}.`,
		authors: ["Yoshua Bengio"],
		published: "2026-10-27",
		listed: "2026-10-30",
		upvotes: upvotes,
		fromList: false,
	};
}

test("A Hugging Face paper joins the pool with its upvotes and no topic, a paper already in the pool gains its upvotes, and one in the digests stays out", async () => {
	const { addHuggingFaceToPool }: typeof PoolModule = await import(POOL.href);
	const known = {
		id: "2610.00002",
		title: "Known",
		abstract: "",
		authors: [],
		published: "2026-10-20",
		note: null,
		topics: [5],
		firstSeen: "2026-10-21",
	};
	const pool: PoolModule.Pool = { "2610.00002": known };
	addHuggingFaceToPool(
		pool,
		[
			huggingFacePaper("2610.00001", 128),
			huggingFacePaper("2610.00002", 40),
			huggingFacePaper("2610.00003", 99),
		],
		new Set(["2610.00003"]),
		"2026-11-02",
	);
	assert.deepEqual(pool, {
		"2610.00001": {
			id: "2610.00001",
			title: "Paper 2610.00001",
			abstract: "Abstract 2610.00001.",
			authors: ["Yoshua Bengio"],
			published: "2026-10-27",
			note: null,
			topics: [],
			firstSeen: "2026-11-02",
			huggingFace: 128,
		},
		"2610.00002": Object.assign({}, known, { huggingFace: 40 }),
	});
});

test("Jev's topic is the number of the topic with the highest probability, and a tie goes to the one listed first", async () => {
	const { jevTopic }: typeof PoolModule = await import(POOL.href);
	assert.equal(jevTopic({ t1: 0.2, t5: 0.7, none: 0.1 }), 5);
	// A tie goes to the option Jev listed first.
	assert.equal(jevTopic({ t3: 0.5, t6: 0.5 }), 3);
});

test("A paper Jev puts on none of the topics, or hasn't scored, has no topic", async () => {
	const { jevTopic }: typeof PoolModule = await import(POOL.href);
	assert.equal(jevTopic({ t1: 0.1, none: 0.9 }), null);
	assert.equal(jevTopic(undefined), null);
	assert.equal(jevTopic({}), null);
});

// =====================================================================================================
// isPoolRecord: pool.json read as data
// =====================================================================================================
// "Records of the wrong shape are dropped and counted": the cache folder
// comes back from GitHub's cache, so each record of pool.json is checked, field by field, before the pool uses it.

// A whole record, every field present, as addToPool and scripts/scout/score.ts write it; its key in pool.json is its id.
const GOOD_POOL_ID = "2610.00042";
function goodRecord(): PoolModule.PoolRecord {
	return {
		id: GOOD_POOL_ID,
		title: "Sparse probes for deception",
		abstract:
			"We train sparse probes that find deception in a model's activations.",
		authors: ["Ada Lovelace", "Alan Turing"],
		published: "2026-10-20",
		note: "Accepted at NeurIPS 2026",
		topics: [1, 6],
		firstSeen: "2026-10-21",
		listed: "2026-10-30",
		huggingFace: 128,
		score: 3,
		confidence: 0.8,
		topicProbabilities: { t1: 0.7, t6: 0.2, none: 0.1 },
		weighted: 2.4,
		scoredOn: "2026-10-22",
	};
}

// The good record with its id (and so its key) changed.
function withId(id: string): PoolModule.PoolRecord {
	return Object.assign(goodRecord(), { id: id });
}

test("A whole record under its own id is a pool record", async () => {
	const { isPoolRecord }: typeof PoolModule = await import(POOL.href);
	assert.equal(isPoolRecord(GOOD_POOL_ID, goodRecord()), true);
});

// A proceedings paper's id is "doi:" or "url:" and the DOI or URL; an old-style arXiv id has a slash.
test("A record with a doi:, url: or old-style arXiv id is a pool record", async () => {
	const { isPoolRecord }: typeof PoolModule = await import(POOL.href);
	for (const id of [
		"doi:10.1145/3630106.3658900",
		"url:https://proceedings.mlr.press/v235/lovelace24a.html",
		"hep-th/9901001",
	]) {
		assert.equal(isPoolRecord(id, withId(id)), true, `the id ${id}`);
	}
});

test("A record is dropped when its id isn't its key, or isn't an id as the pool writes it", async () => {
	const { isPoolRecord }: typeof PoolModule = await import(POOL.href);
	assert.equal(
		isPoolRecord("2610.00043", goodRecord()),
		false,
		"the id differs from the key",
	);
	// The pool writes an arXiv id in normalizeId form: no "arxiv:" prefix, no version. A path is no id at all.
	for (const id of ["../x", "arxiv:2610.00042", "2507.11473v2"]) {
		assert.equal(isPoolRecord(id, withId(id)), false, `the id ${id}`);
	}
	assert.equal(isPoolRecord("2610.00042", null), false, "null");
	assert.equal(isPoolRecord("2610.00042", [goodRecord()]), false, "a list");
	assert.equal(isPoolRecord("2610.00042", "2610.00042"), false, "a string");
});

test("A record is dropped when a field has the wrong type", async () => {
	const { isPoolRecord }: typeof PoolModule = await import(POOL.href);
	const wrong: Record<string, unknown>[] = [
		{ title: 42 },
		{ topics: ["1"] },
		{ authors: [42] },
		{ score: "3" },
		{ published: 20261020 },
		{ firstSeen: null },
		{ note: 7 },
		{ topicProbabilities: { t1: "0.7" } },
		{ huggingFace: "128" },
	];
	for (const field of wrong) {
		const record = Object.assign(goodRecord(), field);
		assert.equal(
			isPoolRecord(GOOD_POOL_ID, record),
			false,
			`the field ${JSON.stringify(field)}`,
		);
	}
});

// An abstract is a few thousand characters: a text field of 20,000 is not a paper's.
test("A record is dropped when a text field is longer than 10,000 characters", async () => {
	const { isPoolRecord, POOL_FIELD_CHARS }: typeof PoolModule = await import(
		POOL.href
	);
	assert.equal(POOL_FIELD_CHARS, 10000);
	const longest = Object.assign(goodRecord(), {
		abstract: "x".repeat(POOL_FIELD_CHARS),
	});
	assert.equal(isPoolRecord(GOOD_POOL_ID, longest), true, "exactly the cap");
	const over = Object.assign(goodRecord(), {
		abstract: "x".repeat(POOL_FIELD_CHARS + 1),
	});
	assert.equal(isPoolRecord(GOOD_POOL_ID, over), false, "one over the cap");
	const twentyThousand = Object.assign(goodRecord(), {
		abstract: "x".repeat(20000),
	});
	assert.equal(isPoolRecord(GOOD_POOL_ID, twentyThousand), false, "20,000");
	const longTitle = Object.assign(goodRecord(), {
		title: "x".repeat(POOL_FIELD_CHARS + 1),
	});
	assert.equal(isPoolRecord(GOOD_POOL_ID, longTitle), false, "a long title");
	const longAuthor = Object.assign(goodRecord(), {
		authors: ["x".repeat(POOL_FIELD_CHARS + 1)],
	});
	assert.equal(isPoolRecord(GOOD_POOL_ID, longAuthor), false, "a long author");
});

// An earlier run's record may lack the fields later runs added; a note is null for a paper without a venue note.
test("A record without abstract or authors, with a null note and none of the scoring fields, is a pool record", async () => {
	const { isPoolRecord }: typeof PoolModule = await import(POOL.href);
	const record: Record<string, unknown> = {
		id: GOOD_POOL_ID,
		title: "Sparse probes for deception",
		published: "2026-10-20",
		note: null,
		topics: [1],
		firstSeen: "2026-10-21",
	};
	assert.equal(isPoolRecord(GOOD_POOL_ID, record), true);
});

// The fields a candidate line and the pruning read are never optional.
test("A record without an id, title, published, firstSeen or topics is dropped", async () => {
	const { isPoolRecord }: typeof PoolModule = await import(POOL.href);
	for (const field of ["title", "published", "firstSeen", "topics", "id"]) {
		const record: Record<string, unknown> = goodRecord();
		delete record[field];
		assert.equal(isPoolRecord(GOOD_POOL_ID, record), false, `without ${field}`);
	}
});

// ---- --cached: the kept output without the papers now in the digests ----

// A kept output as the plan prints it: headers with their counts, candidate lines "<date> <id> <title>...", a news
// line "<date> <source>: <headline>", "none" under an empty header, and a trailing newline.
const KEPT_OUTPUT = [
	"topic 1 (3 found):",
	"2026-10-20 2606.33333 Sparse probes for deception",
	"2026-10-18 2606.44444 Steering vectors at scale | Accepted at NeurIPS 2026",
	"2026-10-17 doi:10.1/x Private Set Intersection for Ad Measurement",
	"topic 2 (0 found):",
	"none",
	"news, topic 1 (1 found):",
	"2026-11-04 Reuters: Headline about probes",
	"titles still to look up: 0",
	"",
].join("\n");

test("--cached leaves out the candidate lines whose id is now in the digests, arXiv or doi:, and keeps the rest", async () => {
	const { withoutDigested }: typeof Search = await import(SCRIPT.href);
	assert.equal(
		withoutDigested(KEPT_OUTPUT, new Set(["2606.33333", "doi:10.1/x"])),
		[
			"topic 1 (3 found):",
			"2026-10-18 2606.44444 Steering vectors at scale | Accepted at NeurIPS 2026",
			"topic 2 (0 found):",
			"none",
			"news, topic 1 (1 found):",
			"2026-11-04 Reuters: Headline about probes",
			"titles still to look up: 0",
			"",
		].join("\n"),
	);
});

test("--cached prints the kept text whole, trailing newline included, when none of its papers is in the digests", async () => {
	const { withoutDigested }: typeof Search = await import(SCRIPT.href);
	assert.equal(withoutDigested(KEPT_OUTPUT, new Set()), KEPT_OUTPUT);
	assert.equal(
		withoutDigested(KEPT_OUTPUT, new Set(["2606.55555", "doi:10.1/other"])),
		KEPT_OUTPUT,
		"ids of other papers drop nothing",
	);
});

test("A news line is never dropped, even when the digests hold its source word", async () => {
	const { withoutDigested }: typeof Search = await import(SCRIPT.href);
	const text =
		"news, topic 1 (1 found):\n2026-11-04 Reuters: Headline about probes\n";
	assert.equal(withoutDigested(text, new Set(["Reuters:", "Reuters"])), text);
});

test("A header keeps its count when the lines under it are dropped", async () => {
	const { withoutDigested }: typeof Search = await import(SCRIPT.href);
	const text =
		"topic 1 (1 found, 1 in the digests):\n2026-10-20 2606.33333 Sparse probes for deception\n";
	assert.equal(
		withoutDigested(text, new Set(["2606.33333"])),
		"topic 1 (1 found, 1 in the digests):\n",
	);
});

test("A candidate line with a versioned id is dropped by its normalized id", async () => {
	const { withoutDigested }: typeof Search = await import(SCRIPT.href);
	const text =
		"topic 1 (2 found):\n2026-10-20 2606.33333v2 Sparse probes for deception\n2026-10-18 2606.44444 Steering vectors at scale\n";
	assert.equal(
		withoutDigested(text, new Set(["2606.33333"])),
		"topic 1 (2 found):\n2026-10-18 2606.44444 Steering vectors at scale\n",
	);
});

// A refused search is asked again before the scout gives up.
// A local stand-in answers every request with arXiv's "Rate exceeded." (HTTP 429). askArxiv waits with the timers/promises
// setTimeout, which Vitest's fake clock doesn't replace (measured: a 60 s wait stays pending after advancing 61 s), so
// the minute is shortened to 100 ms through ARXIV_RETRY_MINUTE_MS at the top of this file.
test("limit: A refused search waits 1, 2, 4 and 8 minutes and asks arXiv five times in all", async () => {
	const { askArxiv }: typeof ArxivSearch = await import(ARXIV_SEARCH.href);
	const arrivals: number[] = [];
	const server = http.createServer((_request, response) => {
		arrivals.push(performance.now());
		response.writeHead(429, { "Content-Type": "text/plain" });
		response.end("Rate exceeded.");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(
		address !== null && typeof address === "object",
		"the server listens on a port",
	);
	allowLocal(address.port);
	const url = `http://127.0.0.1:${address.port}/api/query?search_query=all:test`;
	const printed = console.error;
	console.error = () => {};
	try {
		const answer = await askArxiv(url);

		assert.equal(answer.problem, undefined);
		assert.equal(arrivals.length, 5, "arXiv was asked five times in all");
		const waitsInMinutes = arrivals
			.slice(1)
			.map(
				(arrival, index) => (arrival - (arrivals[index] ?? 0)) / TEST_MINUTE_MS,
			);
		// A timer may fire a millisecond early, so each wait is allowed 5% under its minutes.
		for (const [index, expected] of [1, 2, 4, 8].entries()) {
			const waited = waitsInMinutes[index] ?? 0;
			assert.ok(
				waited >= expected * 0.95,
				`retry ${index + 1} came after ${waited} minutes, expected ${expected}`,
			);
		}
	} finally {
		console.error = printed;
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
});

test.todo(
	"NeurIPS's accepted list is read whole at 22 MB, above the 20 MiB every other download is held to",
);
test.todo(
	"a conference list above its own larger limit is still refused and named",
);
