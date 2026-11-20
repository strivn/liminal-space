// Unit tests for the exports of scripts/scout/proceedings/sites.ts: which proceedings a list has, reading each site's index and paper pages, the ids, and the digests entry.
// The pages are short excerpts of the real ones in tests/fixtures/proceedings. Expected values are
// written out by hand. Nothing here contacts a conference site.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { idsInText } from "../../scripts/digests/digests-file.ts";
import type * as Proceedings from "../../scripts/scout/proceedings/sites.ts";

const SCRIPT = new URL(
	"../../scripts/scout/proceedings/sites.ts",
	import.meta.url,
);
const page = (name: string) =>
	readFileSync(
		new URL(`../fixtures/proceedings/${name}`, import.meta.url),
		"utf8",
	);

test("A PETS list's proceedings are PoPETs' volume of the list's year", async () => {
	const { proceedingsOf }: typeof Proceedings = await import(SCRIPT.href);
	assert.deepEqual(
		proceedingsOf("PETS", "https://petsymposium.org/2026/paperlist.php"),
		{
			source: "PoPETs",
			note: "PETS 2026",
			format: "popets",
			indexUrls: ["https://petsymposium.org/popets/2026/"],
			issueLabel: null,
		},
	);
});

test("ACL's proceedings are the Anthology's long and short volumes, and ACL Findings' are its Findings volume", async () => {
	const { proceedingsOf }: typeof Proceedings = await import(SCRIPT.href);
	assert.deepEqual(
		proceedingsOf("ACL", "https://2026.aclweb.org/program/accepted_papers/"),
		{
			source: "ACL Anthology",
			note: "ACL 2026",
			format: "anthology",
			indexUrls: [
				"https://aclanthology.org/volumes/2026.acl-long/",
				"https://aclanthology.org/volumes/2026.acl-short/",
			],
			issueLabel: null,
		},
	);
	assert.deepEqual(
		proceedingsOf("ACL Findings", "https://2026.aclweb.org/program/findings/"),
		{
			source: "ACL Anthology",
			note: "ACL Findings 2026",
			format: "anthology",
			indexUrls: ["https://aclanthology.org/volumes/2026.findings-acl/"],
			issueLabel: null,
		},
	);
});

test("AIES's proceedings are AAAI's issues labelled with the list's year", async () => {
	const { proceedingsOf }: typeof Proceedings = await import(SCRIPT.href);
	assert.deepEqual(
		proceedingsOf(
			"AIES",
			"https://www.aies-conference.com/2026/paper-sessions/",
		),
		{
			source: "AAAI",
			note: "AIES 2026",
			format: "ojs",
			indexUrls: ["https://ojs.aaai.org/index.php/AIES/issue/archive"],
			issueLabel: "AIES-26",
		},
	);
});

test("A venue without proceedings read here, or a list address without a year, has none", async () => {
	const { proceedingsOf }: typeof Proceedings = await import(SCRIPT.href);
	assert.equal(
		proceedingsOf(
			"NeurIPS",
			"https://neurips.cc/static/virtual/data/neurips-2026-orals-posters.json",
		),
		null,
	);
	assert.equal(
		proceedingsOf("PETS", "https://petsymposium.org/paperlist.php"),
		null,
	);
});

test("PoPETs' volume page gives each paper's title and page, and leaves out an item that links only a PDF", async () => {
	const { indexPapers }: typeof Proceedings = await import(SCRIPT.href);
	assert.deepEqual(
		indexPapers(
			"popets",
			page("popets-2026-index.html"),
			"https://petsymposium.org/popets/2026/",
		),
		[
			{
				title: "Gaze3P: Gaze-Based Prediction of User-Perceived Privacy",
				url: "https://petsymposium.org/popets/2026/popets-2026-0002.php",
			},
			{
				title:
					"Clicking into Exposure: Uncovering Privacy Risks of Google Click Identifier in YouTube Ads",
				url: "https://petsymposium.org/popets/2026/popets-2026-0038.php",
			},
		],
	);
});

test("The Anthology's volume page gives each paper's title, its tags removed, and page", async () => {
	const { indexPapers }: typeof Proceedings = await import(SCRIPT.href);
	assert.deepEqual(
		indexPapers(
			"anthology",
			page("anthology-2026.acl-long.html"),
			"https://aclanthology.org/volumes/2026.acl-long/",
		),
		[
			{
				title:
					"Mechanistic Interpretability Should Prioritize Feature Consistency in Sparse Autoencoders",
				url: "https://aclanthology.org/2026.acl-long.99/",
			},
			{
				title:
					"EquivPruner: Boosting Efficiency and Quality in LLM-Based Search via Action Pruning",
				url: "https://aclanthology.org/2026.acl-long.100/",
			},
		],
	);
});

test("AAAI's archive gives the issues of the list's year; each issue page gives its articles", async () => {
	const { indexPapers, ojsIssues }: typeof Proceedings = await import(
		SCRIPT.href
	);
	assert.deepEqual(
		ojsIssues(
			page("aies-archive.html"),
			"https://ojs.aaai.org/index.php/AIES/issue/archive",
			"AIES-26",
		),
		["https://ojs.aaai.org/index.php/AIES/issue/view/744"],
	);
	assert.deepEqual(
		indexPapers(
			"ojs",
			page("aies-issue-744.html"),
			"https://ojs.aaai.org/index.php/AIES/issue/view/744",
		),
		[
			{
				title:
					"Frictionless Validation: Exploring AI Sycophancy and Developmental Risks",
				url: "https://ojs.aaai.org/index.php/AIES/article/view/43234",
			},
			{
				title:
					"Law of Large Numbers: Accuracy as Statistical Measure for Compliance and Competition",
				url: "https://ojs.aaai.org/index.php/AIES/article/view/43184",
			},
		],
	);
});

test("A PoPETs paper page gives its authors, the year, its abstract from the body, its PDF and its DOI", async () => {
	const { pagePaper }: typeof Proceedings = await import(SCRIPT.href);
	const paper = pagePaper(
		page("popets-2026-0038.html"),
		"https://petsymposium.org/popets/2026/popets-2026-0038.php",
	);
	assert.ok(paper);
	assert.equal(
		paper.title,
		"Clicking into Exposure: Uncovering Privacy Risks of Google Click Identifier in YouTube Ads",
	);
	assert.deepEqual(paper.authors, [
		"Ha Dao",
		"Abhishek Shinde",
		"Sana Athar",
		"Devashish Gosain",
	]);
	assert.equal(paper.published, "2026");
	assert.ok(
		paper.abstract.startsWith("YouTube is one of the largest video platforms"),
	);
	assert.ok(
		paper.abstract.endsWith("browser environments, and regional contexts."),
	);
	assert.equal(
		paper.pdf,
		"https://petsymposium.org/popets/2026/popets-2026-0038.pdf",
	);
	assert.equal(paper.doi, "10.56553/popets-2026-0038");
});

test("An Anthology paper page gives the year and month, its abstract block, its PDF and its DOI", async () => {
	const { pagePaper }: typeof Proceedings = await import(SCRIPT.href);
	const paper = pagePaper(
		page("anthology-2026.acl-long.99.html"),
		"https://aclanthology.org/2026.acl-long.99/",
	);
	assert.ok(paper);
	assert.equal(
		paper.title,
		"Mechanistic Interpretability Should Prioritize Feature Consistency in Sparse Autoencoders",
	);
	assert.equal(paper.authors.length, 8);
	assert.equal(paper.authors[0], "Xiangchen Song");
	assert.equal(paper.published, "2026-07");
	assert.ok(
		paper.abstract.startsWith(
			"Sparse Autoencoders (SAEs) are a prominent tool",
		),
	);
	assert.equal(paper.pdf, "https://aclanthology.org/2026.acl-long.99.pdf");
	assert.equal(paper.doi, "10.18653/v1/2026.acl-long.99");
});

test("An AAAI paper page gives the whole date, its DC.Description abstract, its PDF and its DOI", async () => {
	const { pagePaper }: typeof Proceedings = await import(SCRIPT.href);
	const paper = pagePaper(
		page("aies-article-43234.html"),
		"https://ojs.aaai.org/index.php/AIES/article/view/43234",
	);
	assert.ok(paper);
	assert.equal(
		paper.title,
		"Frictionless Validation: Exploring AI Sycophancy and Developmental Risks",
	);
	assert.deepEqual(paper.authors, [
		"Junfeng Jiao",
		"Abhejay Murali",
		"Saleh Afroogh",
	]);
	assert.equal(paper.published, "2026-10-11");
	assert.ok(paper.abstract.startsWith("Adolescence is a critical period"));
	assert.equal(
		paper.pdf,
		"https://ojs.aaai.org/index.php/AIES/article/download/43234/50794",
	);
	assert.equal(paper.doi, "10.1609/aies.v9i2.43234");
});

test("A page that names no title gives no paper", async () => {
	const { pagePaper }: typeof Proceedings = await import(SCRIPT.href);
	assert.equal(
		pagePaper(
			"<html><head><title>Maintenance</title></head><body>Back soon</body></html>",
			"https://petsymposium.org/popets/2026/popets-2026-0038.php",
		),
		null,
	);
});

test('A paper is "doi:<doi>" when its page names a DOI, else "url:<its page>"', async () => {
	const { paperId }: typeof Proceedings = await import(SCRIPT.href);
	const paper = {
		title: "A paper",
		authors: ["Yoshua Bengio"],
		published: "2026",
		abstract: "An abstract.",
		pdf: null,
		doi: "10.56553/popets-2026-0038",
	};
	assert.equal(
		paperId(paper, "https://petsymposium.org/popets/2026/popets-2026-0038.php"),
		"doi:10.56553/popets-2026-0038",
	);
	assert.equal(
		paperId(
			Object.assign({}, paper, { doi: null }),
			"https://petsymposium.org/popets/2026/popets-2026-0038.php",
		),
		"url:https://petsymposium.org/popets/2026/popets-2026-0038.php",
	);
});

test("The doi: and url: ids of a digests text are found as written; arXiv ids are not among them", () => {
	const text = [
		'digest({"date":"2026-10-26","entries":[{"id":"arxiv:2610.00001","type":"paper","title":"A"}]});',
		'digest({"date":"2026-10-27","entries":[{"id":"doi:10.56553/popets-2026-0038","type":"paper","title":"B"},{"id":"url:https://example.org/news","type":"news","title":"C"}]});',
	].join("\n");
	assert.deepEqual(
		[...idsInText(text).other],
		["doi:10.56553/popets-2026-0038", "url:https://example.org/news"],
	);
});

// A proceedings paper as proceedings.json keeps it.
const KEPT = {
	id: "doi:10.56553/popets-2026-0038",
	title: "Clicking into Exposure",
	authors: ["Ha Dao", "Abhishek Shinde"],
	published: "2026",
	abstract: "YouTube is one of the largest video platforms on the web.",
	url: "https://petsymposium.org/popets/2026/popets-2026-0038.php",
	pdf: "https://petsymposium.org/popets/2026/popets-2026-0038.pdf",
	source: "PoPETs",
	note: "PETS 2026",
	venueSource: "https://petsymposium.org/2026/paperlist.php",
};

test("A proceedings entry has its fields in order, its PDF as its one link, and no date when the page gives only a year", async () => {
	const { proceedingsEntry }: typeof Proceedings = await import(SCRIPT.href);
	const entry = proceedingsEntry(KEPT);
	assert.deepEqual(Object.keys(entry), [
		"id",
		"type",
		"title",
		"authors",
		"source",
		"url",
		"links",
		"abstract",
		"venue",
		"venue_source",
	]);
	assert.equal(entry.type, "paper");
	assert.deepEqual(entry.links, [{ label: "PDF", url: KEPT.pdf }]);
	assert.equal(entry.venue, "PETS 2026");
	assert.equal(entry.venue_source, KEPT.venueSource);
});

test("A proceedings entry keeps a whole date, and has no links when the page names no PDF", async () => {
	const { proceedingsEntry }: typeof Proceedings = await import(SCRIPT.href);
	const entry = proceedingsEntry(
		Object.assign({}, KEPT, { published: "2026-10-11", pdf: null }),
	);
	assert.equal(entry.published, "2026-10-11");
	assert.equal(Object.keys(entry).indexOf("published"), 4);
	assert.equal(entry.links, undefined);
});

// ---- --crossref: a journal paper from its DOI's Crossref record ----

// A Crossref record's "message" as https://api.crossref.org/works/<doi> gives it, cut to the fields the entry reads
// (shape measured 2026-11-02 on 10.1038/s41586-020-2649-2).
const RECORD = {
	DOI: "10.1038/s41586-026-01234-5",
	type: "journal-article",
	title: ["Bone-derived proteins slow ageing in mice"],
	author: [
		{ given: "Geoffrey", family: "Hinton", sequence: "first" },
		{ given: "Yann", family: "LeCun", sequence: "additional" },
	],
	"container-title": ["Nature"],
	published: { "date-parts": [[2026, 10, 29]] },
	abstract:
		"<jats:title>Abstract</jats:title>\n  <jats:p>Osteocytes release proteins.</jats:p>",
};

test("A Crossref record becomes a paper entry with its DOI page, journal and day", async () => {
	const { crossrefEntry }: typeof Proceedings = await import(SCRIPT.href);
	assert.deepEqual(crossrefEntry(RECORD, "10.1038/s41586-026-01234-5"), {
		id: "doi:10.1038/s41586-026-01234-5",
		type: "paper",
		title: "Bone-derived proteins slow ageing in mice",
		authors: ["Geoffrey Hinton", "Yann LeCun"],
		published: "2026-10-29",
		source: "Nature",
		url: "https://doi.org/10.1038/s41586-026-01234-5",
		abstract: "Osteocytes release proteins.",
	});
});

test("A Crossref author named only as a group keeps that name, and a record without an abstract gives none", async () => {
	const { crossrefEntry }: typeof Proceedings = await import(SCRIPT.href);
	const entry = crossrefEntry(
		Object.assign({}, RECORD, {
			author: [{ name: "The Schölkopf Consortium" }],
			abstract: undefined,
		}),
		"10.1038/s41586-026-01234-5",
	);
	assert.deepEqual(entry?.authors, ["The Schölkopf Consortium"]);
	assert.equal(entry?.abstract, undefined);
});

test("A Crossref record without a title or an author gives no entry", async () => {
	const { crossrefEntry }: typeof Proceedings = await import(SCRIPT.href);
	assert.equal(
		crossrefEntry(Object.assign({}, RECORD, { title: [] }), RECORD.DOI),
		null,
	);
	assert.equal(
		crossrefEntry(Object.assign({}, RECORD, { author: [] }), RECORD.DOI),
		null,
	);
	assert.equal(crossrefEntry("Resource not found.", RECORD.DOI), null);
});

test("security: Markup in a Crossref title is left out, and its words kept", async () => {
	const { crossrefEntry }: typeof Proceedings = await import(SCRIPT.href);
	const entry = crossrefEntry(
		Object.assign({}, RECORD, { title: ["<i>In vivo</i> imaging of bone"] }),
		RECORD.DOI,
	);
	assert.equal(entry?.title, "In vivo imaging of bone");
});

test("A Crossref record dated only by its month, or by parts that aren't numbers, gets no date", async () => {
	const { crossrefEntry }: typeof Proceedings = await import(SCRIPT.href);
	for (const parts of [[[2026, 10]], [[2026]], [[null]]]) {
		const entry = crossrefEntry(
			Object.assign({}, RECORD, { published: { "date-parts": parts } }),
			RECORD.DOI,
		);
		assert.equal(entry?.published, undefined, JSON.stringify(parts));
	}
});

test("A date with only a year or a month counts as after a day only when that year or month is later", async () => {
	const { publishedAfter }: typeof Proceedings = await import(SCRIPT.href);
	assert.equal(publishedAfter("2026-11-01", "2026-10-31"), true);
	assert.equal(publishedAfter("2026-10-31", "2026-10-31"), false);
	assert.equal(publishedAfter("2026-11", "2026-10-31"), true);
	assert.equal(publishedAfter("2026-10", "2026-10-15"), false);
	assert.equal(publishedAfter("2027", "2026-12-31"), true);
	assert.equal(publishedAfter("2026", "2026-01-01"), false);
});

test.each([
	[
		"PoPETs",
		"popets",
		"https://petsymposium.org/popets/2026/",
		'<li><b><a href="../2026/popets-2026-0038.php">On the site</a></b></li>' +
			'<li><b><a href="http://127.0.0.1:8080/secret.php">Off the site</a></b></li>',
		"https://petsymposium.org/popets/2026/popets-2026-0038.php",
	],
	[
		"the Anthology",
		"anthology",
		"https://aclanthology.org/volumes/2026.acl-long/",
		"<strong><a class=align-middle href=/2026.acl-long.1/>On the site</a></strong>" +
			"<strong><a class=align-middle href=http://127.0.0.1:8080/secret>Off the site</a></strong>",
		"https://aclanthology.org/2026.acl-long.1/",
	],
	[
		"AAAI's journal site",
		"ojs",
		"https://ojs.aaai.org/index.php/AIES/issue/view/744",
		'<h3 class="title"><a id="a1" href="https://ojs.aaai.org/index.php/AIES/article/view/1">On the site</a></h3>' +
			'<h3 class="title"><a id="a2" href="http://127.0.0.1:8080/secret">Off the site</a></h3>',
		"https://ojs.aaai.org/index.php/AIES/article/view/1",
	],
] as const)(
	"%s: a paper link to another site is left out of the index, so a page cannot choose what gets fetched",
	async (_site, format, indexUrl, html, onSite) => {
		const { indexPapers }: typeof Proceedings = await import(SCRIPT.href);
		assert.deepEqual(
			indexPapers(format, html, indexUrl).map((paper) => paper.url),
			[onSite],
		);
	},
);

test("security: An issue link to another site is left out of AAAI's archive", async () => {
	const { ojsIssues }: typeof Proceedings = await import(SCRIPT.href);
	const html =
		'<a class="title" href="https://ojs.aaai.org/index.php/AIES/issue/view/744">Vol. 9 (AIES-26)</a>' +
		'<a class="title" href="http://169.254.169.254/issue/1">Vol. 8 (AIES-26)</a>';
	assert.deepEqual(
		ojsIssues(
			html,
			"https://ojs.aaai.org/index.php/AIES/issue/archive",
			"AIES-26",
		),
		["https://ojs.aaai.org/index.php/AIES/issue/view/744"],
	);
});

test("security: A 2 MB paper page with unclosed <meta tags gives no paper in under a second", async () => {
	const { pagePaper }: typeof Proceedings = await import(SCRIPT.href);
	const html = `<html><head>${"<meta ".repeat(350_000)}`;
	const started = performance.now();
	assert.equal(pagePaper(html, "https://petsymposium.org/p.php"), null);
	assert.ok(performance.now() - started < 1000, "read in under 1 second");
});

test("security: A paper page whose PDF link is not a web address gives the paper without a PDF", async () => {
	const { pagePaper }: typeof Proceedings = await import(SCRIPT.href);
	const html =
		'<meta name="citation_title" content="Fixture paper 1" />' +
		'<meta name="citation_author" content="Ada Example" />' +
		'<meta name="citation_pdf_url" content="javascript:alert(1)" />';
	assert.equal(pagePaper(html, "https://petsymposium.org/p.php")?.pdf, null);
});
