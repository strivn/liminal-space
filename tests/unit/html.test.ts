// Unit tests for scripts/lib/html.ts tagsNamed, the one-pass tag reader describe.ts, proceedings.ts and figure.ts share,
// and for figure.ts's readers on pages that repeat an opening tag and never close one
// (reading a page's tags takes time in proportion to the page; the
// 2 MB pages of describe.ts, proceedings.ts and "<figure " are the cases).
import assert from "node:assert/strict";
import { test } from "vitest";
import { tagsNamed } from "../../scripts/lib/html.ts";
import { figureFromHtml } from "../../scripts/scout/arxiv/figure.ts";

test("the tag reader finds every tag of a given name in any letter case, with its text and position", () => {
	const html = '<p>One</p><META name="a" content="1"><meta\ncontent="2">';

	assert.deepEqual(tagsNamed(html, ["meta"]), [
		{
			name: "meta",
			closing: false,
			text: '<META name="a" content="1">',
			start: 10,
			end: 37,
		},
		{
			name: "meta",
			closing: false,
			text: '<meta\ncontent="2">',
			start: 37,
			end: 55,
		},
	]);
});

test('the tag reader keeps a ">" inside single or double quotes as part of the tag', () => {
	const html = `<meta content="a > b"><meta content='c > d'>`;

	assert.deepEqual(
		tagsNamed(html, ["meta"]).map((tag) => tag.text),
		[`<meta content="a > b">`, `<meta content='c > d'>`],
	);
});

test("the tag reader tells opening tags from closing ones, for several tag names at once", () => {
	const html = "<figure><img src=x.png></figure><object data=y.svg>";

	assert.deepEqual(
		tagsNamed(html, ["figure", "img"]).map((tag) => [tag.name, tag.closing]),
		[
			["figure", false],
			["img", false],
			["figure", true],
		],
	);
});

test("the tag reader asked for meta does not match metadata", () => {
	assert.deepEqual(tagsNamed("<metadata><figures><meta>", ["meta"]).length, 1);
});

test("the tag reader given no names returns every tag, but no comment or doctype", () => {
	const html = "<!doctype html><!-- note --><p>One <b>two</b></p>";

	assert.deepEqual(
		tagsNamed(html, null).map((tag) => tag.text),
		["<p>", "<b>", "</b>", "</p>"],
	);
});

// A quote left open in one tag swallows what follows; the tags after it are still found, as the regular expression
// this reader replaces found them.
test("after a quote that never closes, the tag reader still finds the next tag", () => {
	const html = '<meta content="unclosed> <meta name="description" content="x">';

	assert.deepEqual(
		tagsNamed(html, ["meta"]).map((tag) => tag.text),
		['<meta name="description" content="x">'],
	);
});

// 400 KB, where a reader whose time grows with the square of the page takes seconds, and one that reads in one pass a
// few milliseconds.
const PAGE_BYTES = 400 * 1024;
const LIMIT_MS = 250;

// The time `read` takes on a page that repeats `unit`.
function timeOn(unit: string, read: (page: string) => unknown): number {
	const page = unit.repeat(Math.ceil(PAGE_BYTES / unit.length));
	const started = performance.now();
	read(page);
	return performance.now() - started;
}

test("security: the tag reader reads 400 KB of tags that never close in under 250 ms", () => {
	let found = -1;
	const ms = timeOn("<meta ", (page) => {
		found = tagsNamed(page, ["meta"]).length;
	});

	assert.equal(found, 0);
	assert.ok(ms < LIMIT_MS, `took ${Math.round(ms)} ms`);
});

// Where each repeated piece sits in an arXiv page: by itself, inside a figure, inside Figure 1's caption, or after it.
const BASE = "https://arxiv.org/html/2507.11473v1";
const FIGURE_SHAPES: [string, string, (repeated: string) => string][] = [
	["comments that never close", "<!-- ", (repeated) => repeated],
	["scripts that never close", "<script ", (repeated) => repeated],
	[
		"figcaption tags that never close",
		"<figcaption ",
		(repeated) => `<figure>${repeated}</figure>`,
	],
	[
		"tags that never close in Figure 1's caption",
		"<a ",
		(repeated) =>
			`<figure><figcaption>Figure 1: ${repeated}</figcaption></figure>`,
	],
	[
		"math tags that never close in Figure 1's caption",
		"<math ",
		(repeated) =>
			`<figure><figcaption>Figure 1: ${repeated}</figcaption></figure>`,
	],
	[
		"image tags that never close in Figure 1",
		"<img ",
		(repeated) =>
			`<figure><figcaption>Figure 1: A plot.</figcaption>${repeated}</figure>`,
	],
];

for (const [what, unit, wrap] of FIGURE_SHAPES) {
	test(`security: finding Figure 1 in 400 KB of ${what} takes under 250 ms`, () => {
		const ms = timeOn(unit, (repeated) => figureFromHtml(wrap(repeated), BASE));

		assert.ok(ms < LIMIT_MS, `took ${Math.round(ms)} ms`);
	});
}
