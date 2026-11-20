// Unit tests for the exports of scripts/scout/arxiv/api.ts: the parsers against saved arXiv answers, and arxivRequest's pacing
// record against a local server. Nothing here contacts arXiv. Expected decoded text is written out by hand, never computed
// by a decoder of the test's own.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, test, vi } from "vitest";
import { idsInText } from "../../scripts/digests/digests-file.ts";
import type * as Arxiv from "../../scripts/scout/arxiv/api.ts";
import type { Paper } from "../../scripts/scout/arxiv/api.ts";
import type { JsonObject } from "../../shared/narrow.ts";
import { allowLocal } from "./local-server.ts";

const SCRIPT = new URL("../../scripts/scout/arxiv/api.ts", import.meta.url);
const fixture = (name: string) =>
	readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

// The script keeps its pacing records under os.tmpdir(), which follows TMPDIR. TMPDIR points at a fresh folder before the
// script is first imported: the tests import it later, after this module's top level has run (as setting os.environ
// before the first `import` in Python). The folder is deleted when this file's tests end.
const TEST_TMPDIR = mkdtempSync(join(tmpdir(), "liminal-unit-arxiv-"));
process.env.TMPDIR = TEST_TMPDIR;
// The same way, the pause between requests is 1 s instead of arXiv's 3 s.
const PAUSE_MS = 1000;
process.env.ARXIV_PAUSE_MS = String(PAUSE_MS);
afterAll(() => {
	rmSync(TEST_TMPDIR, { recursive: true, force: true });
});
const PACING_DIR = join(TEST_TMPDIR, "liminal-arxiv-pacing");
// A stand-in for OAI-PMH that answers HTTP 503, its address set before the script is first imported.
const OAI_STAND_IN = http.createServer((_request, response) => {
	response.writeHead(503);
	response.end();
});
await new Promise<void>((resolve) =>
	OAI_STAND_IN.listen(0, "127.0.0.1", resolve),
);
allowLocal((OAI_STAND_IN.address() as AddressInfo).port);
process.env.ARXIV_OAI = `http://127.0.0.1:${(OAI_STAND_IN.address() as AddressInfo).port}/oai`;
afterAll(() => {
	OAI_STAND_IN.close();
});

// Real response for 2507.11473 (feed id carries "v2", primary category cs.AI, also cs.LG and stat.ML, 41 authors).
const REAL = fixture("arxiv-2507.11473.xml");
// Crafted response: entities and line breaks in title/abstract, "v3" id, primary cs.LG listed after cs.AI.
const ENTITIES = fixture("arxiv-entities.xml");

// The saved 2507.11473 entry, written out by hand. Its title, names and abstract hold no XML entities and no runs of
// whitespace, so the text in the file is the text the entry must hold.
const COT_TITLE =
	"Chain of Thought Monitorability: A New and Fragile Opportunity for AI Safety";
const COT_AUTHORS = [
	"Tomek Korbak",
	"Mikita Balesni",
	"Elizabeth Barnes",
	"Yoshua Bengio",
	"Joe Benton",
	"Joseph Bloom",
	"Mark Chen",
	"Alan Cooney",
	"Allan Dafoe",
	"Anca Dragan",
	"Scott Emmons",
	"Owain Evans",
	"David Farhi",
	"Ryan Greenblatt",
	"Dan Hendrycks",
	"Marius Hobbhahn",
	"Evan Hubinger",
	"Geoffrey Irving",
	"Erik Jenner",
	"Daniel Kokotajlo",
	"Victoria Krakovna",
	"Shane Legg",
	"David Lindner",
	"David Luan",
	"Aleksander Mądry",
	"Julian Michael",
	"Neel Nanda",
	"Dave Orr",
	"Jakub Pachocki",
	"Ethan Perez",
	"Mary Phuong",
	"Fabien Roger",
	"Joshua Saxe",
	"Buck Shlegeris",
	"Martín Soto",
	"Eric Steinberger",
	"Jasmine Wang",
	"Wojciech Zaremba",
	"Bowen Baker",
	"Rohin Shah",
	"Vlad Mikulik",
];
const COT_ABSTRACT =
	'AI systems that "think" in human language offer a unique opportunity for AI safety: we can monitor their chains of ' +
	"thought (CoT) for the intent to misbehave. Like all other known AI oversight methods, CoT monitoring is imperfect " +
	"and allows some misbehavior to go unnoticed. Nevertheless, it shows promise and we recommend further research into " +
	"CoT monitorability and investment in CoT monitoring alongside existing safety methods. Because CoT monitorability " +
	"may be fragile, we recommend that frontier model developers consider the impact of development decisions on CoT " +
	"monitorability.";

// The order of an entry's keys in the written JSON, for a paper with no journal_ref, comment, pick or venue.
const PLAIN_KEYS = [
	"id",
	"type",
	"title",
	"authors",
	"published",
	"source",
	"category",
	"url",
	"links",
	"abstract",
];

// The first entry parseFeed gave; the test fails here when it gave none.
function firstEntry(entries: Paper[]): Paper {
	const entry = entries[0];
	assert.ok(entry !== undefined, "the feed gives an entry");
	return entry;
}

// The entry's abstract; the test fails here when it has none.
function abstractOf(entry: Paper): string {
	const abstract = entry.abstract;
	assert.ok(abstract !== undefined, "the entry has an abstract");
	return abstract;
}

test("An arXiv API answer becomes an entry with every field copied exactly and its keys in the written order", async () => {
	const { parseFeed }: typeof Arxiv = await import(SCRIPT.href);
	const entries = parseFeed(REAL);

	assert.equal(entries.length, 1);
	assert.deepEqual(entries[0], {
		id: "arxiv:2507.11473",
		type: "paper",
		title: COT_TITLE,
		authors: COT_AUTHORS,
		published: "2025-07-15",
		source: "arXiv Artificial Intelligence",
		category: "cs.AI",
		url: "https://arxiv.org/abs/2507.11473",
		links: [{ label: "PDF", url: "https://arxiv.org/pdf/2507.11473" }],
		abstract: COT_ABSTRACT,
	});
	assert.equal(
		COT_AUTHORS.length,
		41,
		"the hand-written list is the full list",
	);
	assert.deepEqual(Object.keys(firstEntry(entries)), PLAIN_KEYS);
});

// The saved 2507.11473 answer with its primary category set to `code`. Only <arxiv:primary_category> changes, so the
// first-listed category stays cs.AI.
function withPrimaryCategory(code: string) {
	return craft(
		REAL,
		'<arxiv:primary_category term="cs.AI"/>',
		`<arxiv:primary_category term="${code}"/>`,
	);
}

test("The source names the primary category in full, not the first-listed one, and the entry keeps its code", async () => {
	const { categoryName, parseFeed }: typeof Arxiv = await import(SCRIPT.href);

	assert.equal(categoryName("cs.AI"), "Artificial Intelligence");
	assert.equal(categoryName("cs.LG"), "Machine Learning");
	assert.equal(categoryName("stat.ML"), "Machine Learning");
	assert.equal(categoryName("cs.CL"), "Computation and Language");
	assert.equal(categoryName("cs.CR"), "Cryptography and Security");
	assert.equal(categoryName("cs.CY"), "Computers and Society");

	const entry = firstEntry(parseFeed(REAL));
	assert.equal(entry.source, "arXiv Artificial Intelligence");
	assert.equal(entry.category, "cs.AI");

	// The primary category wins over the first-listed one.
	const listedSecond = firstEntry(parseFeed(ENTITIES));
	assert.equal(listedSecond.source, "arXiv Machine Learning");
	assert.equal(listedSecond.category, "cs.LG");
});

test("Two categories with the same name, cs.LG and stat.ML, stay apart by their code", async () => {
	const { parseFeed }: typeof Arxiv = await import(SCRIPT.href);

	for (const code of ["cs.LG", "stat.ML"]) {
		const entry = firstEntry(parseFeed(withPrimaryCategory(code)));
		assert.equal(entry.source, "arXiv Machine Learning", code);
		assert.equal(entry.category, code);
	}
});

test("A category missing from arXiv's list of categories keeps its code in the source and in the category", async () => {
	const { parseFeed }: typeof Arxiv = await import(SCRIPT.href);
	const entry = firstEntry(parseFeed(withPrimaryCategory("cs.XX")));

	assert.equal(entry.source, "arXiv cs.XX");
	assert.equal(entry.category, "cs.XX");
});

// The order of an entry's keys when arXiv names no primary category: PLAIN_KEYS without "category".
const KEYS_WITHOUT_CATEGORY = [
	"id",
	"type",
	"title",
	"authors",
	"published",
	"source",
	"url",
	"links",
	"abstract",
];

test('An entry without a primary category has "arXiv" alone as its source and no category field', async () => {
	const { parseFeed }: typeof Arxiv = await import(SCRIPT.href);
	// Only <arxiv:primary_category> goes. The <category> elements stay, so the first-listed one (cs.AI) is still in the
	// answer and must not stand in for the missing primary one.
	const feed = craft(REAL, '\n    <arxiv:primary_category term="cs.AI"/>', "");
	assert.ok(!feed.includes("primary_category"), "no primary category is left");
	assert.ok(
		feed.includes('<category term="cs.AI"'),
		"the listed categories stay",
	);

	const entries = parseFeed(feed);
	assert.equal(entries.length, 1);
	const entry = firstEntry(entries);
	assert.equal(entry.source, "arXiv");
	assert.equal(Object.hasOwn(entry, "category"), false);
	assert.deepEqual(Object.keys(entry), KEYS_WITHOUT_CATEGORY);
	// The rest is the saved paper's.
	assert.equal(entry.id, "arxiv:2507.11473");
	assert.equal(entry.title, COT_TITLE);
	assert.deepEqual(entry.authors, COT_AUTHORS);
});

// The feature's examples: a title's text as it stands in the feed, and the title the entry must hold.
const DECODING_EXAMPLES = [
	{ inFeed: "Fish &amp; Chips", inEntry: "Fish & Chips" },
	{ inFeed: "x &lt; y &gt; z", inEntry: "x < y > z" },
	{ inFeed: "&quot;Quoted&quot; &apos;too&apos;", inEntry: "\"Quoted\" 'too'" },
	{
		inFeed: "&amp;lt;b&amp;gt; stays escaped",
		inEntry: "&lt;b&gt; stays escaped",
	},
	{ inFeed: "Caf&#xE9; &#946;-VAE", inEntry: "Café β-VAE" },
];

test("XML entities in an arXiv title are decoded exactly once", async () => {
	const { parseFeed }: typeof Arxiv = await import(SCRIPT.href);

	for (const example of DECODING_EXAMPLES) {
		const feed = craft(
			REAL,
			`<title>${COT_TITLE}</title>`,
			`<title>${example.inFeed}</title>`,
		);
		assert.equal(
			firstEntry(parseFeed(feed)).title,
			example.inEntry,
			example.inFeed,
		);
	}
});

test("An arXiv id loses its arxiv: prefix and its version, in the entry's id, page and PDF link", async () => {
	const { normalizeId, parseFeed }: typeof Arxiv = await import(SCRIPT.href);

	assert.equal(normalizeId("arxiv:2507.11473v2"), "2507.11473");
	assert.equal(normalizeId("2507.11473v2"), "2507.11473");
	assert.equal(normalizeId("arxiv:2507.11473"), "2507.11473");
	assert.equal(normalizeId("2507.11473"), "2507.11473");

	// Feed ids carry a version ("…/abs/2401.01234v3"); entries must not.
	const entry = firstEntry(parseFeed(ENTITIES));
	assert.equal(entry.id, "arxiv:2401.01234");
	assert.equal(entry.url, "https://arxiv.org/abs/2401.01234");
	assert.deepEqual(entry.links, [
		{ label: "PDF", url: "https://arxiv.org/pdf/2401.01234" },
	]);
});

test("Entities and line breaks in the title and abstract become plain one-line text", async () => {
	const { parseFeed }: typeof Arxiv = await import(SCRIPT.href);
	const entry = firstEntry(parseFeed(ENTITIES));

	assert.equal(
		entry.title,
		"Reward Hacking & Specification Gaming: Detection & Mitigation",
	);
	assert.ok(!entry.title.includes("&amp;"));
	assert.equal(
		entry.abstract,
		'We study agents that exploit "loopholes" when reward < intent. Our method flags such behaviour & corrects it.',
	);
	assert.deepEqual(entry.authors, ["Ada Example", "Bo Sample"]);
	assert.equal(entry.published, "2024-01-03");
});

// =====================================================================================================
// 1. Venue: journal_ref and comment, old-style ids.
// =====================================================================================================

// Real response for hep-th/9901001: old-style id, feed id carries "v3", has <arxiv:comment> and <arxiv:journal_ref>, and a DOI link.
const HEP_TH = fixture("arxiv-hep-th-9901001.xml");
// Real response for 1706.03762: has <arxiv:comment>, no <arxiv:journal_ref>.
const ATTENTION = fixture("arxiv-1706.03762.xml");
// Crafted response: entities, line breaks and runs of spaces inside <arxiv:comment> and <arxiv:journal_ref>.
const VENUE_ENTITIES = fixture("arxiv-venue-entities.xml");

test("Journal reference and comment are copied", async () => {
	const arxiv: typeof Arxiv = await import(SCRIPT.href);
	const entry = firstEntry(arxiv.parseFeed(HEP_TH));

	assert.equal(entry.journal_ref, "Prog.Theor.Phys.101:1155-1164,1999");
	assert.equal(
		entry.comment,
		"13 pages + 4 eps figures, PTPTeX, typographical errors corrected",
	);
	assert.equal(entry.category, "hep-th");
	// journal_ref, then comment, after the abstract.
	assert.deepEqual(
		Object.keys(entry),
		PLAIN_KEYS.concat(["journal_ref", "comment"]),
	);
});

test("Entities and runs of whitespace in the journal reference and comment are decoded and collapsed", async () => {
	const arxiv: typeof Arxiv = await import(SCRIPT.href);
	const entry = firstEntry(arxiv.parseFeed(VENUE_ENTITIES));

	assert.equal(entry.journal_ref, "A&A 600, A1 (2017)");
	assert.equal(
		entry.comment,
		'12 pages, 3 figures; accepted at the <Agents> workshop & "SafeML"',
	);
});

test("A journal reference or comment that arXiv leaves out or leaves blank is left out of the entry", async () => {
	const arxiv: typeof Arxiv = await import(SCRIPT.href);

	// Neither element: neither key.
	const neither = firstEntry(arxiv.parseFeed(REAL));
	assert.equal(Object.hasOwn(neither, "journal_ref"), false);
	assert.equal(Object.hasOwn(neither, "comment"), false);

	// A comment but no journal reference: only the comment key.
	const commentOnly = firstEntry(arxiv.parseFeed(ATTENTION));
	assert.equal(commentOnly.comment, "15 pages, 5 figures");
	assert.equal(Object.hasOwn(commentOnly, "journal_ref"), false);

	// Both elements present but empty or blank: the data contract says "absent when empty", so neither key.
	const blank = REAL.replace(
		"<arxiv:primary_category",
		"<arxiv:comment>  \n   </arxiv:comment>\n    <arxiv:journal_ref></arxiv:journal_ref>\n    <arxiv:primary_category",
	);
	assert.notEqual(blank, REAL);
	const blankOnly = firstEntry(arxiv.parseFeed(blank));
	assert.equal(Object.hasOwn(blankOnly, "journal_ref"), false);
	assert.equal(Object.hasOwn(blankOnly, "comment"), false);
});

test("An old-style id such as hep-th/9901001 keeps its archive and loses its version in the id, page and PDF link", async () => {
	const arxiv: typeof Arxiv = await import(SCRIPT.href);

	assert.equal(arxiv.normalizeId("hep-th/9901001"), "hep-th/9901001");
	assert.equal(arxiv.normalizeId("arxiv:hep-th/9901001v3"), "hep-th/9901001");

	// The feed's id and PDF link carry "v3"; the entry's must not. The DOI link is not a PDF link.
	const entry = firstEntry(arxiv.parseFeed(HEP_TH));
	assert.equal(entry.id, "arxiv:hep-th/9901001");
	assert.equal(entry.url, "https://arxiv.org/abs/hep-th/9901001");
	assert.deepEqual(entry.links, [
		{ label: "PDF", url: "https://arxiv.org/pdf/hep-th/9901001" },
	]);
	assert.equal(
		entry.title,
		"String Junctions and Their Duals in Heterotic String Theory",
	);
	assert.equal(entry.published, "1999-01-01");
});

// =====================================================================================================
// 2. Surprise pick: no pure export to test; the feature's CLI scenarios cover --pick.
// =====================================================================================================

// =====================================================================================================
// 3. Duplicate ids: idsInText, and normalizeId with a prefix in any case.
// =====================================================================================================

// One digests.js line, written the way the script writes it.
function digestLine(entries: JsonObject[]) {
	return `digest(${JSON.stringify({ date: "2026-09-20", entries: entries })});\n`;
}

// A made-up entry; idsInText only looks at the id.
function entryWithId(id: string, type: string): JsonObject {
	return {
		id: id,
		type: type,
		title: `Entry ${id}`,
		authors: [],
		published: "2026-09-20",
		source: "Fixture",
		url: "https://example.com/",
		links: [],
	};
}

test("The ids already in the file include every arXiv paper on every line", () => {
	const text =
		digestLine([
			entryWithId("arxiv:2507.11473", "paper"),
			entryWithId("arxiv:1706.03762", "paper"),
		]) + digestLine([entryWithId("arxiv:hep-th/9901001", "paper")]);

	assert.deepEqual(
		idsInText(text).arxiv,
		new Set(["2507.11473", "1706.03762", "hep-th/9901001"]),
	);
});

test("The ids already in the file are found when spaces surround the colons", () => {
	const text =
		'digest({ "date" : "2026-09-21", "entries" : [ { "id" : "arxiv:2303.08774", "type" : "paper" } ] });\n' +
		'digest({"date": "2026-09-22", "entries": [{"id": "arxiv:math.GT/0309136", "type": "paper"}]});\n';

	assert.deepEqual(
		idsInText(text).arxiv,
		new Set(["2303.08774", "math.GT/0309136"]),
	);
});

test("A prefix or version does not hide a duplicate", async () => {
	const arxiv: typeof Arxiv = await import(SCRIPT.href);
	const text = digestLine([
		entryWithId("arxiv:2507.11473v2", "paper"),
		entryWithId("arxiv:hep-th/9901001v3", "paper"),
	]);

	assert.deepEqual(
		idsInText(text).arxiv,
		new Set(["2507.11473", "hep-th/9901001"]),
	);

	// Ids given on the command line are normalized the same way, with the prefix in any case.
	assert.equal(arxiv.normalizeId("arXiv:2507.11473v2"), "2507.11473");
	assert.equal(arxiv.normalizeId("ARXIV:2507.11473"), "2507.11473");
});

test("News, article and DOI ids in the file are not counted as arXiv ids", () => {
	// The url: id points at an arXiv page, yet it is not a paper entry.
	const text = digestLine([
		entryWithId("news:fixture-1", "news"),
		entryWithId("url:https://arxiv.org/abs/2303.08774", "article"),
		entryWithId("doi:10.1143/PTP.101.1155", "paper"),
		entryWithId("arxiv:1706.03762", "paper"),
	]);

	assert.deepEqual(idsInText(text).arxiv, new Set(["1706.03762"]));
});

test("An arXiv id cited in a title or abstract is not counted as an id in the file", () => {
	// Prose can cite a paper by id, even as the literal text "id":"arxiv:..." (JSON escapes its quotes in the file).
	const citing = entryWithId("arxiv:1706.03762", "paper");
	citing.title = "A reply to arxiv:2303.08774";
	citing.abstract =
		'We build on "id":"arxiv:2507.11473" and on arXiv:hep-th/9901001v3.';

	assert.deepEqual(
		idsInText(digestLine([citing])).arxiv,
		new Set(["1706.03762"]),
	);
});

test("An empty file holds no ids", () => {
	assert.deepEqual(idsInText("").arxiv, new Set());
});

// =====================================================================================================
// 4. Bad ids: isArxivId and rejectedId.
// =====================================================================================================

// Real HTTP 400 body for id_list=not-an-id: an error entry naming the id.
const ERROR_400 = fixture("arxiv-error-400.xml");
// Real HTTP 400 body for id_list=2507.11473&start=-1: an error entry that names no id.
const ERROR_400_NO_ID = fixture("arxiv-error-400-no-id.xml");

test("New-style and old-style arXiv ids pass the format check", async () => {
	const arxiv: typeof Arxiv = await import(SCRIPT.href);
	const valid = [
		"2507.11473", // new style, 5 digits after the dot
		"0706.0001", // new style, 4 digits after the dot
		"1706.03762",
		"hep-th/9901001", // old style: archive with a hyphen
		"math/0211159",
		"cond-mat/0102536",
		"math.GT/0309136", // old style with a subject class
		"2507.1147", // 4 digits after the dot: the format check allows it; arXiv then answers "not found"
	];
	for (const id of valid) {
		assert.equal(arxiv.isArxivId(id), true, id);
	}
});

test("Any other text fails the arXiv id format check, including a URL, a version or a prefix", async () => {
	const arxiv: typeof Arxiv = await import(SCRIPT.href);
	const invalid = [
		"not-an-id",
		"https://arxiv.org/abs/2507.11473",
		"",
		"2507.114735", // 6 digits after the dot
		"250.11473", // 3 digits before the dot
		"2507.11473v2", // not normalized: version still on
		"arxiv:2507.11473", // not normalized: prefix still on
		"hep-th/990100", // 6 digits after the slash
		"hep-th9901001", // no slash
		"HEP-TH/9901001", // archive must be lowercase
		"math.gt/0309136", // subject class must be two uppercase letters
	];
	for (const id of invalid) {
		assert.equal(arxiv.isArxivId(id), false, JSON.stringify(id));
	}
});

test("The id that arXiv rejects is read from its error feed", async () => {
	const arxiv: typeof Arxiv = await import(SCRIPT.href);

	assert.equal(arxiv.rejectedId(ERROR_400), "not-an-id");
	// The same body with another id swapped in, as the stand-in API sends it in the feature.
	assert.equal(
		arxiv.rejectedId(ERROR_400.replaceAll("not-an-id", "2507.11473")),
		"2507.11473",
	);
});

test("An error feed that names no id, or a normal feed, gives no rejected id", async () => {
	const arxiv: typeof Arxiv = await import(SCRIPT.href);

	assert.equal(arxiv.rejectedId(ERROR_400_NO_ID), null);
	// A normal feed is no error at all.
	assert.equal(arxiv.rejectedId(REAL), null);
});

// =====================================================================================================
// 5. OAI-PMH fallback: parseOaiRecord(arxivXml, rawXml, id) builds the same entry parseFeed builds from the API.
// Saved GetRecord answers: the "arXiv" format holds the metadata, "arXivRaw" every version's date.
// =====================================================================================================

const oaiRecords = (name: string): [string, string] => [
	fixture(`oai-${name}-arXiv.xml`),
	fixture(`oai-${name}-arXivRaw.xml`),
];

// Replace `needle` in a saved record, failing if it isn't there (so a crafted record never silently equals the real one).
function craft(text: string, needle: string, replacement: string) {
	assert.ok(text.includes(needle), `the record holds ${needle}`);
	return text.replace(needle, replacement);
}

// 2507.11473: API feed and OAI records saved in the same session; no comment, no journal reference.
const FRESH = fixture("arxiv-api-2507.11473-fresh.xml");
const [COT_ARXIV, COT_RAW] = oaiRecords("2507.11473");
// 1706.03762: a comment, no journal reference, 7 versions, an author with a middle initial ("Aidan N. Gomez").
const [ATTENTION_ARXIV, ATTENTION_RAW] = oaiRecords("1706.03762");
// hep-th/9711200: old-style id, comment and journal-ref, 3 versions; v1 is 27 Nov 1997 23:53:13 GMT (28 Nov in Jakarta).
const [MALDACENA_ARXIV, MALDACENA_RAW] = oaiRecords("hep-th-9711200");
// 2610.00003: categories "cs.CV cs.AI cs.LG cs.RO", a comment; v1 is 21 May 2026 20:25:20 GMT (22 May in Jakarta).
const [STATERA_ARXIV, STATERA_RAW] = oaiRecords("2610.00003");

test("An entry from OAI-PMH equals the entry from the API", async () => {
	const arxiv: typeof Arxiv = await import(SCRIPT.href);
	const fromApi = firstEntry(arxiv.parseFeed(FRESH));
	const fromOai = arxiv.parseOaiRecord(COT_ARXIV, COT_RAW, "2507.11473");

	assert.deepStrictEqual(fromOai, fromApi);
	// deepStrictEqual ignores key order; the written JSON doesn't.
	assert.deepEqual(Object.keys(fromOai), Object.keys(fromApi));
	assert.equal(fromOai.category, "cs.AI");
	// Spot checks against the record itself: a non-ASCII name, and "&#34;" decoded in the abstract.
	assert.equal(fromOai.authors.length, 41);
	assert.ok(fromOai.authors.includes("Aleksander Mądry"));
	assert.ok(fromOai.authors.includes("Martín Soto"));
	assert.ok(
		abstractOf(fromOai).startsWith('AI systems that "think" in human language'),
	);
});

test("An entry from OAI-PMH equals the entry from the API for a paper with a comment", async () => {
	const arxiv: typeof Arxiv = await import(SCRIPT.href);
	const fromApi = firstEntry(arxiv.parseFeed(ATTENTION));
	const fromOai = arxiv.parseOaiRecord(
		ATTENTION_ARXIV,
		ATTENTION_RAW,
		"1706.03762",
	);

	assert.deepStrictEqual(fromOai, fromApi);
	assert.deepEqual(Object.keys(fromOai), Object.keys(fromApi));
	assert.equal(fromOai.comment, "15 pages, 5 figures");
	assert.equal(fromOai.authors[5], "Aidan N. Gomez");
	assert.equal(fromOai.published, "2017-06-12");
});

test("From OAI-PMH, the published date is the first version's date in UTC", async () => {
	const arxiv: typeof Arxiv = await import(SCRIPT.href);

	// v1, not v3 (1998-01-22) nor the "arXiv" format's <created> (1998-01-22); and the UTC day, not Jakarta's.
	assert.equal(
		arxiv.parseOaiRecord(MALDACENA_ARXIV, MALDACENA_RAW, "hep-th/9711200")
			.published,
		"1997-11-27",
	);
	// v1 at 20:25 GMT: the UTC day, not the <created> date (2026-05-21 too) or Jakarta's 2026-05-22.
	assert.equal(
		arxiv.parseOaiRecord(STATERA_ARXIV, STATERA_RAW, "2610.00003").published,
		"2026-05-21",
	);
});

test("The primary category is the first one OAI-PMH lists", async () => {
	const arxiv: typeof Arxiv = await import(SCRIPT.href);

	// <categories>cs.CV cs.AI cs.LG cs.RO</categories>
	const statera = arxiv.parseOaiRecord(
		STATERA_ARXIV,
		STATERA_RAW,
		"2610.00003",
	);
	assert.equal(statera.source, "arXiv Computer Vision and Pattern Recognition");
	assert.equal(statera.category, "cs.CV");
	// <categories>cs.AI cs.LG stat.ML</categories>
	const cot = arxiv.parseOaiRecord(COT_ARXIV, COT_RAW, "2507.11473");
	assert.equal(cot.source, "arXiv Artificial Intelligence");
	assert.equal(cot.category, "cs.AI");
	// <categories>cs.CL cs.LG</categories>
	const attention = arxiv.parseOaiRecord(
		ATTENTION_ARXIV,
		ATTENTION_RAW,
		"1706.03762",
	);
	assert.equal(attention.source, "arXiv Computation and Language");
	assert.equal(attention.category, "cs.CL");
	// <categories>hep-th</categories>
	assert.equal(
		arxiv.parseOaiRecord(MALDACENA_ARXIV, MALDACENA_RAW, "hep-th/9711200")
			.category,
		"hep-th",
	);
});

// Two ways an OAI-PMH paper lists no category: the element is gone, or it is empty. Both the "arXiv" and the "arXivRaw"
// record list the categories, so both change.
const NO_CATEGORY_EXAMPLES = [
	{ label: "no <categories> element", replacement: "" },
	{
		label: "an empty <categories> element",
		replacement: "<categories></categories>",
	},
];

test('An entry from OAI-PMH without categories has "arXiv" alone as its source and no category field', async () => {
	const arxiv: typeof Arxiv = await import(SCRIPT.href);
	const listed = "<categories>cs.AI cs.LG stat.ML</categories>";

	for (const example of NO_CATEGORY_EXAMPLES) {
		const metadata = craft(COT_ARXIV, listed, example.replacement);
		const raw = craft(COT_RAW, listed, example.replacement);

		const entry = arxiv.parseOaiRecord(metadata, raw, "2507.11473");
		assert.equal(entry.source, "arXiv", example.label);
		assert.equal(Object.hasOwn(entry, "category"), false, example.label);
		assert.deepEqual(Object.keys(entry), KEYS_WITHOUT_CATEGORY, example.label);
		assert.equal(entry.id, "arxiv:2507.11473", example.label);
	}
});

test("XML entities in an OAI-PMH title are decoded exactly once", async () => {
	const arxiv: typeof Arxiv = await import(SCRIPT.href);

	for (const example of DECODING_EXAMPLES) {
		const record = craft(
			ATTENTION_ARXIV,
			"<title>Attention Is All You Need</title>",
			`<title>${example.inFeed}</title>`,
		);
		assert.equal(
			arxiv.parseOaiRecord(record, ATTENTION_RAW, "1706.03762").title,
			example.inEntry,
			example.inFeed,
		);
	}
});

test("An OAI-PMH record with an old-style id keeps its journal reference, comment and decoded abstract", async () => {
	const arxiv: typeof Arxiv = await import(SCRIPT.href);
	const entry = arxiv.parseOaiRecord(
		MALDACENA_ARXIV,
		MALDACENA_RAW,
		"hep-th/9711200",
	);

	assert.equal(entry.id, "arxiv:hep-th/9711200");
	assert.equal(entry.type, "paper");
	assert.equal(entry.url, "https://arxiv.org/abs/hep-th/9711200");
	assert.deepEqual(entry.links, [
		{ label: "PDF", url: "https://arxiv.org/pdf/hep-th/9711200" },
	]);
	assert.equal(
		entry.title,
		"The Large N Limit of Superconformal Field Theories and Supergravity",
	);
	assert.deepEqual(entry.authors, ["Juan M. Maldacena"]);
	assert.equal(entry.source, "arXiv High Energy Physics - Theory");
	assert.equal(entry.journal_ref, "Adv.Theor.Math.Phys.2:231-252,1998");
	assert.equal(
		entry.comment,
		"20 pages, harvmac, v2: section on AdS_2 corrected, references added, v3: More references and a sign in eqns 2.8 and 2.9 corrected",
	);
	// Leading spaces trimmed, "&#39;" decoded.
	assert.ok(abstractOf(entry).startsWith("We show that the large $N$ limit"));
	assert.ok(abstractOf(entry).includes("The 't Hooft limit"));
	assert.ok(!abstractOf(entry).includes("&#39;"));
});

test("From OAI-PMH, a journal reference or comment that arXiv leaves out is left out of the entry", async () => {
	const arxiv: typeof Arxiv = await import(SCRIPT.href);

	const neither = arxiv.parseOaiRecord(COT_ARXIV, COT_RAW, "2507.11473");
	assert.equal(Object.hasOwn(neither, "journal_ref"), false);
	assert.equal(Object.hasOwn(neither, "comment"), false);

	const commentOnly = arxiv.parseOaiRecord(
		STATERA_ARXIV,
		STATERA_RAW,
		"2610.00003",
	);
	assert.equal(commentOnly.comment, "17 pages, 7 figures, 3 tables. Preprint");
	assert.equal(Object.hasOwn(commentOnly, "journal_ref"), false);
});

test("From OAI-PMH, an author's name joins the forenames, last name and suffix that the record gives", async () => {
	const arxiv: typeof Arxiv = await import(SCRIPT.href);
	// Crafted from the real record: a suffix on the first author, no forenames on the second (as for a collaboration).
	let crafted = craft(
		COT_ARXIV,
		"<forenames>Tomek</forenames>",
		"<forenames>Tomek</forenames>\n<suffix>Jr</suffix>",
	);
	crafted = craft(crafted, "<forenames>Mikita</forenames>", "");

	const authors = arxiv.parseOaiRecord(crafted, COT_RAW, "2507.11473").authors;
	assert.equal(authors[0], "Tomek Korbak Jr");
	assert.equal(authors[1], "Balesni");
	assert.equal(authors[2], "Elizabeth Barnes");
});

test("From OAI-PMH, entities and runs of whitespace in the title, comment and journal reference are decoded and collapsed", async () => {
	const arxiv: typeof Arxiv = await import(SCRIPT.href);
	// Crafted from the real record: entities, a line break and a run of spaces in title, comment and journal-ref.
	let crafted = craft(
		ATTENTION_ARXIV,
		"<title>Attention Is All You Need</title>",
		"<title>Attention   Is All\n   You Need &amp; More</title>",
	);
	crafted = craft(
		crafted,
		"<comments>15 pages, 5 figures</comments>",
		"<comments>15 pages,\n  5 figures &lt;v7&gt;</comments>\n<journal-ref>  NeurIPS &amp;\n 2017 </journal-ref>",
	);

	const entry = arxiv.parseOaiRecord(crafted, ATTENTION_RAW, "1706.03762");
	assert.equal(entry.title, "Attention Is All You Need & More");
	assert.equal(entry.comment, "15 pages, 5 figures <v7>");
	assert.equal(entry.journal_ref, "NeurIPS & 2017");
});

// =====================================================================================================
// 6. Pacing across runs: arxivRequest keeps the time its last request ended, whatever address it went to, as a
// millisecond timestamp in one file under <TMPDIR>/liminal-arxiv-pacing/. Requests go to a local server only.
// =====================================================================================================

// A local stand-in for the arXiv API: its URL, when each request arrived (ms timestamps), and how to close it.
type LocalApi = { url: string; arrivals: number[]; close: () => Promise<void> };

// A local server that answers every request with the saved 2507.11473 feed and HTTP `status` (200 unless given),
// `delayMs` after it arrives. Returns { url, arrivals, close }: an API-style URL on it, the arrival time of each
// request, and a function that closes it.
async function localApi(delayMs: number, status = 200): Promise<LocalApi> {
	const arrivals: number[] = [];
	const server = http.createServer((_request, response) => {
		arrivals.push(Date.now());
		setTimeout(() => {
			response.writeHead(status, {
				"Content-Type": "application/atom+xml; charset=utf-8",
			});
			response.end(REAL);
		}, delayMs);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(
		address !== null && typeof address === "object",
		"the server listens on a port",
	);
	allowLocal(address.port);
	const url = `http://127.0.0.1:${address.port}/api/query?id_list=2507.11473`;

	// Kept-alive connections are dropped first, so close() does not wait on them.
	async function close() {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
	return { url: url, arrivals: arrivals, close: close };
}

// The pacing records in the pacing folder now, each as { name, text }: every file but the refusal record, which sits
// in the same folder. None when the folder doesn't exist yet.
function pacingRecords() {
	if (!existsSync(PACING_DIR)) {
		return [];
	}
	const names = readdirSync(PACING_DIR).filter((name) => name !== "refusals");
	return names.map((name) => {
		return { name: name, text: readFileSync(join(PACING_DIR, name), "utf8") };
	});
}

// The one pacing record in the pacing folder; fails when there are none or several.
function theRecord() {
	const records = pacingRecords();
	assert.equal(
		records.length,
		1,
		`one pacing record; files: ${JSON.stringify(records)}`,
	);
	const record = records[0];
	assert.ok(record !== undefined, "one pacing record");
	return record;
}

test("limit: A request to arXiv saves the time its answer ended in the pacing record", async () => {
	const { arxivRequest }: typeof Arxiv = await import(SCRIPT.href);
	// The answer is held 500 ms, so the time the request ended is at least 500 ms after it reached the server.
	const api = await localApi(500);
	try {
		await arxivRequest(api.url);
		const returnedAt = Date.now();

		const record = theRecord();
		assert.match(
			record.text.trim(),
			/^\d+$/,
			"a millisecond timestamp as text",
		);
		const recorded = Number(record.text);
		assert.equal(api.arrivals.length, 1);
		const arrived = api.arrivals[0];
		assert.ok(arrived !== undefined, "the request arrived");
		assert.ok(
			recorded >= arrived + 500,
			`recorded ${recorded}, request arrived ${arrived}: the end, not the start`,
		);
		assert.ok(
			recorded <= returnedAt,
			`recorded ${recorded}, arxivRequest returned at ${returnedAt}`,
		);
	} finally {
		await api.close();
	}
});

test("limit: Requests to the arXiv API and to OAI-PMH share one pacing record", async () => {
	const { arxivRequest }: typeof Arxiv = await import(SCRIPT.href);
	// Two servers on two ports: two addresses, as the arXiv API and OAI-PMH are.
	const first = await localApi(0);
	const second = await localApi(0);
	try {
		await arxivRequest(first.url);
		await arxivRequest(second.url);

		const record = theRecord();
		assert.match(record.text.trim(), /^\d+$/, record.name);
		const secondArrived = second.arrivals[0];
		assert.ok(secondArrived !== undefined, "the second request arrived");
		assert.ok(
			Number(record.text) >= secondArrived,
			`recorded ${record.text}, the second request arrived ${secondArrived}: the record holds the later request`,
		);
	} finally {
		await first.close();
		await second.close();
	}
});

// The 3 s pause arXiv asks for, given to the child processes below instead of this file's shortened one.
const ARXIV_PAUSE_MS_REAL = 3000;
const execFileAsync = promisify(execFile);

// One arxivRequest to `url` in a child process of its own: it shares this file's pacing folder (through TMPDIR) and
// nothing else, so it knows the last request's end only from the record.
async function requestInChild(url: string) {
	const program = `import { arxivRequest } from ${JSON.stringify(SCRIPT.href)}; await arxivRequest(process.argv[1]);`;
	await execFileAsync(
		process.execPath,
		["--input-type=module", "-e", program, url],
		{
			env: { ...process.env, ARXIV_PAUSE_MS: String(ARXIV_PAUSE_MS_REAL) },
			timeout: 30_000,
		},
	);
}

test("limit: A request from a second process starts 3 s after the first process's answer ended", async () => {
	const arrivals: number[] = [];
	const finishes: number[] = [];
	const server = http.createServer((_request, response) => {
		arrivals.push(Date.now());
		response.on("finish", () => finishes.push(Date.now()));
		setTimeout(() => response.end(REAL), 200);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");
	allowLocal(address.port);
	const url = `http://127.0.0.1:${address.port}/api/query?id_list=2507.11473`;
	try {
		await requestInChild(url);
		await requestInChild(url);
		const firstEnded = finishes[0];
		const secondArrived = arrivals[1];
		assert.ok(
			firstEnded !== undefined && secondArrived !== undefined,
			"the server saw both requests",
		);
		assert.ok(
			secondArrived - firstEnded >= ARXIV_PAUSE_MS_REAL - 20,
			`the second request arrived ${secondArrived - firstEnded} ms after the first answer ended`,
		);
	} finally {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
}, 60_000);

// =====================================================================================================
// 6c. The pacing record is never followed through a link (#100 item 7). Within one process every request waits
// PAUSE_MS after the previous one ended, so each request below takes about that long.
// =====================================================================================================

// What the file outside the pacing folder holds in the write test. Written through the link, it would become a time.
const OUTSIDE_TEXT =
	"Not a pacing record. A run of arxiv.ts must leave this file as it is.\n";

// Wait `ms` milliseconds (Python: await asyncio.sleep(ms / 1000)).
function pause(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// A first request to `api` writes the pacing record; return the record's path.
async function firstRecord(
	arxivRequest: typeof Arxiv.arxivRequest,
	api: LocalApi,
) {
	await arxivRequest(api.url);
	return join(PACING_DIR, theRecord().name);
}

// Swap the record for a symbolic link to a new file holding `text`, in a folder of its own outside the pacing folder
// (inside the test TMPDIR, so it is deleted with it). Returns the path of the file the link points to.
function linkOutside(record: string, text: string) {
	const outsideDir = mkdtempSync(join(TEST_TMPDIR, "outside-"));
	const target = join(outsideDir, "not-a-record.txt");
	writeFileSync(target, text);
	rmSync(record);
	symlinkSync(target, record);
	assert.equal(
		lstatSync(record).isSymbolicLink(),
		true,
		"the record is now a link",
	);
	return target;
}

test("security: A pacing record that is a symbolic link is replaced, and the file it points to stays as it was", async () => {
	const { arxivRequest }: typeof Arxiv = await import(SCRIPT.href);
	const api = await localApi(0);
	try {
		const record = await firstRecord(arxivRequest, api);
		const target = linkOutside(record, OUTSIDE_TEXT);

		await arxivRequest(api.url);
		const returnedAt = Date.now();

		// The file the link pointed to is unchanged.
		assert.equal(
			lstatSync(target).isFile(),
			true,
			"the file the link pointed to is still a regular file",
		);
		assert.equal(
			readFileSync(target, "utf8"),
			"Not a pacing record. A run of arxiv.ts must leave this file as it is.\n",
		);

		// The record is now a regular file holding the time the second request ended.
		const stats = lstatSync(record);
		assert.equal(stats.isSymbolicLink(), false, "the link was replaced");
		assert.equal(stats.isFile(), true, "the record is a regular file");
		const text = readFileSync(record, "utf8").trim();
		assert.match(text, /^\d+$/, "a millisecond timestamp as text");
		const recorded = Number(text);
		assert.equal(api.arrivals.length, 2);
		const secondArrived = api.arrivals[1];
		assert.ok(secondArrived !== undefined, "the second request arrived");
		assert.ok(
			recorded >= secondArrived,
			`recorded ${recorded}, the second request arrived ${secondArrived}`,
		);
		assert.ok(
			recorded <= returnedAt,
			`recorded ${recorded}, arxivRequest returned at ${returnedAt}`,
		);
	} finally {
		await api.close();
	}
});

test("security: A pacing record that is a symbolic link counts as no record, so the request does not wait", async () => {
	const { arxivRequest }: typeof Arxiv = await import(SCRIPT.href);
	const api = await localApi(0);
	try {
		const record = await firstRecord(arxivRequest, api);
		// Past the pause a process keeps between its own requests, so only a record could make the next request wait.
		await pause(PAUSE_MS + 100);
		// The linked file holds a time just now: read through the link, it would hold the next request about PAUSE_MS.
		linkOutside(record, String(Date.now()));

		const startedAt = Date.now();
		await arxivRequest(api.url);
		const tookMs = Date.now() - startedAt;

		assert.ok(
			tookMs < PAUSE_MS / 2,
			`the request took ${tookMs} ms; a record read through the link would hold it about ${PAUSE_MS} ms`,
		);
	} finally {
		await api.close();
	}
});

// This file's TMPDIR is a fresh folder, so the pacing folder in it is one the script made.
test("security: The pacing folder can be read and written only by its owner", async () => {
	const { arxivRequest }: typeof Arxiv = await import(SCRIPT.href);
	const api = await localApi(0);
	try {
		await arxivRequest(api.url);
	} finally {
		await api.close();
	}

	const stats = lstatSync(PACING_DIR);
	assert.equal(
		stats.isDirectory(),
		true,
		"the pacing folder is a folder, not a link",
	);
	assert.ok(typeof process.getuid === "function", "the platform has user ids");
	assert.equal(
		stats.uid,
		process.getuid(),
		"owned by the user who ran the request",
	);
	// `mode & 0o777` keeps only the permission bits (Python: stat.S_IMODE(mode)); 700 is drwx------ in `ls -ld`.
	const permissions = (stats.mode & 0o777).toString(8);
	assert.equal(
		permissions,
		"700",
		"rwx for the owner, nothing for group or others",
	);
});

// =====================================================================================================
// 6d. The refusal record is never written through a link.
// =====================================================================================================

// What the file outside the pacing folder holds. Written through the link, it would gain a refusal's JSON line.
const OUTSIDE_REFUSALS_TEXT =
	"Not a refusal record. A run of arxiv.ts must leave this file as it is.\n";

test("security: A refusal record that is a symbolic link is not written through, a warning is printed, and the answer still returns", async () => {
	const { arxivRequest }: typeof Arxiv = await import(SCRIPT.href);
	const api = await localApi(0, 429);
	const record = join(PACING_DIR, "refusals");
	const target = join(
		mkdtempSync(join(TEST_TMPDIR, "outside-")),
		"not-a-record.txt",
	);
	writeFileSync(target, OUTSIDE_REFUSALS_TEXT);
	// The pacing folder exists once any test above has asked the server; made here too, so this test stands alone.
	mkdirSync(PACING_DIR, { recursive: true, mode: 0o700 });
	symlinkSync(target, record);
	const printed = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		const answer = await arxivRequest(api.url);
		assert.equal(
			answer.status,
			429,
			"the answer still comes back to the caller",
		);
		assert.equal(readFileSync(target, "utf8"), OUTSIDE_REFUSALS_TEXT);
		const lines = printed.mock.calls.map((call) => String(call[0]));
		assert.ok(
			lines.some((line) =>
				/^arxiv\.ts: can't keep the refusal in .+/.test(line),
			),
			`stderr names the refusal it couldn't keep: ${JSON.stringify(lines)}`,
		);
	} finally {
		printed.mockRestore();
		rmSync(record);
		await api.close();
	}
});

test("limit: A 429 from the API and a 503 from OAI-PMH are kept as refusals with their service, status and path, and a 404 is not", async () => {
	const { arxivRequest, readRefusals, refusalRecord }: typeof Arxiv =
		await import(SCRIPT.href);
	const busy = await localApi(0, 429);
	const missing = await localApi(0, 404);
	rmSync(refusalRecord(), { force: true });
	try {
		await arxivRequest(busy.url);
		await arxivRequest(`${process.env.ARXIV_OAI}?verb=GetRecord&identifier=x`);
		await arxivRequest(missing.url);
	} finally {
		await busy.close();
		await missing.close();
	}
	const kept = readRefusals(refusalRecord());
	assert.deepEqual(
		kept.map((each) => [each.service, each.status, each.path]),
		[
			["arXiv API", 429, "/api/query"],
			["OAI-PMH", 503, "/oai"],
		],
	);
	for (const each of kept) {
		assert.ok(
			!Number.isNaN(Date.parse(each.time)),
			"each refusal has its time",
		);
	}
});

// Answers that aren't busyness are not asked again.
// scripts/scout/search.ts adds "after 4 retries" to its stop message only when apiFailed is true; the message is built inside
// search.ts, so this test checks apiFailed and the words "answered HTTP 404".
test("limit: An HTTP 404 from the arXiv API is not a failure to retry", async () => {
	const arxiv: typeof Arxiv = await import(SCRIPT.href);
	const answer = {
		url: "http://127.0.0.1:1/api/query",
		status: 404,
		ok: false,
		body: "<html><body>Not Found</body></html>",
	};

	assert.equal(arxiv.apiFailed(answer), false);
	assert.equal(
		arxiv.whatHappened(answer, "an arXiv feed"),
		"answered HTTP 404",
	);
});

test("limit: arXiv's HTTP 400 error feed for a rejected query is not a failure to retry", async () => {
	const arxiv: typeof Arxiv = await import(SCRIPT.href);
	const answer = {
		url: "http://127.0.0.1:1/api/query",
		status: 400,
		ok: false,
		body: ERROR_400_NO_ID,
	};

	assert.equal(arxiv.apiFailed(answer), false);
});
