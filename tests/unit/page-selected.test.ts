// @vitest-environment jsdom
// The Feed and Selected views: the menu under the date, the topic labels, the marked papers and their notes.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { openingView } from "../../site/page/selected.ts";
import {
	type FakeSite,
	openPage,
	paperEntry,
	releasePage,
	siteOf,
} from "./page-site.ts";

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	// 12:00 on Sunday 27 September 2026 in Jakarta.
	vi.setSystemTime(new Date("2026-09-27T05:00:00Z"));
});

afterEach(() => {
	releasePage();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	history.replaceState(null, "", "/");
	document.body.replaceChildren();
});

const TODAY = "2026-09-27";
const settle = () => new Promise((done) => setTimeout(done, 0));

type Entry = ReturnType<typeof paperEntry>;

// A paper whose main OpenAlex topic is `topic`.
const aboutTopic = (entry: Entry, topic: string): Entry => ({
	...entry,
	openalex: {
		topics: [{ name: topic, field: "Computer science", score: 0.9 }],
		keywords: [],
	},
});

// The public page's data/selected.json for these marks, as build-site.ts writes it: the newest mark first.
function publicMarks(
	site: FakeSite,
	marks: { entry: Entry; date: string; note?: string }[],
) {
	site.files["data/selected.json"] = {
		papers: marks.map((mark) => ({
			entry: mark.entry,
			date: mark.date,
			note: mark.note ?? "",
		})),
	};
}

// The owner's saved state with these marks.
function ownerMarks(
	site: FakeSite,
	marks: Record<string, { date: string; note?: string }>,
) {
	const standouts: Record<string, { date: string; note: string }> = {};
	for (const [id, mark] of Object.entries(marks))
		standouts[id] = { date: mark.date, note: mark.note ?? "" };
	site.owner = {
		read: {},
		tags: {},
		comments: {},
		feedback: {},
		takeaways: {},
		standouts: standouts,
	};
}

const selectedView = () => {
	const found = document.getElementById("selected-view");
	if (found === null) throw new Error("no Selected view");
	return found;
};
const feedView = () => {
	const found = document.getElementById("digests");
	if (found === null) throw new Error("no Feed");
	return found;
};
// The topic labels as "name count".
const labels = () =>
	[...selectedView().querySelectorAll(".label")].map(
		(label) =>
			`${label.firstChild?.textContent} ${label.querySelector(".label__n")?.textContent}`,
	);
const pickedLabels = () =>
	[...selectedView().querySelectorAll(".label")]
		.filter((label) => label.getAttribute("aria-pressed") === "true")
		.map((label) => label.firstChild?.textContent);
const label = (name: string) => {
	const found = [
		...selectedView().querySelectorAll<HTMLElement>(".label"),
	].find((one) => one.firstChild?.textContent === name);
	if (found === undefined) throw new Error(`no label ${name}`);
	return found;
};
const listedTitles = () =>
	[...selectedView().querySelectorAll(".standout__title")].map(
		(title) => title.textContent,
	);

test("The public page opens on Selected and the owner's page on Feed", async () => {
	expect(openingView("", false)).toBe("selected");
	expect(openingView("", true)).toBe("feed");

	const site = siteOf([
		{ date: TODAY, entries: [paperEntry("2609.00001", "P1")] },
	]);
	await openPage(site);
	expect(selectedView().hidden).toBe(false);
	expect(feedView().hidden).toBe(true);
	releasePage();

	ownerMarks(site, {});
	await openPage(site, { owner: true });
	expect(feedView().hidden).toBe(false);
	expect(selectedView().hidden).toBe(true);
});

test("A link to #feed or #selected opens that view on either page", async () => {
	expect(openingView("#feed", false)).toBe("feed");
	expect(openingView("#selected", true)).toBe("selected");

	const site = siteOf([
		{ date: TODAY, entries: [paperEntry("2609.00001", "P1")] },
	]);
	await openPage(site, { hash: "#feed" });
	expect(feedView().hidden).toBe(false);
	expect(selectedView().hidden).toBe(true);
	location.hash = "#selected";
	await settle();
	expect(selectedView().hidden).toBe(false);
	expect(feedView().hidden).toBe(true);
	releasePage();

	ownerMarks(site, {});
	await openPage(site, { owner: true, hash: "#selected" });
	expect(selectedView().hidden).toBe(false);
	location.hash = "#feed";
	await settle();
	expect(feedView().hidden).toBe(false);
	expect(selectedView().hidden).toBe(true);
});

// Marked papers: two about alignment, one about interpretability, one with no topic.
const alignmentA = aboutTopic(
	paperEntry("2609.00001", "Alignment A"),
	"Alignment",
);
const alignmentB = aboutTopic(
	paperEntry("2609.00002", "Alignment B"),
	"Alignment",
);
const interpretability = aboutTopic(
	paperEntry("2609.00003", "Interpretability C"),
	"Interpretability",
);
const untopiced = paperEntry("2609.00004", "Untopiced D");

async function publicPageWithMarks() {
	const site = siteOf([
		{
			date: TODAY,
			entries: [alignmentA, alignmentB, interpretability, untopiced],
		},
	]);
	publicMarks(site, [
		{ entry: alignmentA, date: "2026-09-20" },
		{ entry: alignmentB, date: "2026-09-25" },
		{ entry: interpretability, date: "2026-09-26" },
		{ entry: untopiced, date: "2026-09-22" },
	]);
	await openPage(site);
	await settle();
	return site;
}

test("Selected has one label per main OpenAlex topic of the marked papers, with its count, and one is always picked", async () => {
	await publicPageWithMarks();
	expect(labels()).toEqual([
		"Alignment 2",
		"Interpretability 1",
		"No topic yet 1",
	]);
	expect(pickedLabels()).toEqual(["Alignment"]);
	label("Interpretability").click();
	expect(pickedLabels()).toEqual(["Interpretability"]);
});

test("Selected lists only the marked papers of the picked topic, newest mark first", async () => {
	await publicPageWithMarks();
	expect(listedTitles()).toEqual(["Alignment B", "Alignment A"]);
	label("Interpretability").click();
	expect(listedTitles()).toEqual(["Interpretability C"]);
});

test("A marked paper with no OpenAlex topic yet is under No topic yet", async () => {
	const withEmptyTopics = {
		...paperEntry("2609.00005", "Empty topics E"),
		openalex: { topics: [], keywords: [] },
	};
	const site = siteOf([{ date: TODAY, entries: [untopiced, withEmptyTopics] }]);
	publicMarks(site, [
		{ entry: untopiced, date: "2026-09-22" },
		{ entry: withEmptyTopics, date: "2026-09-21" },
	]);
	await openPage(site);
	await settle();
	expect(labels()).toEqual(["No topic yet 2"]);
	expect(listedTitles()).toEqual(["Untopiced D", "Empty topics E"]);
});

test("A marked paper's abstract shows its first 5 lines", async () => {
	const abstract = Array.from(
		{ length: 40 },
		(_, i) => `sentence ${i + 1}.`,
	).join(" ");
	const paper = { ...paperEntry("2609.00006", "Long F"), abstract: abstract };
	const site = siteOf([{ date: TODAY, entries: [paper] }]);
	publicMarks(site, [{ entry: paper, date: "2026-09-22" }]);
	await openPage(site);
	await settle();
	// The whole abstract is in the page; the stylesheet shows 5 lines of it (jsdom lays nothing out).
	const shown = selectedView().querySelector(".standout__abstract");
	expect(shown?.textContent).toBe(abstract);
	const css = readFileSync(
		resolve(process.cwd(), "site/style/selected.css"),
		"utf8",
	);
	expect(css).toMatch(/\.standout__abstract\s*\{[^}]*line-clamp:\s*5;/);
});

test("The owner's Selected has a note box under each paper and no mark button", async () => {
	const site = siteOf([{ date: TODAY, entries: [alignmentA, alignmentB] }]);
	ownerMarks(site, {
		[alignmentA.id]: { date: "2026-09-20", note: "Changed my mind" },
		[alignmentB.id]: { date: "2026-09-25" },
	});
	await openPage(site, { owner: true, hash: "#selected" });
	await settle();
	const boxes =
		selectedView().querySelectorAll<HTMLTextAreaElement>("textarea");
	expect([...boxes].map((box) => box.value)).toEqual(["", "Changed my mind"]);
	expect(
		selectedView().querySelector("button[aria-label='Shaped my thinking']"),
	).toBeNull();
});

test("The public Selected shows a note, and no note box", async () => {
	const site = siteOf([{ date: TODAY, entries: [alignmentA, alignmentB] }]);
	publicMarks(site, [
		{ entry: alignmentA, date: "2026-09-20", note: "Changed my mind" },
		{ entry: alignmentB, date: "2026-09-25" },
	]);
	await openPage(site);
	await settle();
	expect(listedTitles()).toEqual(["Alignment B", "Alignment A"]);
	expect(selectedView().querySelector("textarea")).toBeNull();
	expect(
		[...selectedView().querySelectorAll(".standout__text")].map(
			(note) => note.textContent,
		),
	).toEqual(["Changed my mind"]);
	expect(selectedView().querySelectorAll(".note")).toHaveLength(1);
});

test("security: a note shows as plain text and never as HTML", async () => {
	const note =
		'<img src=x onerror="window.pwned = 1"><script>window.pwned = 2</script><b>bold</b>';
	const site = siteOf([{ date: TODAY, entries: [alignmentA] }]);
	publicMarks(site, [{ entry: alignmentA, date: "2026-09-20", note: note }]);
	await openPage(site);
	await settle();
	const shown = selectedView().querySelector(".standout__text");
	expect(shown?.textContent).toBe(note);
	expect(selectedView().querySelector("img, script, b")).toBeNull();
	releasePage();

	ownerMarks(site, { [alignmentA.id]: { date: "2026-09-20", note: note } });
	await openPage(site, { owner: true, hash: "#selected" });
	await settle();
	expect(selectedView().querySelector("textarea")?.value).toBe(note);
	expect(selectedView().querySelector("img, script, b")).toBeNull();
});

test("A mark or note the Worker refuses is undone and the page says it wasn't saved", async () => {
	const site = siteOf([{ date: TODAY, entries: [alignmentA] }]);
	ownerMarks(site, {});
	site.statuses["api/owner/standouts"] = 500;
	await openPage(site, { owner: true });
	const mark = feedView().querySelector<HTMLButtonElement>(
		"button[aria-label='Shaped my thinking']",
	);
	if (mark === null) throw new Error("no mark button");
	mark.click();
	expect(mark.getAttribute("aria-pressed")).toBe("true");
	await settle();
	expect(mark.getAttribute("aria-pressed")).toBe("false");
	expect(document.querySelector(".notice")?.textContent).toContain(
		"Not saved: couldn't reach the site",
	);
	releasePage();

	ownerMarks(site, { [alignmentA.id]: { date: "2026-09-20", note: "Old" } });
	await openPage(site, { owner: true, hash: "#selected" });
	await settle();
	const box = selectedView().querySelector<HTMLTextAreaElement>("textarea");
	if (box === null) throw new Error("no note box");
	box.value = "New";
	box.dispatchEvent(new Event("change"));
	await settle();
	expect(selectedView().querySelector("textarea")?.value).toBe("Old");
	expect(document.querySelector(".notice")?.textContent).toContain(
		"Not saved: couldn't reach the site",
	);
});

test("A marked paper in the public Feed carries Shaped my thinking, linking to Selected", async () => {
	const site = siteOf([{ date: TODAY, entries: [alignmentA, alignmentB] }]);
	publicMarks(site, [{ entry: alignmentA, date: "2026-09-20" }]);
	await openPage(site, { hash: "#feed" });
	const mark = (id: string) =>
		document
			.getElementById(id)
			?.querySelector<HTMLAnchorElement>(".entry__kicker a");
	expect(mark(alignmentA.id)?.textContent).toBe("Shaped my thinking");
	expect(mark(alignmentA.id)?.getAttribute("href")).toBe("#selected");
	expect(mark(alignmentB.id)).toBeNull();
});

test("The owner's Selected lists a marked paper from a month the page has not loaded", async () => {
	const old = aboutTopic(
		paperEntry("2607.00001", "Old July paper"),
		"Alignment",
	);
	const site = siteOf([
		{ date: TODAY, entries: [paperEntry("2609.00001", "P1")] },
		{ date: "2026-07-10", entries: [old] },
	]);
	ownerMarks(site, { [old.id]: { date: "2026-09-01", note: "From July" } });
	await openPage(site, { owner: true });
	expect(site.requested).not.toContain("data/months/2026-07.json");
	location.hash = "#selected";
	await settle();
	expect(site.requested).toContain("data/months/2026-07.json");
	expect(listedTitles()).toEqual(["Old July paper"]);
	expect(selectedView().querySelector("textarea")?.value).toBe("From July");
});
