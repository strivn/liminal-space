// @vitest-environment jsdom
// The page's days and older months, drawn by start() from an in-memory site (site/page/render.ts, months.ts, data.ts).
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	type FakeSite,
	loadKatex,
	newsEntry,
	openPage,
	paperEntry,
	releasePage,
	siteOf,
	texts,
	unloadKatex,
} from "./page-site.ts";

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-10-16T05:00:00Z"));
});

afterEach(() => {
	releasePage();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	unloadKatex();
	document.body.replaceChildren();
});

const OCT = paperEntry("2610.00001", "October paper");
const SEP_A = paperEntry("2609.00001", "September paper A");
const SEP_B = paperEntry("2609.00002", "September paper B");
const AUG = paperEntry("2608.00001", "August paper");

function threeMonths() {
	return siteOf([
		{ date: "2026-10-16", entries: [OCT] },
		{ date: "2026-09-20", entries: [SEP_A] },
		{ date: "2026-09-19", entries: [SEP_B] },
		{ date: "2026-08-30", entries: [AUG] },
	]);
}

function dayDetails(date: string) {
	const day = document.querySelector<HTMLDetailsElement>(
		`details[data-date="${date}"]`,
	);
	if (day === null) throw new Error(`no day ${date}`);
	return day;
}

// Unfold a day the way a click on its row does; jsdom fires the toggle event, and the page loads the month on it.
async function unfold(date: string) {
	const day = dayDetails(date);
	const errorBefore = day.querySelector(".day__error");
	day.open = true;
	await vi.waitFor(() => {
		const error = day.querySelector(".day__error");
		expect(
			day.querySelector("article") ?? (error !== errorBefore && error),
		).toBeTruthy();
	});
	return day;
}

async function fold(date: string) {
	dayDetails(date).open = false;
	await new Promise((done) => setTimeout(done, 0));
}

test("opening the page requests the index and the newest month, and no other month file", async () => {
	const site = threeMonths();
	await openPage(site);
	expect(site.requested).toEqual([
		"data/index.json",
		"data/months/2026-10.json",
	]);
	const rows = [...document.querySelectorAll("main details.day")].map((day) =>
		day.getAttribute("data-date"),
	);
	expect(rows).toEqual(["2026-09-20", "2026-09-19", "2026-08-30"]);
	expect(document.querySelectorAll("main details.day article")).toHaveLength(0);
});

test("unfolding two days of one older month loads that month once", async () => {
	const site = threeMonths();
	await openPage(site);
	await unfold("2026-09-20");
	await unfold("2026-09-19");
	expect(
		site.requested.filter((path) => path === "data/months/2026-09.json"),
	).toHaveLength(1);
	expect(site.requested).not.toContain("data/months/2026-08.json");
	expect(texts('details[data-date="2026-09-19"] .entry__title')).toEqual([
		"September paper B",
	]);
});

test("a month that fails to load shows an error in its unfolded day, and unfolding the day again draws it", async () => {
	vi.spyOn(console, "error").mockImplementation(() => {});
	const site = threeMonths();
	site.statuses["data/months/2026-09.json"] = 500;
	await openPage(site);
	const day = await unfold("2026-09-20");
	expect(day.querySelector(".day__error")?.textContent).toContain(
		"Couldn't load this day",
	);
	expect(day.querySelector("article")).toBeNull();
	// October's own day is still drawn.
	expect(texts("section.day .entry__title")).toEqual(["October paper"]);

	delete site.statuses["data/months/2026-09.json"];
	await fold("2026-09-20");
	await unfold("2026-09-20");
	expect(day.querySelector(".day__error")).toBeNull();
	expect(texts('details[data-date="2026-09-20"] .entry__title')).toEqual([
		"September paper A",
	]);
});

test("a month file replaced by a newer deploy is found through a fresh index", async () => {
	const site = threeMonths();
	await openPage(site);
	const index = site.index as { months: Record<string, string> };
	index.months["2026-09"] = "months/2026-09.new.json";
	site.files["data/months/2026-09.new.json"] =
		site.files["data/months/2026-09.json"];
	delete site.files["data/months/2026-09.json"];
	await unfold("2026-09-20");
	expect(site.requested.slice(-3)).toEqual([
		"data/months/2026-09.json",
		"data/index.json",
		"data/months/2026-09.new.json",
	]);
	expect(texts('details[data-date="2026-09-20"] .entry__title')).toEqual([
		"September paper A",
	]);
});

test("after a month fails to load, unfolding its day again fetches the month file again", async () => {
	vi.spyOn(console, "error").mockImplementation(() => {});
	const site = threeMonths();
	site.statuses["data/months/2026-09.json"] = 500;
	await openPage(site);
	await unfold("2026-09-20");
	await fold("2026-09-20");
	await unfold("2026-09-20");
	expect(
		site.requested.filter((path) => path === "data/months/2026-09.json"),
	).toHaveLength(2);
});

// A site that answers with something the page can't use, and what the page then says.
const BROKEN: [string, (site: FakeSite) => void][] = [
	[
		"data/index.json is missing",
		(site) => (site.statuses["data/index.json"] = 404),
	],
	[
		"data/index.json isn't JSON",
		(site) => (site.raw["data/index.json"] = "<html>not json</html>"),
	],
	[
		"the newest month's file is missing",
		(site) => (site.statuses["data/months/2026-10.json"] = 404),
	],
	[
		"the newest month's file isn't JSON",
		(site) => (site.raw["data/months/2026-10.json"] = "nope"),
	],
];
for (const [problem, apply] of BROKEN) {
	test(`when ${problem}, the page says "Couldn't load digests" instead of staying blank`, async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const site = threeMonths();
		apply(site);
		await openPage(site);
		expect(texts("#digests")).toEqual(["Couldn't load digests"]);
		expect(document.getElementById("heatmap")?.children).toHaveLength(0);
		expect(
			document
				.getElementById("page")
				?.classList.contains("page--with-contents"),
		).toBe(false);
		expect(document.getElementById("digests")?.hasAttribute("aria-busy")).toBe(
			false,
		);
	});
}

test("a page with no digests says so, with one centred column and no heatmap squares", async () => {
	await openPage(siteOf([]));
	expect(texts("#digests")).toEqual(["No digests yet"]);
	expect(
		document.getElementById("page")?.classList.contains("page--with-contents"),
	).toBe(false);
	expect(document.getElementById("heatmap")).toBeNull();
});

test("every day is an h2 holding its date, the older ones inside their summary, and every entry title is an h3", async () => {
	const site = siteOf([
		{ date: "2026-10-16", entries: [OCT] },
		{ date: "2026-10-15", entries: [paperEntry("2610.00002", "Yesterday")] },
		{ date: "2026-10-13", entries: [paperEntry("2610.00003", "Earlier")] },
	]);
	await openPage(site);
	expect(texts("main h2")).toEqual([
		"Friday 16 October",
		"Thursday 15 October",
		"Tuesday 13 October",
	]);
	expect(document.querySelectorAll("main details > summary > h2")).toHaveLength(
		2,
	);
	expect(
		[...document.querySelectorAll("article .entry__title")].every(
			(title) => title.tagName === "H3",
		),
	).toBe(true);
});

// What the page leaves out and why, for an entry of today.
const UNDRAWABLE: [string, Record<string, unknown>, string][] = [
	[
		"a published time",
		{ published: "2026-10-03T19:27:17Z" },
		"published isn't YYYY-MM-DD",
	],
];
for (const [problem, change, reason] of UNDRAWABLE) {
	test(`an entry the page can't draw is left out and named in the warning, without a link: ${problem}`, async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const bad = {
			...newsEntry("9", "Broken news", { url: "https://example.com/news/9" }),
			...change,
		};
		const site = siteOf([
			{
				date: "2026-10-16",
				entries: [
					paperEntry("2610.00001", "One"),
					paperEntry("2610.00002", "Two"),
					paperEntry("2610.00003", "Three"),
					bad,
				],
			},
		]);
		await openPage(site);
		expect(texts("section.day .entry__title")).toEqual(["One", "Two", "Three"]);
		expect(texts(".skipped summary")).toEqual(["1 entry couldn't be shown"]);
		expect(texts(".skipped li")).toEqual([`news:9: ${reason}`]);
		expect(texts(".contents__newest a")).toEqual(["One", "Two", "Three"]);
		expect(warn).toHaveBeenCalledWith(`Not shown: news:9: ${reason}`);
		// The warning names the entries and links nowhere: an id is whatever the data holds.
		expect(document.querySelector(".skipped a")).toBeNull();
	});
}

test("entries left out of an older month are added to the header's warning when that month loads", async () => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
	const site = siteOf([
		{
			date: "2026-10-16",
			entries: [paperEntry("2610.00009", "Bad", { published: "x" })],
		},
		{ date: "2026-10-15", entries: [OCT] },
		{
			date: "2026-09-20",
			entries: [SEP_A, newsEntry("y", "Bad news", { authors: "Cy Writer" })],
		},
	]);
	await openPage(site);
	expect(texts(".skipped summary")).toEqual(["1 entry couldn't be shown"]);
	await unfold("2026-09-20");
	expect(texts(".skipped summary")).toEqual(["2 entries couldn't be shown"]);
	expect(texts(".skipped li")).toEqual([
		"arxiv:2610.00009: published isn't YYYY-MM-DD",
		"news:y: authors isn't a list",
	]);
});

test("a folded day's math is typeset when the day first unfolds", async () => {
	const site = siteOf([
		{ date: "2026-10-16", entries: [OCT] },
		{
			date: "2026-10-15",
			entries: [paperEntry("2610.00002", "Sorting in $O(n^2)$ time")],
		},
	]);
	loadKatex();
	await openPage(site);
	const day = dayDetails("2026-10-15");
	expect(day.querySelector(".entry__title")?.textContent).toBe(
		"Sorting in $O(n^2)$ time",
	);
	expect(day.querySelector(".katex")).toBeNull();
	day.open = true;
	await vi.waitFor(() =>
		expect(day.querySelector(".entry__title .katex")).not.toBeNull(),
	);
});
