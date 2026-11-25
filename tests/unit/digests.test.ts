// Unit tests for the pure exports of scripts/digests/digests.ts and shared/entry-checks.ts (normalizeUrl, entryProblems, checkText, statusText, missingDays), on small
// hand-written entries and digest lines.

import assert from "node:assert/strict";
import { test } from "vitest";
import type * as Digests from "../../scripts/digests/digests.ts";
import type * as EntryChecks from "../../shared/entry-checks.ts";
import type { JsonObject } from "../../shared/narrow.ts";

const SCRIPT = new URL("../../scripts/digests/digests.ts", import.meta.url);
const CHECKS = new URL("../../shared/entry-checks.ts", import.meta.url);

// ---- Fixtures ----

// A news entry that follows the schema in scripts/scout/scout.md, with every optional field.
function fullNews() {
	return {
		id: "url:https://example.com/news/9",
		type: "news",
		title: "Fixture news story 9",
		authors: ["Ada Example"],
		published: "2026-10-04",
		source: "Fixture Times",
		url: "https://example.com/news/9",
		links: [
			{ label: "Full report", url: "https://example.com/news/9/report.pdf" },
		],
		description:
			"Forty ocean buoys now report Java Sea temperatures every ten minutes.",
	};
}

// fullNews() with these fields set.
function newsWith(fields: JsonObject) {
	return Object.assign(fullNews(), fields);
}

// fullNews() without these fields.
function newsWithout(fields: string[]) {
	const entry: JsonObject = fullNews();
	for (const field of fields) {
		delete entry[field];
	}
	return entry;
}

// A paper as scripts/scout/arxiv/arxiv.ts writes it; n picks its id. `extra` adds or changes fields.
function paper(n: number, extra?: JsonObject) {
	const arxivId = `2601.${String(n).padStart(5, "0")}`;
	const entry = {
		id: `arxiv:${arxivId}`,
		type: "paper",
		title: `Fixture paper ${n}`,
		authors: ["Ada Example", "Bo Sample"],
		published: "2026-01-02",
		source: "arXiv Machine Learning",
		url: `https://arxiv.org/abs/${arxivId}`,
		links: [{ label: "PDF", url: `https://arxiv.org/pdf/${arxivId}` }],
		abstract: "Researchers report measurements across several benchmarks.",
	};
	return Object.assign(entry, extra || {});
}

// paper(n) without these fields.
function paperWithout(n: number, fields: string[]) {
	const entry: JsonObject = paper(n);
	for (const field of fields) {
		delete entry[field];
	}
	return entry;
}

// The three kinds of entry that aren't papers.
type ItemType = "news" | "article" | "report";

// A news, article or report entry with n in its url and title, published on `published`.
function item(type: ItemType, n: number | string, published: string) {
	const folders = { news: "news", article: "articles", report: "reports" };
	const titles = {
		news: "Fixture news story ",
		article: "Fixture article ",
		report: "Fixture report ",
	};
	const url = `https://example.com/${folders[type]}/${n}`;
	return {
		id: `url:${url}`,
		type: type,
		title: titles[type] + n,
		authors: [],
		published: published,
		source: "Fixture Times",
		url: url,
	};
}

// The papers numbered from `from`, `count` of them.
function papers(from: number, count: number) {
	const list: JsonObject[] = [];
	for (let n = from; n < from + count; n++) {
		list.push(paper(n));
	}
	return list;
}

// One digest line as the scripts write it, ending in a line break.
function digestLine(date: string, entries: unknown[]) {
	return `digest(${JSON.stringify({ date: date, entries: entries })});\n`;
}

// Some problem holds `reason`, the contract's wording for it (tests match these as substrings).
function assertHasReason(problems: string[], reason: string, what: string) {
	let found = false;
	for (const problem of problems) {
		if (problem.includes(reason)) {
			found = true;
		}
	}
	assert.ok(
		found,
		`${what}: a problem holding ${JSON.stringify(reason)}; got ${JSON.stringify(problems)}`,
	);
}

// Some problem starts with `prefix`, has text after it, and holds `reason`.
function assertHasProblem(problems: string[], prefix: string, reason: string) {
	let found = false;
	for (const problem of problems) {
		const hasTextAfter = problem.slice(prefix.length).trim() !== "";
		if (
			problem.startsWith(prefix) &&
			hasTextAfter &&
			problem.includes(reason)
		) {
			found = true;
		}
	}
	assert.ok(
		found,
		`a problem starting ${JSON.stringify(prefix)} and holding ${JSON.stringify(reason)}; got ${JSON.stringify(problems)}`,
	);
}

// Some problem is exactly "line <n>: doesn't load", or that and " (at column <c>)": the line is named, its text is not
// quoted. Any column passes, since the contract leaves open whether it counts from the line's start or its JSON's.
function assertNamesLineNotLoading(
	problems: string[],
	lineNumber: number,
	what: string,
) {
	const start = `line ${lineNumber}: doesn't load`;
	let found = false;
	for (const problem of problems) {
		if (problem.startsWith(start)) {
			const rest = problem.slice(start.length);
			if (rest === "" || /^ \(at column \d+\)$/.test(rest)) {
				found = true;
			}
		}
	}
	assert.ok(
		found,
		`${what}: a problem ${JSON.stringify(start)}, with at most a column after it; got ${JSON.stringify(problems)}`,
	);
}

// No problem holds `text`, which only the file holds.
function assertQuotesNothing(problems: string[], text: string, what: string) {
	for (const problem of problems) {
		assert.ok(
			!problem.includes(text),
			`${what}: no problem quotes ${JSON.stringify(text)}; got ${JSON.stringify(problem)}`,
		);
	}
}

// The text without its final line break, if it has one.
function withoutFinalLineBreak(text: string) {
	if (text.endsWith("\n")) {
		return text.slice(0, -1);
	}
	return text;
}

// ---- entryProblems: add's schema ----

test("A news, article or report entry that follows the schema has no problems on add", async () => {
	const { entryProblems }: typeof EntryChecks = await import(CHECKS.href);
	assert.deepEqual(entryProblems(fullNews(), "add"), []);
	assert.deepEqual(entryProblems(newsWith({ type: "article" }), "add"), []);
	assert.deepEqual(entryProblems(newsWith({ type: "report" }), "add"), []);
	// http is allowed as well as https, for the url and for links.
	const plainHttp = newsWith({
		id: "url:http://example.com/news/9",
		url: "http://example.com/news/9",
		links: [{ label: "Data", url: "http://example.com/news/9/data" }],
	});
	assert.deepEqual(entryProblems(plainHttp, "add"), []);
});

test("Optional fields may be left out", async () => {
	const { entryProblems }: typeof EntryChecks = await import(CHECKS.href);
	const required = newsWithout(["id", "authors", "links", "description"]);
	assert.deepEqual(entryProblems(required, "add"), []);
	// Empty lists are lists.
	assert.deepEqual(
		entryProblems(newsWith({ authors: [], links: [] }), "add"),
		[],
	);
});

test("An id that matches the entry's url has no problems on add", async () => {
	const { entryProblems }: typeof EntryChecks = await import(CHECKS.href);
	const entry = newsWith({
		id: "url:https://example.com/news/1",
		url: "https://example.com/news/1",
	});
	assert.deepEqual(entryProblems(entry, "add"), []);
});

test("An id that doesn't match the url is refused", async () => {
	const { entryProblems }: typeof EntryChecks = await import(CHECKS.href);
	const entry = newsWith({
		id: "url:https://example.com/news/2",
		url: "https://example.com/news/1",
	});
	assertHasReason(
		entryProblems(entry, "add"),
		"id doesn't match the url",
		"id url:.../news/2 for url .../news/1",
	);
});

test("A news entry with a bad date, a missing field, a wrong type or a field outside the schema is refused on add", async () => {
	const { entryProblems }: typeof EntryChecks = await import(CHECKS.href);
	const cases = [
		{
			what: "published with a time",
			entry: newsWith({ published: "2026-10-03T19:27:17Z" }),
			reason: "published must be YYYY-MM-DD",
		},
		{
			what: "published as an HTTP date",
			entry: newsWith({ published: "Sat, 03 Oct 2026 19:27:17 GMT" }),
			reason: "published must be YYYY-MM-DD",
		},
		{
			what: "published without a leading zero",
			entry: newsWith({ published: "2026-10-4" }),
			reason: "published must be YYYY-MM-DD",
		},
		{
			what: 'published "yesterday"',
			entry: newsWith({ published: "yesterday" }),
			reason: "published must be YYYY-MM-DD",
		},
		{
			what: "published 30 February",
			entry: newsWith({ published: "2026-02-30" }),
			reason: "published is not a real date",
		},
		{
			what: "published 13th month",
			entry: newsWith({ published: "2026-13-01" }),
			reason: "published is not a real date",
		},
		{
			what: "no published",
			entry: newsWithout(["published"]),
			reason: "published is missing",
		},
		{
			what: "no title",
			entry: newsWithout(["title"]),
			reason: "title is missing",
		},
		{
			what: "a title of only spaces",
			entry: newsWith({ title: "   " }),
			reason: "title is missing",
		},
		{
			what: "no source",
			entry: newsWithout(["source"]),
			reason: "source is missing",
		},
		{
			what: "an empty source",
			entry: newsWith({ source: "" }),
			reason: "source is missing",
		},
		{
			what: "no type",
			entry: newsWithout(["type"]),
			reason: "type must be news, article or report",
		},
		{
			what: 'type "blog"',
			entry: newsWith({ type: "blog" }),
			reason: "type must be news, article or report",
		},
		{
			what: 'type "paper"',
			entry: newsWith({ type: "paper" }),
			reason: "papers come from scripts/scout/arxiv/arxiv.ts",
		},
		{
			what: "authors as a string",
			entry: newsWith({ authors: "Ada Example" }),
			reason: "authors must be a list of names",
		},
		{
			what: "an empty author name",
			entry: newsWith({ authors: ["Ada Example", ""] }),
			reason: "authors must be a list of names",
		},
		{
			what: "an author that is not text",
			entry: newsWith({ authors: ["Ada Example", 7] }),
			reason: "authors must be a list of names",
		},
		{
			what: "links as one object",
			entry: newsWith({
				links: { label: "PDF", url: "https://example.com/a" },
			}),
			reason: "links must be a list",
		},
		{
			what: "a link without a label",
			entry: newsWith({ links: [{ url: "https://example.com/a" }] }),
			reason: "every link needs a label and a url",
		},
		{
			what: "a link without a url",
			entry: newsWith({ links: [{ label: "PDF" }] }),
			reason: "every link needs a label and a url",
		},
		{
			what: "a javascript: link",
			entry: newsWith({
				links: [{ label: "Demo", url: "javascript:alert(1)" }],
			}),
			reason: "a link's url must be http or https",
		},
		{
			what: 'a field "abstract"',
			entry: newsWith({ abstract: "An abstract." }),
			reason: '"abstract" is not in the schema',
		},
		{
			what: 'a field "sources"',
			entry: newsWith({ sources: ["Fixture Times"] }),
			reason: '"sources" is not in the schema',
		},
		{
			what: "a description that is a number",
			entry: newsWith({ description: 42 }),
			reason: "description must be text",
		},
	];
	for (const each of cases) {
		assertHasReason(entryProblems(each.entry, "add"), each.reason, each.what);
	}
});

test("An entry without a usable url is refused", async () => {
	const { entryProblems }: typeof EntryChecks = await import(CHECKS.href);
	assertHasReason(
		entryProblems(newsWithout(["id", "url"]), "add"),
		"url is missing",
		"no url",
	);
	const ftp = newsWith({
		id: "url:ftp://example.com/news/1",
		url: "ftp://example.com/news/1",
	});
	assertHasReason(
		entryProblems(ftp, "add"),
		"url must be http or https",
		"an ftp url",
	);
	// An https url is still refused when it holds a space or a line break.
	const spaced = newsWith({
		id: "url:https://example.com/news 1",
		url: "https://example.com/news 1",
	});
	assertHasReason(
		entryProblems(spaced, "add"),
		"url must be http or https",
		"a url with a space",
	);
	const twoLines = newsWith({
		id: "url:https://example.com/news/1\nx",
		url: "https://example.com/news/1\nx",
	});
	assertHasReason(
		entryProblems(twoLines, "add"),
		"url must be http or https",
		"a url with a line break",
	);
});

test("An entry that breaks several rules is refused with every broken rule named", async () => {
	const { entryProblems }: typeof EntryChecks = await import(CHECKS.href);
	const problems = entryProblems(
		newsWith({ title: " ", source: "", published: "2026-10-4" }),
		"add",
	);
	assertHasReason(problems, "title is missing", "a blank title");
	assertHasReason(problems, "source is missing", "an empty source");
	assertHasReason(
		problems,
		"published must be YYYY-MM-DD",
		"published 2026-10-4",
	);
});

// ---- entryProblems: check ----

test("On check, a stored news entry follows the same rules as on add", async () => {
	const { entryProblems }: typeof EntryChecks = await import(CHECKS.href);
	assert.deepEqual(entryProblems(fullNews(), "check"), []);
	assertHasReason(
		entryProblems(newsWith({ summary: "A summary." }), "check"),
		'"summary" is not in the schema',
		'a field "summary"',
	);
	assertHasReason(
		entryProblems(
			newsWith({ published: "Sat, 03 Oct 2026 19:27:17 GMT" }),
			"check",
		),
		"published must be YYYY-MM-DD",
		"published as an HTTP date",
	);
	assertHasReason(
		entryProblems(newsWith({ authors: "Ada Example" }), "check"),
		"authors must be a list of names",
		"authors as a string",
	);
	assertHasReason(
		entryProblems(
			newsWith({ links: { label: "PDF", url: "https://example.com/a" } }),
			"check",
		),
		"links must be a list",
		"links as one object",
	);
});

test("On check, a paper may carry venue, pick, category and arXiv fields, and may lack a published date", async () => {
	const { entryProblems }: typeof EntryChecks = await import(CHECKS.href);
	const extras = {
		category: "cs.AI",
		venue: "NeurIPS 2026",
		venue_source: "https://neurips.cc/virtual/2026/papers.html",
		pick: "surprise",
		journal_ref: "Proc. Fixture Conf. 2026",
		comment: "12 pages, 3 figures",
	};
	assert.deepEqual(entryProblems(paper(1, extras), "check"), []);
	// published is checked only when present.
	assert.deepEqual(entryProblems(paperWithout(2, ["published"]), "check"), []);
});

test("On check, a paper without a title or id, or with a bad date, authors or links, is named", async () => {
	const { entryProblems }: typeof EntryChecks = await import(CHECKS.href);
	const cases = [
		{
			what: "a paper without a title",
			entry: paperWithout(1, ["title"]),
			reason: "title is missing",
		},
		{
			what: "a paper with a blank title",
			entry: paper(1, { title: "  " }),
			reason: "title is missing",
		},
		{
			what: "a paper without an id",
			entry: paperWithout(1, ["id"]),
			reason: "id is missing",
		},
		{
			what: "published without a leading zero",
			entry: paper(1, { published: "2026-1-02" }),
			reason: "published must be YYYY-MM-DD",
		},
		{
			what: "published 30 February",
			entry: paper(1, { published: "2026-02-30" }),
			reason: "published must be YYYY-MM-DD",
		},
		{
			what: "authors as a string",
			entry: paper(1, { authors: "Ada Example" }),
			reason: "authors must be a list of names",
		},
		{
			what: "links as one object",
			entry: paper(1, {
				links: { label: "PDF", url: "https://arxiv.org/pdf/2601.00001" },
			}),
			reason: "links must be a list",
		},
		{
			what: "a link without a url",
			entry: paper(1, { links: [{ label: "PDF" }] }),
			reason: "every link needs a label and a url",
		},
	];
	for (const each of cases) {
		assertHasReason(entryProblems(each.entry, "check"), each.reason, each.what);
	}
});

// Every address an entry holds is a web address: every field of a paper
// that holds an address, in every form that isn't one.
test("security: On check, every address field of a paper must be an http or https address, and a figure must come from arXiv", async () => {
	const { entryProblems }: typeof EntryChecks = await import(CHECKS.href);
	const figure = {
		src: "https://arxiv.org/html/2601.00001v1/x1.png",
		caption: "Figure 1: A plot.",
		from: "https://arxiv.org/html/2601.00001v1",
	};
	const cases = [
		{
			what: "a javascript: url",
			entry: paper(1, { url: "javascript:alert(1)" }),
			reason: "url must be http or https",
		},
		{
			what: "an ftp: url",
			entry: paper(1, { url: "ftp://example.com/paper.pdf" }),
			reason: "url must be http or https",
		},
		{
			what: "a url holding a space",
			entry: paper(1, { url: "https://arxiv.org/abs/2601 00001" }),
			reason: "url must be http or https",
		},
		{
			what: "a url that is a number",
			entry: paper(1, { url: 42 }),
			reason: "url must be http or https",
		},
		{
			what: "a data: link",
			entry: paper(1, { links: [{ label: "PDF", url: "data:text/html,x" }] }),
			reason: "a link's url must be http or https",
		},
		{
			what: "a file: venue_source",
			entry: paper(1, { venue: "FAccT 2026", venue_source: "file:///etc/x" }),
			reason: "venue_source must be http or https",
		},
		{
			what: "a javascript: pick_source",
			entry: paper(1, { pick: "surprise", pick_source: "javascript:void(0)" }),
			reason: "pick_source must be http or https",
		},
		{
			what: "a figure read from a file: page",
			entry: paper(1, { figure: { ...figure, from: "file:///tmp/page.html" } }),
			reason: "figure.from must be http or https",
		},
		{
			what: "a figure on another site",
			entry: paper(1, {
				figure: { ...figure, src: "https://example.com/x.png" },
			}),
			reason: "figure.src must start with https://arxiv.org/html/",
		},
		{
			what: "a figure on arXiv over http",
			entry: paper(1, {
				figure: { ...figure, src: "http://arxiv.org/html/2601.00001v1/x1.png" },
			}),
			reason: "figure.src must start with https://arxiv.org/html/",
		},
		{
			what: "a figure on a host that only starts like arXiv's",
			entry: paper(1, {
				figure: { ...figure, src: "https://arxiv.org.example.com/html/x.png" },
			}),
			reason: "figure.src must start with https://arxiv.org/html/",
		},
		{
			what: "a figure kept as a local file",
			entry: paper(1, { figure: { ...figure, src: "figures/2601.00001.png" } }),
			reason: "figure.src must start with https://arxiv.org/html/",
		},
		{
			what: "a figure that is text",
			entry: paper(1, { figure: "https://arxiv.org/html/2601.00001v1/x1.png" }),
			reason: "figure must hold a src and where it is from",
		},
	];
	for (const each of cases) {
		assertHasReason(entryProblems(each.entry, "check"), each.reason, each.what);
	}
	// A paper with none of the optional addresses, and one with all of them, pass.
	assert.deepEqual(
		entryProblems(paperWithout(2, ["url", "links"]), "check"),
		[],
	);
	assert.deepEqual(
		entryProblems(
			paper(3, {
				venue: "FAccT 2026",
				venue_source: "https://facctconference.org/2026/acceptedpapers",
				pick: "surprise",
				pick_source: "http://example.com/story",
				figure: figure,
			}),
			"check",
		),
		[],
	);
});

// A link holds a label and a url, and nothing else: for every kind
// of entry, in both modes.
test("A link with a third field is refused, for news and for papers", async () => {
	const { entryProblems }: typeof EntryChecks = await import(CHECKS.href);
	const link = {
		label: "Paper",
		url: "https://arxiv.org/abs/2507.11473",
		id: "arxiv:2507.11473",
	};
	const reason = 'a link holds only "label" and "url"';

	assertHasReason(
		entryProblems(newsWithout(["id"]), "add").concat(
			entryProblems(
				Object.assign(newsWithout(["id"]), { links: [link] }),
				"add",
			),
		),
		reason,
		"a news entry, on add",
	);
	assertHasReason(
		entryProblems(newsWith({ links: [link] }), "check"),
		reason,
		"a stored news entry",
	);
	assertHasReason(
		entryProblems(paper(1, { links: [link] }), "check"),
		reason,
		"a stored paper",
	);
	assert.deepEqual(entryProblems(newsWithout(["id"]), "add"), []);
});

// Rule "A title, a source and an author's name hold no control characters": refused when taken in (add), and left
// alone in what is stored (check), where arXiv's wrapped titles live.
test("security: A control character in a title, a source or an author's name is refused on add only", async () => {
	const { entryProblems }: typeof EntryChecks = await import(CHECKS.href);
	const cases: [JsonObject, string][] = [
		[{ title: "Fixture\npapers today: 9" }, "title holds a control character"],
		[{ title: "Fixture\u001b[2Jstory" }, "title holds a control character"],
		[{ source: "Fixture\tTimes" }, "source holds a control character"],
		[
			{ authors: ["Ada Example", "Bo\rSample"] },
			"an author's name holds a control character",
		],
	];
	for (const [fields, reason] of cases) {
		const added = Object.assign(newsWithout(["id"]), fields);
		assertHasReason(
			entryProblems(added, "add"),
			reason,
			JSON.stringify(fields),
		);
		assert.deepEqual(
			entryProblems(newsWith(fields), "check"),
			[],
			`stored: ${JSON.stringify(fields)}`,
		);
	}
	assert.deepEqual(
		entryProblems(paper(1, { title: "Probing\nfor deception" }), "check"),
		[],
	);
});

// ---- normalizeUrl ----

test("The same story's URL with tracking parameters, www, http, a trailing slash or a fragment counts as a repeat", async () => {
	const { normalizeUrl }: typeof EntryChecks = await import(CHECKS.href);
	const inFile = normalizeUrl(
		"https://www.example.com/story/42?utm_source=rss",
	);
	assert.equal(typeof inFile, "string");
	const forms = [
		"https://www.example.com/story/42?utm_source=rss",
		"https://example.com/story/42",
		"https://EXAMPLE.com/story/42/",
		"http://www.example.com/story/42#comments",
		"https://example.com/story/42?utm_medium=email&fbclid=abc",
		"https://example.com/story/42?gclid=1&msclkid=2&mc_cid=3&mc_eid=4",
		"https://example.com/story/42?utm_campaign=autumn&utm_content=link&utm_term=buoys",
	];
	for (const form of forms) {
		assert.equal(normalizeUrl(form), inFile, form);
	}
});

test("A different query is a different page", async () => {
	const { normalizeUrl }: typeof EntryChecks = await import(CHECKS.href);
	assert.notEqual(
		normalizeUrl("https://example.com/item?id=2"),
		normalizeUrl("https://example.com/item?id=1"),
	);
	assert.notEqual(
		normalizeUrl("https://example.com/item?id=1"),
		normalizeUrl("https://example.com/item"),
	);
	// Tracking parameters go; the others stay.
	assert.equal(
		normalizeUrl("https://example.com/item?id=1&utm_source=rss"),
		normalizeUrl("https://example.com/item?id=1"),
	);
	// A different path is a different page too.
	assert.notEqual(
		normalizeUrl("https://example.com/story/43"),
		normalizeUrl("https://example.com/story/42"),
	);
});

test("A paper's URL counts as a repeat too", async () => {
	const { normalizeUrl }: typeof EntryChecks = await import(CHECKS.href);
	assert.equal(
		normalizeUrl("http://www.arxiv.org/abs/2507.11473/"),
		normalizeUrl("https://arxiv.org/abs/2507.11473"),
	);
});

// ---- checkText ----

// Three lines with papers (one a surprise), news, articles and reports: 12 entries.
function wellFormedText() {
	return (
		digestLine("2026-09-25", [paper(1), paper(2), paper(3), fullNews()]) +
		digestLine("2026-09-26", [
			paper(4),
			paper(5, { pick: "surprise" }),
			item("article", 21, "2026-09-26"),
			item("report", 22, "2026-09-25"),
		]) +
		digestLine("2026-09-27", [
			paper(6),
			item("news", 23, "2026-09-27"),
			item("article", 24, "2026-09-27"),
			item("report", 25, "2026-09-26"),
		])
	);
}

// The valid line every broken file starts with.
const VALID_FIRST_LINE = digestLine("2026-09-26", [
	paper(1),
	item("news", 30, "2026-09-26"),
]);

test("A well-formed file passes check with its lines and entries counted, blank lines left out", async () => {
	const { checkText }: typeof Digests = await import(SCRIPT.href);
	assert.deepEqual(checkText(wellFormedText()), {
		lines: 3,
		entries: 12,
		problems: [],
	});
	// Blank lines are not counted.
	assert.deepEqual(checkText(`${wellFormedText()}\n\n`), {
		lines: 3,
		entries: 12,
		problems: [],
	});
});

test('A last line that ends in "})" or "});" without a line break loads', async () => {
	const { checkText }: typeof Digests = await import(SCRIPT.href);
	const call =
		"digest(" +
		JSON.stringify({ date: "2026-09-27", entries: [fullNews()] }) +
		")";
	assert.deepEqual(checkText(call), { lines: 1, entries: 1, problems: [] });
	assert.deepEqual(checkText(`${call};`), {
		lines: 1,
		entries: 1,
		problems: [],
	});
});

test("A line that does not load is named by its number, and the valid line before it is not", async () => {
	const { checkText }: typeof Digests = await import(SCRIPT.href);
	const newsJson = JSON.stringify(item("news", 31, "2026-09-27"));
	const quoted = JSON.stringify(
		Object.assign(item("news", 32, "2026-09-27"), {
			title: "Hinton's fixture story",
		}),
	);
	const cases = [
		{
			what: "a trailing comma after the last entry",
			second: `digest({"date":"2026-09-27","entries":[${newsJson},]});\n`,
		},
		// Node's parser gives a position for this one ("Bad escaped character ... (line 1 column 48)", measured).
		{
			what: "a \\' escape inside a title",
			second:
				'digest({"date":"2026-09-27","entries":[' +
				quoted.replace("Hinton's", "Hinton\\'s") +
				"]});\n",
		},
		{
			what: "a line that is not a digest line",
			second: "var notADigestLine = true;\n",
		},
	];
	for (const each of cases) {
		const problems = checkText(VALID_FIRST_LINE + each.second).problems;
		assertNamesLineNotLoading(problems, 2, each.what);
		for (const problem of problems) {
			assert.ok(
				!problem.startsWith("line 1:"),
				`${each.what}: the valid first line is not named; got ${problem}`,
			);
		}
	}
});

test("A line with a bad date, entries that are not a list or a bad entry is named with its line number and the entry's id", async () => {
	const { checkText }: typeof Digests = await import(SCRIPT.href);
	const cases = [
		{
			what: 'digest date "2026-10-4"',
			second: digestLine("2026-10-4", [item("news", 33, "2026-10-04")]),
			prefix: "line 2: ",
			reason: "date must be YYYY-MM-DD",
		},
		{
			what: 'digest date "2026-02-30"',
			second: digestLine("2026-02-30", [item("news", 33, "2026-10-04")]),
			prefix: "line 2: ",
			reason: "date must be YYYY-MM-DD",
		},
		{
			what: "entries as one object",
			second:
				"digest(" +
				JSON.stringify({
					date: "2026-09-27",
					entries: item("news", 34, "2026-09-27"),
				}) +
				");\n",
			prefix: "line 2: ",
			reason: "entries must be a list",
		},
		{
			what: "a news entry with published as an HTTP date",
			second: digestLine("2026-09-27", [
				Object.assign(item("news", 35, "2026-09-27"), {
					published: "Sat, 03 Oct 2026 19:27:17 GMT",
				}),
			]),
			prefix: "line 2: url:https://example.com/news/35: ",
			reason: "published must be YYYY-MM-DD",
		},
		{
			what: 'a news entry with a field "summary"',
			second: digestLine("2026-09-27", [
				Object.assign(item("news", 36, "2026-09-27"), {
					summary: "A summary.",
				}),
			]),
			prefix: "line 2: url:https://example.com/news/36: ",
			reason: '"summary" is not in the schema',
		},
		{
			what: 'a news entry with authors "Ada Example"',
			second: digestLine("2026-09-27", [
				Object.assign(item("news", 39, "2026-09-27"), {
					authors: "Ada Example",
				}),
			]),
			prefix: "line 2: url:https://example.com/news/39: ",
			reason: "authors must be a list of names",
		},
		{
			what: "a news entry with links as one object",
			second: digestLine("2026-09-27", [
				Object.assign(item("news", 40, "2026-09-27"), {
					links: { label: "PDF", url: "https://example.com/a" },
				}),
			]),
			prefix: "line 2: url:https://example.com/news/40: ",
			reason: "links must be a list",
		},
		{
			what: "a paper without a title",
			second: digestLine("2026-09-27", [paperWithout(37, ["title"])]),
			prefix: "line 2: arxiv:2601.00037: ",
			reason: "title is missing",
		},
		// Named "entry k"; whether k counts within the line or the file is left open, so only the line is checked.
		{
			what: "a paper without an id",
			second: digestLine("2026-09-27", [paperWithout(38, ["id"])]),
			prefix: "line 2: ",
			reason: "id is missing",
		},
	];
	for (const each of cases) {
		const result = checkText(VALID_FIRST_LINE + each.second);
		assertHasProblem(result.problems, each.prefix, each.reason);
		for (const problem of result.problems) {
			assert.ok(
				!problem.startsWith("line 1:"),
				`${each.what}: the valid first line is not named; got ${problem}`,
			);
		}
	}
});

test("An entry that is not an object is named with its place in the line", async () => {
	const { checkText }: typeof Digests = await import(SCRIPT.href);
	const text =
		"digest(" +
		JSON.stringify({
			date: "2026-09-27",
			entries: [paper(1), "not an entry"],
		}) +
		");\n";
	assertHasProblem(
		checkText(text).problems,
		"line 1: ",
		"entry 2 is not an object",
	);
});

test("A line wrapped in two is named as two lines that don't load", async () => {
	const { checkText }: typeof Digests = await import(SCRIPT.href);
	const wrapped =
		'digest({"date":"2026-09-27","entries":[\n' +
		JSON.stringify(item("news", 41, "2026-09-27")) +
		"]});\n";
	const problems = checkText(VALID_FIRST_LINE + wrapped).problems;
	assertNamesLineNotLoading(problems, 2, "the first half");
	assertNamesLineNotLoading(problems, 3, "the second half");
});

test("Every problem is named, not only the first", async () => {
	const { checkText }: typeof Digests = await import(SCRIPT.href);
	const unloadable =
		'digest({"date":"2026-09-27","entries":[' +
		JSON.stringify(item("news", 42, "2026-09-27")) +
		",]});\n";
	const badDate = digestLine("2026-10-4", [item("news", 43, "2026-10-04")]);
	const problems = checkText(VALID_FIRST_LINE + unloadable + badDate).problems;
	assertNamesLineNotLoading(problems, 2, "a trailing comma");
	assertHasProblem(problems, "line 3: ", "date must be YYYY-MM-DD");
});

test("privacy: A digests line that doesn't load is named without quoting it", async () => {
	const { checkText }: typeof Digests = await import(SCRIPT.href);

	// The scenario's line: not a digest line at all.
	const notADigest = checkText(
		`${VALID_FIRST_LINE}SECRET-7f3a(not a digest)\n`,
	).problems;
	assertNamesLineNotLoading(
		notADigest,
		2,
		"a line reading SECRET-7f3a(not a digest)",
	);
	assertQuotesNothing(
		notADigest,
		"7f3a",
		"a line reading SECRET-7f3a(not a digest)",
	);

	// A digest line whose JSON breaks just after the marker: a trailing comma follows the entry that ends in it.
	const entry = Object.assign(item("news", 44, "2026-09-27"), {
		description: "Ends in SECRET-7f3a",
	});
	const json = `{"date":"2026-09-27","entries":[${JSON.stringify(entry)},]}`;
	// Node's own message for this JSON quotes the text around the error, marker included, so passing it on fails below.
	assert.throws(
		() => JSON.parse(json),
		(error: unknown) =>
			error instanceof Error && error.message.includes("7f3a"),
	);
	const trailingComma = checkText(
		`${VALID_FIRST_LINE}digest(${json});\n`,
	).problems;
	assertNamesLineNotLoading(
		trailingComma,
		2,
		"a trailing comma after an entry ending in the marker",
	);
	assertQuotesNothing(
		trailingComma,
		"7f3a",
		"a trailing comma after an entry ending in the marker",
	);
});

test("An id on two lines is named with both line numbers", async () => {
	const { checkText }: typeof Digests = await import(SCRIPT.href);
	const repeated = paper(1, {
		id: "arxiv:2507.11473",
		url: "https://arxiv.org/abs/2507.11473",
	});
	const text =
		digestLine("2026-09-25", [repeated]) +
		digestLine("2026-09-26", [paper(2)]) +
		digestLine("2026-09-27", [repeated]);
	const problems = checkText(text).problems;
	assert.ok(
		problems.includes("id arxiv:2507.11473 is on lines 1 and 3"),
		JSON.stringify(problems),
	);
});

// ---- statusText ----

test("status counts the papers on all of today's lines, not the lines", async () => {
	const { statusText }: typeof Digests = await import(SCRIPT.href);
	const text =
		digestLine("2026-10-04", papers(1, 6)) +
		digestLine("2026-10-05", papers(11, 4)) +
		digestLine("2026-10-05", papers(21, 2)) +
		digestLine("2026-10-05", papers(31, 1));
	const expected = [
		"today: 2026-10-05 (Asia/Jakarta)",
		"days without papers in the last 7: 2026-09-28, 2026-09-29, 2026-09-30, 2026-10-01, 2026-10-02, 2026-10-03",
		"papers today: 7",
		"surprise today: no",
		"news, articles and reports today: 0",
		"news, articles and reports from the last 7 days: none",
	].join("\n");
	assert.equal(
		withoutFinalLineBreak(statusText(text, "2026-10-05", null)),
		expected,
	);
});

test("The surprise paper doesn't count toward today's papers", async () => {
	const { statusText }: typeof Digests = await import(SCRIPT.href);
	const text = digestLine("2026-10-05", [
		paper(1),
		paper(2),
		paper(3, { pick: "surprise" }),
	]);
	const lines = statusText(text, "2026-10-05", null).split("\n");
	assert.ok(lines.includes("papers today: 2"), lines.join("\n"));
	assert.ok(lines.includes("surprise today: yes"), lines.join("\n"));
});

test("status says whether today has a surprise paper, whatever yesterday had", async () => {
	const { statusText }: typeof Digests = await import(SCRIPT.href);
	const yesterdaysSurprise = digestLine("2026-10-04", [
		paper(50, { pick: "surprise" }),
	]);
	const withSurprise =
		yesterdaysSurprise +
		digestLine("2026-10-05", [
			paper(1),
			paper(2),
			paper(3, { pick: "surprise" }),
		]);
	const withoutSurprise =
		yesterdaysSurprise + digestLine("2026-10-05", papers(1, 3));
	assert.ok(
		statusText(withSurprise, "2026-10-05", null)
			.split("\n")
			.includes("surprise today: yes"),
	);
	assert.ok(
		statusText(withoutSurprise, "2026-10-05", null)
			.split("\n")
			.includes("surprise today: no"),
	);
});

test("News, articles and reports today are counted", async () => {
	const { statusText }: typeof Digests = await import(SCRIPT.href);
	const text = digestLine("2026-10-05", [
		paper(1),
		paper(2),
		item("news", 1, "2026-10-04"),
		item("report", 1, "2026-10-05"),
	]);
	const expected = [
		"today: 2026-10-05 (Asia/Jakarta)",
		"days without papers in the last 7: 2026-09-28, 2026-09-29, 2026-09-30, 2026-10-01, 2026-10-02, 2026-10-03, 2026-10-04",
		"papers today: 2",
		"surprise today: no",
		"news, articles and reports today: 2",
		"news, articles and reports from the last 7 days:",
		"2026-10-05 news url:https://example.com/news/1 Fixture news story 1",
		"2026-10-05 report url:https://example.com/reports/1 Fixture report 1",
	].join("\n");
	assert.equal(
		withoutFinalLineBreak(statusText(text, "2026-10-05", null)),
		expected,
	);
});

// Today is 3 October, so the 7 days reach back to 27 September across the month's end. The lines are out of date
// order (3 days ago was appended after today), and the day is the line's date, never "published".
test("News, articles and reports from the last 7 days are listed", async () => {
	const { statusText }: typeof Digests = await import(SCRIPT.href);
	const text =
		digestLine("2026-09-26", [item("news", 34, "2026-09-25")]) +
		digestLine("2026-09-27", [item("report", 33, "2026-09-26")]) +
		digestLine("2026-10-03", [paper(1), item("news", 31, "2026-10-02")]) +
		digestLine("2026-09-30", [item("article", 32, "2026-09-29")]) +
		digestLine("2026-10-03", [item("report", 35, "2026-10-03")]) +
		digestLine("2026-09-24", [item("news", 36, "2026-10-03")]);
	const expected = [
		"today: 2026-10-03 (Asia/Jakarta)",
		"days without papers in the last 7: 2026-09-26, 2026-09-27, 2026-09-28, 2026-09-29, 2026-09-30, 2026-10-01, 2026-10-02",
		"papers today: 1",
		"surprise today: no",
		"news, articles and reports today: 2",
		"news, articles and reports from the last 7 days:",
		"2026-10-03 news url:https://example.com/news/31 Fixture news story 31",
		"2026-10-03 report url:https://example.com/reports/35 Fixture report 35",
		"2026-09-30 article url:https://example.com/articles/32 Fixture article 32",
		"2026-09-27 report url:https://example.com/reports/33 Fixture report 33",
	].join("\n");
	assert.equal(
		withoutFinalLineBreak(statusText(text, "2026-10-03", null)),
		expected,
	);
});

test("Lines older than the last 7 days do not change the status output", async () => {
	const { statusText }: typeof Digests = await import(SCRIPT.href);
	// 30 days ending 5 October, oldest first, each with 3 papers and 2 news items of its own.
	const lines = [];
	for (let daysAgo = 29; daysAgo >= 0; daysAgo--) {
		// Date.UTC counts months from 0 (9 is October) and rolls a day below 1 back into September.
		const day = new Date(Date.UTC(2026, 9, 5 - daysAgo));
		const date = day.toISOString().slice(0, 10);
		const entries = papers(daysAgo * 3 + 1, 3);
		entries.push(item("news", `day-${daysAgo}-1`, date));
		entries.push(item("news", `day-${daysAgo}-2`, date));
		lines.push(digestLine(date, entries));
	}
	const allDays = lines.join("");
	// Today and the 7 days before: the missing-days line reads those 7 days, the list the last 7 including today.
	const lastEightDays = lines.slice(lines.length - 8).join("");
	assert.equal(
		statusText(allDays, "2026-10-05", null),
		statusText(lastEightDays, "2026-10-05", null),
	);
	// The 7 listed days' 14 news items are listed, so the two texts are not equal by being empty.
	const listed = withoutFinalLineBreak(
		statusText(allDays, "2026-10-05", null),
	).split("\n");
	const header = listed.indexOf(
		"news, articles and reports from the last 7 days:",
	);
	assert.equal(listed.length - header - 1, 14);
});

test("An empty or missing digests file has nothing today", async () => {
	const { statusText }: typeof Digests = await import(SCRIPT.href);
	const expected = [
		"today: 2026-10-05 (Asia/Jakarta)",
		"days without papers in the last 7: 2026-09-28, 2026-09-29, 2026-09-30, 2026-10-01, 2026-10-02, 2026-10-03, 2026-10-04",
		"papers today: 0",
		"surprise today: no",
		"news, articles and reports today: 0",
		"news, articles and reports from the last 7 days: none",
	].join("\n");
	assert.equal(
		withoutFinalLineBreak(statusText("", "2026-10-05", null)),
		expected,
	);
});

// ---- statusText with --date: today is the real today (for the missing days), date the day being filled in ----

test("status with --date counts that day", async () => {
	const { statusText }: typeof Digests = await import(SCRIPT.href);
	const filledDay = papers(1, 3);
	filledDay.push(paper(4, { pick: "surprise" }));
	const text =
		digestLine("2026-10-10", filledDay) +
		digestLine("2026-10-12", papers(11, 6));
	const expected = [
		"today: 2026-10-10 (Asia/Jakarta, set by --date)",
		"days without papers in the last 7: 2026-10-05, 2026-10-06, 2026-10-07, 2026-10-08, 2026-10-09, 2026-10-11",
		"papers today: 3",
		"surprise today: yes",
		"news, articles and reports today: 0",
		"news, articles and reports from the last 7 days: none",
	].join("\n");
	assert.equal(
		withoutFinalLineBreak(statusText(text, "2026-10-12", "2026-10-10")),
		expected,
	);
});

// Filling in 10 October on 12 October: the list runs from 4 October (the week before the 10th) through the newest
// digest, 12 October, so the news of 3 October is left out.
test("status with --date lists news from the week before that day through the newest digest", async () => {
	const { statusText }: typeof Digests = await import(SCRIPT.href);
	const text =
		digestLine("2026-10-03", [item("news", 9, "2026-10-03")]) +
		digestLine("2026-10-04", [item("news", 8, "2026-10-04")]) +
		digestLine("2026-10-07", [item("news", 5, "2026-10-07")]) +
		digestLine("2026-10-11", [item("news", 1, "2026-10-11")]) +
		digestLine("2026-10-12", [item("news", 0, "2026-10-12")]);
	const expected = [
		"today: 2026-10-10 (Asia/Jakarta, set by --date)",
		"days without papers in the last 7: 2026-10-05, 2026-10-06, 2026-10-07, 2026-10-08, 2026-10-09, 2026-10-10, 2026-10-11",
		"papers today: 0",
		"surprise today: no",
		"news, articles and reports today: 0",
		"news, articles and reports from the last 7 days:",
		"2026-10-12 news url:https://example.com/news/0 Fixture news story 0",
		"2026-10-11 news url:https://example.com/news/1 Fixture news story 1",
		"2026-10-07 news url:https://example.com/news/5 Fixture news story 5",
		"2026-10-04 news url:https://example.com/news/8 Fixture news story 8",
	].join("\n");
	assert.equal(
		withoutFinalLineBreak(statusText(text, "2026-10-12", "2026-10-10")),
		expected,
	);
});

// ---- missingDays ----

test("Days without papers in the last 7 are listed, oldest first", async () => {
	const { missingDays }: typeof Digests = await import(SCRIPT.href);
	const text =
		digestLine("2026-10-05", papers(1, 2)) +
		digestLine("2026-10-08", papers(11, 2)) +
		digestLine("2026-10-11", papers(21, 2)) +
		digestLine("2026-10-12", papers(31, 2));
	assert.deepEqual(missingDays(text, "2026-10-12"), [
		"2026-10-06",
		"2026-10-07",
		"2026-10-09",
		"2026-10-10",
	]);
});

test("A day with only news, articles and reports counts as missed", async () => {
	const { missingDays }: typeof Digests = await import(SCRIPT.href);
	let text = "";
	for (let day = 5; day <= 11; day++) {
		const date = `2026-10-${String(day).padStart(2, "0")}`;
		if (day === 9) {
			text += digestLine(date, [newsWith({})]);
		} else {
			text += digestLine(date, [paper(day)]);
		}
	}
	assert.deepEqual(missingDays(text, "2026-10-12"), ["2026-10-09"]);
});

test("A week with papers on every day has no missing days", async () => {
	const { missingDays }: typeof Digests = await import(SCRIPT.href);
	let text = "";
	for (let day = 5; day <= 11; day++) {
		text += digestLine(`2026-10-${String(day).padStart(2, "0")}`, [paper(day)]);
	}
	text += digestLine("2026-10-12", [paper(12)]);
	assert.deepEqual(missingDays(text, "2026-10-12"), []);
});

test("Today doesn't count as missing", async () => {
	const { missingDays }: typeof Digests = await import(SCRIPT.href);
	let text = "";
	for (let day = 5; day <= 11; day++) {
		text += digestLine(`2026-10-${String(day).padStart(2, "0")}`, [paper(day)]);
	}
	assert.deepEqual(missingDays(text, "2026-10-12"), []);
});

test("A file that doesn't exist yet misses all 7 days", async () => {
	const { missingDays }: typeof Digests = await import(SCRIPT.href);
	assert.deepEqual(missingDays("", "2026-10-12"), [
		"2026-10-05",
		"2026-10-06",
		"2026-10-07",
		"2026-10-08",
		"2026-10-09",
		"2026-10-10",
		"2026-10-11",
	]);
});

// Today is 3 October, so the 7 days reach back to 26 September. Lines out of date order count, and lines older than the
// 7 days or after today don't fill a day.
test("The 7 days count back across a month's end, whatever the order of the lines", async () => {
	const { missingDays }: typeof Digests = await import(SCRIPT.href);
	const text =
		digestLine("2026-10-02", [paper(1)]) +
		digestLine("2026-09-25", [paper(2)]) +
		digestLine("2026-09-27", [paper(3)]) +
		digestLine("2026-10-04", [paper(4)]) +
		digestLine("2026-09-30", [paper(5)]);
	assert.deepEqual(missingDays(text, "2026-10-03"), [
		"2026-09-26",
		"2026-09-28",
		"2026-09-29",
		"2026-10-01",
	]);
});

// The line dated 10 October has a trailing comma after its last entry, so it doesn't load and doesn't fill its day.
test("A line that does not load does not fill its day", async () => {
	const { missingDays }: typeof Digests = await import(SCRIPT.href);
	let text = "";
	for (let day = 5; day <= 11; day++) {
		const date = `2026-10-${String(day).padStart(2, "0")}`;
		if (day === 10) {
			text += `digest({"date":"${date}","entries":[${JSON.stringify(paper(day))},]});\n`;
		} else {
			text += digestLine(date, [paper(day)]);
		}
	}
	text += "var notADigestLine = true;\n";
	assert.deepEqual(missingDays(text, "2026-10-12"), ["2026-10-10"]);
});

// isUsableDescription(text), backing "A description is usable when it holds 8 or more words once links are taken out".
test("A description is usable when it holds 8 or more words once links are taken out", async () => {
	const { isUsableDescription }: typeof EntryChecks = await import(CHECKS.href);
	const cases: [string, boolean][] = [
		["Introduction", false],
		[
			"Paper: https://arxiv.org/abs/2609.35291 • Code: https://github.com/x",
			false,
		],
		["Linkpost to arXiv: https://arxiv.org/abs/2610.02557", false],
		["Flock says its network has over 120K cameras across 49 states", true],
		["One two three four five six seven eight", true],
		["One two three four five six seven", false],
		["One — two • three – four · five / six & seven", false],
		[
			"Read https://a.example/1 https://b.example/2 https://c.example/3 and four more words here",
			false,
		],
		["", false],
	];
	for (const [text, usable] of cases) {
		assert.equal(isUsableDescription(text), usable, text);
	}
});

// cutAtWord(text, max), the cut the newsfeed (300) and describe.ts (500) share: at most `max` characters, the "…"
// included, cut where a word ends; a text with no space in reach is cut where it stands.
test('A text is cut at a word and ends in "…"; one that fits is left alone', async () => {
	const { cutAtWord }: typeof EntryChecks = await import(CHECKS.href);

	assert.equal(cutAtWord("Sparse probes", 13), "Sparse probes");
	assert.equal(cutAtWord("Sparse probes find features", 13), "Sparse…");
	// A word that ends exactly where the cut falls goes too, as in the newsfeed's descriptions.
	assert.equal(cutAtWord("Sparse probes find features", 14), "Sparse…");
	assert.equal(cutAtWord("Sparse probes find features", 15), "Sparse probes…");
	assert.equal(cutAtWord("Sparseprobesfindfeatures", 10), "Sparsepro…");
	assert.equal(cutAtWord("", 10), "");
});

// withoutControlCharacters(text), backing "Control characters in a description are dropped": a terminal escape sequence goes whole, not only its first character.
test("security: Escape sequences and control characters are taken out of a text", async () => {
	const { withoutControlCharacters }: typeof EntryChecks = await import(
		CHECKS.href
	);

	assert.equal(withoutControlCharacters("Buoys\u001b[2J cut"), "Buoys cut");
	assert.equal(
		withoutControlCharacters(
			"\u001b[31mred\u001b[0m and \u001b]0;title\u0007plain",
		),
		"red and plain",
	);
	assert.equal(
		withoutControlCharacters("a\u0000b\tc\nd\re\u007ff\u0085g\u009fh"),
		"abcdefgh",
	);
	assert.equal(
		withoutControlCharacters("Café — it’s 5 °C"),
		"Café — it’s 5 °C",
	);
});

// hasControlCharacter counts every character a reader may take for a line break or a control: the C0 range and DEL,
// the C1 range (U+0085 is "next line") and the line and paragraph separators.
test("security: A control character is any of C0, DEL, C1, U+2028 and U+2029", async () => {
	const { hasControlCharacter, entryProblems }: typeof EntryChecks =
		await import(CHECKS.href);
	for (const character of [
		"\n",
		"\t",
		"\u001b",
		"\u007f",
		"\u0085",
		"\u009b",
		"\u2028",
		"\u2029",
	]) {
		assert.equal(
			hasControlCharacter(`a${character}b`),
			true,
			`U+${character.charCodeAt(0).toString(16)}`,
		);
	}
	for (const text of ["Café — it’s 5 °C", "a b", "日本語"]) {
		assert.equal(hasControlCharacter(text), false, text);
	}
	const added = Object.assign(newsWithout(["id"]), {
		title: "Fixture\u0085papers today: 9",
	});
	assert.ok(
		entryProblems(added, "add").includes("title holds a control character"),
	);
});

test("an entry with a field over its cap is refused", async () => {
	const {
		entryProblems,
		FIELD_CAPS,
		MAX_AUTHORS,
		MAX_LINKS,
	}: typeof EntryChecks = await import(CHECKS.href);
	// An address of exactly `length`.
	const webAddress = (length: number) =>
		`https://example.com/${"a".repeat(length - "https://example.com/".length)}`;
	const text = (length: number) => "x".repeat(length);
	const link = (label: string, address: string) => [
		{ label: label, url: address },
	];
	// At-cap and over-cap values.
	const fields: {
		fits: JsonObject;
		over: JsonObject;
		refusal: RegExp;
	}[] = [
		{
			fits: { title: text(FIELD_CAPS.title) },
			over: { title: text(FIELD_CAPS.title + 1) },
			refusal: /title is over/,
		},
		{
			fits: { source: text(FIELD_CAPS.source) },
			over: { source: text(FIELD_CAPS.source + 1) },
			refusal: /source is over/,
		},
		{
			fits: { description: text(FIELD_CAPS.description) },
			over: { description: text(FIELD_CAPS.description + 1) },
			refusal: /description is over/,
		},
		{
			fits: { authors: [text(FIELD_CAPS.authorName)] },
			over: { authors: [text(FIELD_CAPS.authorName + 1)] },
			refusal: /an author's name is over/,
		},
		{
			fits: { authors: Array.from({ length: MAX_AUTHORS }, () => "Ada") },
			over: { authors: Array.from({ length: MAX_AUTHORS + 1 }, () => "Ada") },
			refusal: /authors holds more than/,
		},
		{
			fits: { links: link(text(FIELD_CAPS.linkLabel), "https://a.example") },
			over: {
				links: link(text(FIELD_CAPS.linkLabel + 1), "https://a.example"),
			},
			refusal: /a link's label is over/,
		},
		{
			fits: { links: link("Report", webAddress(FIELD_CAPS.url)) },
			over: { links: link("Report", webAddress(FIELD_CAPS.url + 1)) },
			refusal: /a link's url is over/,
		},
		{
			fits: {
				links: Array.from({ length: MAX_LINKS }, (_, n) => ({
					label: `Link ${n}`,
					url: `https://example.com/${n}`,
				})),
			},
			over: {
				links: Array.from({ length: MAX_LINKS + 1 }, (_, n) => ({
					label: `Link ${n}`,
					url: `https://example.com/${n}`,
				})),
			},
			refusal: /links holds more than/,
		},
		{
			fits: {
				url: webAddress(FIELD_CAPS.url),
				id: `url:${webAddress(FIELD_CAPS.url)}`,
			},
			over: {
				url: webAddress(FIELD_CAPS.url + 1),
				id: `url:${webAddress(FIELD_CAPS.url + 1)}`,
			},
			refusal: /url is over/,
		},
	];
	for (const mode of ["add", "check"] as const) {
		for (const { fits, over, refusal } of fields) {
			assert.deepEqual(entryProblems(newsWith(fits), mode), [], mode);
			const problems = entryProblems(newsWith(over), mode).join("; ");
			assert.match(problems, refusal, mode);
		}
	}
	// Paper fields too.
	const figureSite = "https://arxiv.org/html/";
	const figureAddress = (length: number) =>
		`${figureSite}${"a".repeat(length - figureSite.length)}`;
	const paperFields: {
		fits: JsonObject;
		over: JsonObject;
		refusal: RegExp;
	}[] = [
		{
			fits: { title: text(FIELD_CAPS.title) },
			over: { title: text(FIELD_CAPS.title + 1) },
			refusal: /title is over/,
		},
		{
			fits: { abstract: text(FIELD_CAPS.abstract) },
			over: { abstract: text(FIELD_CAPS.abstract + 1) },
			refusal: /abstract is over/,
		},
		{
			fits: { id: `arxiv:${text(FIELD_CAPS.id - "arxiv:".length)}` },
			over: { id: `arxiv:${text(FIELD_CAPS.id - "arxiv:".length + 1)}` },
			refusal: /id is over/,
		},
		{
			fits: { venue_source: webAddress(FIELD_CAPS.url) },
			over: { venue_source: webAddress(FIELD_CAPS.url + 1) },
			refusal: /venue_source is over/,
		},
		{
			fits: { pick_source: webAddress(FIELD_CAPS.url) },
			over: { pick_source: webAddress(FIELD_CAPS.url + 1) },
			refusal: /pick_source is over/,
		},
		{
			fits: { figure: { src: figureAddress(FIELD_CAPS.url) } },
			over: { figure: { src: figureAddress(FIELD_CAPS.url + 1) } },
			refusal: /figure\.src is over/,
		},
		{
			fits: {
				figure: { src: figureAddress(30), from: webAddress(FIELD_CAPS.url) },
			},
			over: {
				figure: {
					src: figureAddress(30),
					from: webAddress(FIELD_CAPS.url + 1),
				},
			},
			refusal: /figure\.from is over/,
		},
	];
	for (const { fits, over, refusal } of paperFields) {
		assert.deepEqual(entryProblems(paper(1, fits), "check"), []);
		assert.match(entryProblems(paper(1, over), "check").join("; "), refusal);
	}
});

// An OpenAI blog post with a figure from OpenAI's own image addresses.
function labPost(figure: JsonObject) {
	const url = "https://openai.com/index/combatting-adversarial-distillation/";
	return newsWith({
		id: `url:${url}`,
		url: url,
		figure: { from: url, ...figure },
	});
}

const OPENAI_FIGURE =
	"https://images.ctfassets.net/kftzwdyauwt9/v3SwlCju2INrQ6LXdq8eB/d0aca54aed53ede3aee7ffc0c40b0646/diagram.png";

test("A lab post's figure is accepted only from that lab's own image addresses", async () => {
	const { entryProblems }: typeof EntryChecks = await import(CHECKS.href);
	const accepted = labPost({
		src: OPENAI_FIGURE,
		alt: "Two layers of anti-distillation safeguards.",
		caption: "Figure 1: Two layers.",
	});
	assert.deepEqual(entryProblems(accepted, "check"), []);
	const refused = [
		{
			what: "another Contentful customer's image",
			figure: { src: "https://images.ctfassets.net/otherspace/x/y/z.png" },
			reason: "figure.src must be an image address of the post's lab",
		},
		{
			what: "Anthropic's image on an OpenAI post",
			figure: { src: "https://assets.claude.com/9072701b.jpg" },
			reason: "figure.src must be an image address of the post's lab",
		},
		{
			what: "a figure read from another page",
			figure: { src: OPENAI_FIGURE, from: "https://openai.com/index/other/" },
			reason: "figure.from must be the post's url",
		},
		{
			what: "an alt text that is not text",
			figure: { src: OPENAI_FIGURE, alt: 3 },
			reason: "figure.alt must be text",
		},
	];
	for (const each of refused) {
		assertHasReason(
			entryProblems(labPost(each.figure), "check"),
			each.reason,
			each.what,
		);
	}
	assertHasReason(
		entryProblems(labPost({ src: OPENAI_FIGURE }), "add"),
		"a figure comes from scripts/scout/web/post-figure.ts",
		"a figure sent through add",
	);
});

test("A figure on an item from a news site or an unlisted blog is refused", async () => {
	const { entryProblems }: typeof EntryChecks = await import(CHECKS.href);
	for (const url of [
		"https://www.nytimes.com/2026/11/20/technology/ai.html",
		"https://blog.redwoodresearch.org/p/a-post",
	]) {
		const entry = newsWith({
			id: `url:${url}`,
			url: url,
			figure: { src: "https://substackcdn.com/image/x.png", from: url },
		});
		assertHasReason(
			entryProblems(entry, "check"),
			"figure.src must be an image address of the post's lab",
			url,
		);
	}
});

test("security: a lab figure address that is not https, or carries a user name or password, is refused", async () => {
	const { entryProblems }: typeof EntryChecks = await import(CHECKS.href);
	for (const src of [
		OPENAI_FIGURE.replace("https:", "http:"),
		OPENAI_FIGURE.replace("https://", "https://user:secret@"),
		"https://images.ctfassets.net.example.com/kftzwdyauwt9/x.png",
		"javascript:alert(1)",
	]) {
		assertHasReason(
			entryProblems(labPost({ src: src }), "check"),
			"figure.src must be an image address of the post's lab",
			src,
		);
	}
});

test("A paper's camera_ready holds an https url, its venue and where it was read", async () => {
	const { entryProblems }: typeof EntryChecks = await import(CHECKS.href);
	const cameraReady = {
		url: "https://proceedings.mlr.press/v306/shapira26a.html",
		venue: "ICML 2026",
		from: "https://proceedings.mlr.press/v306/assets/bib/bibliography.bib",
	};
	assert.deepEqual(
		entryProblems(paper(1, { camera_ready: cameraReady }), "check"),
		[],
	);
	const refused = [
		{
			value: {
				...cameraReady,
				url: "http://proceedings.mlr.press/v306/x.html",
			},
			reason: "camera_ready.url must be https",
		},
		{
			value: { ...cameraReady, url: "javascript:alert(1)" },
			reason: "camera_ready.url must be https",
		},
		{
			value: { ...cameraReady, venue: "" },
			reason: "camera_ready.venue is missing",
		},
		{
			value: { ...cameraReady, from: "file:///etc/passwd" },
			reason: "camera_ready.from must be http or https",
		},
		{
			value: "https://proceedings.mlr.press/v306/x.html",
			reason: "camera_ready must hold a url, a venue and where it was read",
		},
	];
	for (const each of refused) {
		assertHasReason(
			entryProblems(paper(1, { camera_ready: each.value }), "check"),
			each.reason,
			JSON.stringify(each.value),
		);
	}
});

test("A paper's openalex holds its topics with field and score, and its keywords, within their caps", async () => {
	const { entryProblems }: typeof EntryChecks = await import(CHECKS.href);
	const topic = {
		name: "Topic Modeling",
		field: "Computer Science",
		score: 0.2,
	};
	const openalex = { topics: [topic], keywords: ["transformer models"] };
	assert.deepEqual(
		entryProblems(paper(1, { openalex: openalex }), "check"),
		[],
	);
	const text = (length: number) => "x".repeat(length);
	const refused = [
		{
			value: "Topic Modeling",
			reason: "openalex must hold topics and keywords",
		},
		{
			value: { ...openalex, topics: [] },
			reason: "openalex.topics must hold 1 to",
		},
		{
			value: { ...openalex, topics: Array(11).fill(topic) },
			reason: "openalex.topics must hold 1 to",
		},
		{
			value: { ...openalex, topics: [{ ...topic, name: "" }] },
			reason: "openalex.topics name must be text",
		},
		{
			value: { ...openalex, topics: [{ ...topic, field: text(201) }] },
			reason: "openalex.topics field must be text",
		},
		{
			value: { ...openalex, topics: [{ ...topic, score: 1.5 }] },
			reason: "openalex.topics score must be a number from 0 to 1",
		},
		{
			value: { ...openalex, topics: [{ ...topic, score: "high" }] },
			reason: "openalex.topics score must be a number from 0 to 1",
		},
		{
			value: { ...openalex, keywords: Array(21).fill("a keyword") },
			reason: "openalex.keywords must be a list of up to 20",
		},
		{
			value: { ...openalex, keywords: [text(201)] },
			reason: "openalex.keywords must be text",
		},
	];
	for (const each of refused) {
		assertHasReason(
			entryProblems(paper(1, { openalex: each.value }), "check"),
			each.reason,
			JSON.stringify(each.value).slice(0, 60),
		);
	}
	const atCaps = {
		topics: Array(10).fill({ ...topic, name: text(200) }),
		keywords: Array(20).fill(text(200)),
	};
	assert.deepEqual(entryProblems(paper(1, { openalex: atCaps }), "check"), []);
});

test("An openalex field on news, an article or a report is refused", async () => {
	const { entryProblems }: typeof EntryChecks = await import(CHECKS.href);
	const openalex = {
		topics: [{ name: "Topic Modeling", field: "Computer Science", score: 0.2 }],
		keywords: [],
	};
	for (const type of ["news", "article", "report"] as const) {
		for (const mode of ["add", "check"] as const) {
			assertHasReason(
				entryProblems(
					{ ...item(type, 1, "2026-10-04"), openalex: openalex },
					mode,
				),
				'"openalex" is not in the schema',
				`${type} in mode ${mode}`,
			);
		}
	}
});
