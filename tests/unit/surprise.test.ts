// Unit tests for the pure exports of scripts/scout/surprise.ts (arxivIdsInHtml, paperIdsInHtml, quantaStories, natureStories,
// aiReason, paperVerdict, PAGE_PAUSE_MS), on small hand-written story pages, Quanta posts and Nature feeds. The link
// forms are those of Quanta's and Nature's story pages.

import assert from "node:assert/strict";
import { test } from "vitest";
import CONSTANTS from "../../scripts/lib/constants.json" with { type: "json" };
import type * as Surprise from "../../scripts/scout/surprise.ts";

const SCRIPT = new URL("../../scripts/scout/surprise.ts", import.meta.url);

// =====================================================================================================
// arxivIdsInHtml(html): ids in link order, deduped, versions stripped
// =====================================================================================================

// The feature's two links: an abs link and a versioned pdf link.
test("Abs and pdf links give bare ids in link order, versions stripped", async () => {
	const { arxivIdsInHtml }: typeof Surprise = await import(SCRIPT.href);
	const html =
		'<p>See <a href="https://arxiv.org/pdf/2609.55555v2">the preprint</a> and ' +
		'<a href="https://arxiv.org/abs/2610.01234">its companion</a>.</p>';
	assert.deepEqual(arxivIdsInHtml(html), ["2609.55555", "2610.01234"]);
});

// The contract allows an optional "www.", an optional version and an optional ".pdf" ending.
test("www., a .pdf ending and a version are all accepted", async () => {
	const { arxivIdsInHtml }: typeof Surprise = await import(SCRIPT.href);
	const html =
		'<p><a href="https://www.arxiv.org/abs/2609.11111">one</a>, ' +
		'<a href="https://arxiv.org/pdf/2609.22222v3.pdf">two</a> and ' +
		'<a href="https://www.arxiv.org/pdf/2609.33333.pdf">three</a>.</p>';
	assert.deepEqual(arxivIdsInHtml(html), [
		"2609.11111",
		"2609.22222",
		"2609.33333",
	]);
});

// New-style ids have four or five digits after the dot.
test("New-style ids with four or five digits after the dot are read", async () => {
	const { arxivIdsInHtml }: typeof Surprise = await import(SCRIPT.href);
	const html =
		'<p><a href="https://arxiv.org/abs/0704.0001">the first</a> and ' +
		'<a href="https://arxiv.org/abs/1706.03762v7">a later one</a>.</p>';
	assert.deepEqual(arxivIdsInHtml(html), ["0704.0001", "1706.03762"]);
});

// The feature's old-style link, plus one with a version and one with a subject class.
test("Old-style arXiv links count, with or without a subject class", async () => {
	const { arxivIdsInHtml }: typeof Surprise = await import(SCRIPT.href);
	const html =
		'<p><a href="https://arxiv.org/abs/math/0309136">a</a>, ' +
		'<a href="https://arxiv.org/abs/hep-th/9901001v1">b</a> and ' +
		'<a href="https://arxiv.org/pdf/math.DG/0211159v1">c</a>.</p>';
	assert.deepEqual(arxivIdsInHtml(html), [
		"math/0309136",
		"hep-th/9901001",
		"math.DG/0211159",
	]);
});

// The same paper through its abs page, then another paper, then the first again as a versioned PDF.
test("A paper linked twice gives one id, where it was first linked", async () => {
	const { arxivIdsInHtml }: typeof Surprise = await import(SCRIPT.href);
	const html =
		'<p><a href="https://arxiv.org/abs/2609.55555">the paper</a>, ' +
		'<a href="https://arxiv.org/abs/2610.01234">a reply</a>, ' +
		'<a href="https://arxiv.org/pdf/2609.55555v2">the PDF</a>.</p>';
	assert.deepEqual(arxivIdsInHtml(html), ["2609.55555", "2610.01234"]);
});

test("Journal links give no ids", async () => {
	const { arxivIdsInHtml }: typeof Surprise = await import(SCRIPT.href);
	const html =
		'<p>Published in <a href="https://www.nature.com/articles/s41586-026-00001-1">Nature</a> and ' +
		'<a href="https://doi.org/10.1126/science.adz0001">Science</a>.</p>';
	assert.deepEqual(arxivIdsInHtml(html), []);
});

// =====================================================================================================
// paperIdsInHtml(html): "arxiv:" and "doi:" ids of a story page's paper links, in link order
// =====================================================================================================

test("A story page's arXiv and doi.org links give ids in link order, each once", async () => {
	const { paperIdsInHtml }: typeof Surprise = await import(SCRIPT.href);
	const html =
		'<p><a href="https://doi.org/10.1073/pnas.2523198122">PNAS</a>, ' +
		'<a href="https://arxiv.org/abs/2601.07283v2">arXiv</a>, ' +
		'<a href="https://doi.org/10.1073/pnas.2523198122">again</a>, ' +
		'<a href="https://arxiv.org/abs/math/0309136">old-style</a></p>';
	assert.deepEqual(paperIdsInHtml(html), [
		"doi:10.1073/pnas.2523198122",
		"arxiv:2601.07283",
		"arxiv:math/0309136",
	]);
});

test("Nature's escaped DOI links are read whole, in lower case", async () => {
	const { paperIdsInHtml }: typeof Surprise = await import(SCRIPT.href);
	const html =
		'<a data-track-action="article reference" href="https://doi.org/10.1038%2Fs41591-026-04661-7">1</a>' +
		'<a href="https://doi.org/10.1080%2F08989621.2026.2733727">2</a>' +
		'<a href="https://dx.doi.org/10.1126/SCIENCE.ADZ0001">3</a>';
	assert.deepEqual(paperIdsInHtml(html), [
		"doi:10.1038/s41591-026-04661-7",
		"doi:10.1080/08989621.2026.2733727",
		"doi:10.1126/science.adz0001",
	]);
});

test("A doi.org link's query and fragment are not part of the DOI", async () => {
	const { paperIdsInHtml }: typeof Surprise = await import(SCRIPT.href);
	assert.deepEqual(
		paperIdsInHtml(
			'<a href="https://doi.org/10.1038/s41586-026-01234-5?utm_source=feed#refs">x</a>',
		),
		["doi:10.1038/s41586-026-01234-5"],
	);
});

test("An arXiv DOI gives the arXiv id", async () => {
	const { paperIdsInHtml }: typeof Surprise = await import(SCRIPT.href);
	assert.deepEqual(
		paperIdsInHtml('<a href="https://doi.org/10.48550/arXiv.2604.22458">x</a>'),
		["arxiv:2604.22458"],
	);
});

test("Journal pages, Nature's own news DOIs and links outside href are not papers", async () => {
	const { paperIdsInHtml }: typeof Surprise = await import(SCRIPT.href);
	const html =
		'<a class="c-latest-content__link" href="https://www.nature.com/articles/s41586-026-10438-2">Latest</a>' +
		'<a href="https://doi.org/10.1038/d41586-026-03387-3">this story</a>' +
		"<p>See https://doi.org/10.1126/science.adz0002 in print.</p>";
	assert.deepEqual(paperIdsInHtml(html), []);
});

test("Entities in an address are decoded", async () => {
	const { paperIdsInHtml }: typeof Surprise = await import(SCRIPT.href);
	assert.deepEqual(
		paperIdsInHtml('<a href="https://doi.org/10.1002/(SICI)1097&amp;x">x</a>'),
		["doi:10.1002/(sici)1097&x"],
	);
});

// =====================================================================================================
// quantaStories(posts, startDate): { date, title, url } newest first
// =====================================================================================================

// A post shaped like Quanta's WordPress API answer: `date` in site time, a rendered title, empty content.
function post(date: string, renderedTitle: string, link: string) {
	return {
		date: date,
		link: link,
		title: { rendered: renderedTitle },
		content: { rendered: "" },
	};
}

test("Quanta's stories from the start date on come newest first, with their titles decoded", async () => {
	const { quantaStories }: typeof Surprise = await import(SCRIPT.href);
	const posts = [
		post(
			"2026-09-30T09:00:00",
			"Older",
			"https://www.quantamagazine.org/older/",
		),
		post(
			"2026-10-04T11:00:00",
			"How Voting Is Like a <em>Klein</em> Bottle&#8217;s",
			"https://www.quantamagazine.org/klein/",
		),
		post(
			"2026-09-28T23:00:00",
			"Too old",
			"https://www.quantamagazine.org/old/",
		),
		{ date: "not a date", link: "https://www.quantamagazine.org/x/" },
	];
	assert.deepEqual(quantaStories(posts, "2026-09-29"), [
		{
			date: "2026-10-04",
			title: "How Voting Is Like a Klein Bottle’s",
			url: "https://www.quantamagazine.org/klein/",
		},
		{
			date: "2026-09-30",
			title: "Older",
			url: "https://www.quantamagazine.org/older/",
		},
	]);
});

// =====================================================================================================
// natureStories(xml, startDate): news stories only, newest first
// =====================================================================================================

// An item as Nature's feed writes it (RSS 1.0), cut to the fields the script reads.
function item(link: string, title: string, date: string) {
	return (
		`<item rdf:about="${link}"><title><![CDATA[${title}]]></title><link>${link}</link>` +
		`<dc:title><![CDATA[${title}]]></dc:title><dc:date>${date}</dc:date></item>`
	);
}

test("Nature's news stories from the start date on come newest first, and research articles are left out", async () => {
	const { natureStories }: typeof Surprise = await import(SCRIPT.href);
	const xml =
		"<rdf:RDF><channel><link>http://feeds.nature.com/nature/rss/current</link></channel>" +
		item(
			"https://www.nature.com/articles/d41586-026-03502-4",
			"I built the metascience unit — here’s what countries need to know",
			"2026-10-30",
		) +
		item(
			"https://www.nature.com/articles/s41586-026-11337-2",
			"A research article",
			"2026-11-02",
		) +
		item(
			"https://www.nature.com/articles/d41586-026-03387-3",
			"Measles made a stealthy return &amp; more",
			"2026-11-02",
		) +
		item(
			"https://www.nature.com/articles/d41586-026-00001-1",
			"Too old",
			"2026-10-26",
		) +
		"</rdf:RDF>";
	assert.deepEqual(natureStories(xml, "2026-10-27"), [
		{
			date: "2026-11-02",
			title: "Measles made a stealthy return & more",
			url: "https://www.nature.com/articles/d41586-026-03387-3",
		},
		{
			date: "2026-10-30",
			title:
				"I built the metascience unit — here’s what countries need to know",
			url: "https://www.nature.com/articles/d41586-026-03502-4",
		},
	]);
});

// =====================================================================================================
// aiReason(field): AI categories and journals
// =====================================================================================================

test("AI arXiv categories are AI; other fields are not", async () => {
	const { aiReason }: typeof Surprise = await import(SCRIPT.href);
	for (const code of [
		"cs.AI",
		"cs.LG",
		"cs.CL",
		"cs.CV",
		"cs.NE",
		"cs.MA",
		"cs.RO",
		"cs.IR",
		"stat.ML",
	]) {
		assert.equal(aiReason(code), code);
	}
	for (const code of [
		"cs.GT",
		"astro-ph.GA",
		"math.CO",
		"q-bio.BM",
		"econ.TH",
		"cs.CR",
	]) {
		assert.equal(aiReason(code), null);
	}
});

test("AI journals are AI by their name; other journals are not", async () => {
	const { aiReason }: typeof Surprise = await import(SCRIPT.href);
	for (const journal of [
		"Nature Machine Intelligence",
		"Artificial Intelligence",
		"Journal of Machine Learning Research",
		"IEEE Transactions on Neural Networks and Learning Systems",
		"Neural Computation",
		"Computational Linguistics",
		"IEEE Transactions on Pattern Analysis and Machine Intelligence",
	]) {
		assert.equal(aiReason(journal), journal);
	}
	for (const journal of [
		"Nature",
		"Nature Medicine",
		"PNAS",
		"Science Advances",
		"Physical Review Letters",
	]) {
		assert.equal(aiReason(journal), null);
	}
});

// =====================================================================================================
// paperVerdict(inDigests, facts, cutoff): the order of the checks on a story's link
// =====================================================================================================

// A story of 2026-11-01: papers published before this day are background, not its paper.
const CUTOFF = "2025-11-01";

test("A paper already in the digests is marked in digests, whatever its date or field", async () => {
	const { paperVerdict }: typeof Surprise = await import(SCRIPT.href);
	assert.equal(
		paperVerdict(true, { field: "cs.CL", published: "1987-06-01" }, CUTOFF),
		"in digests",
	);
	assert.equal(paperVerdict(true, null, CUTOFF), "in digests");
});

test("A DOI that Crossref doesn't know, or a paper from before the cutoff, is passed over whatever its field", async () => {
	const { paperVerdict }: typeof Surprise = await import(SCRIPT.href);
	assert.equal(paperVerdict(false, null, CUTOFF), "passed over");
	// The 1987 Cell paper a Nature story cites first, and an old preprint without a journal.
	assert.equal(
		paperVerdict(false, { field: "Cell", published: "1987-06-01" }, CUTOFF),
		"passed over",
	);
	assert.equal(
		paperVerdict(false, { field: null, published: "2019-01-02" }, CUTOFF),
		"passed over",
	);
	assert.equal(
		paperVerdict(false, { field: "cs.CL", published: "2017-06-12" }, CUTOFF),
		"passed over",
	);
});

test("A date given only as a month or a year is inside the window when it is the cutoff's month or year", async () => {
	const { paperVerdict }: typeof Surprise = await import(SCRIPT.href);
	for (const published of ["2025-11-01", "2025-11", "2025"]) {
		assert.equal(
			paperVerdict(false, { field: "Nature", published: published }, CUTOFF),
			"story's paper",
			published,
		);
	}
	assert.equal(
		paperVerdict(false, { field: "Nature", published: "2025-10" }, CUTOFF),
		"passed over",
	);
});

test("A recent paper with no field is marked field unknown, one with an AI field is an AI paper, and any other is the story's paper", async () => {
	const { paperVerdict }: typeof Surprise = await import(SCRIPT.href);
	assert.equal(
		paperVerdict(false, { field: null, published: "2026-10-20" }, CUTOFF),
		"field unknown",
	);
	assert.equal(
		paperVerdict(false, { field: null, published: null }, CUTOFF),
		"field unknown",
	);
	assert.equal(
		paperVerdict(
			false,
			{ field: "Nature Machine Intelligence", published: "2026-10-20" },
			CUTOFF,
		),
		"AI paper",
	);
	assert.equal(
		paperVerdict(false, { field: "astro-ph.GA", published: null }, CUTOFF),
		"story's paper",
	);
});

test("limit: Story pages of one site are a second apart by default", async () => {
	const { PAGE_PAUSE_MS }: typeof Surprise = await import(SCRIPT.href);
	assert.equal(PAGE_PAUSE_MS, CONSTANTS.burstDelayMs);
});
