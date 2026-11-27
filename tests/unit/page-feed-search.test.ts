// @vitest-environment jsdom
// The Search sentence over the owner's whole page.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { notesOfThreads } from "../../site/page/search.ts";
import {
	type FakeSite,
	listedTitles,
	newsEntry,
	openPage,
	paperEntry,
	releasePage,
	shownTitles,
	siteOf,
	texts,
} from "./page-site.ts";

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	// 12:00 on Sunday 27 September 2026 in Jakarta.
	vi.setSystemTime(new Date("2026-09-27T05:00:00Z"));
});

afterEach(() => {
	releasePage();
	sessionStorage.clear();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	history.replaceState(null, "", "/");
	document.body.replaceChildren();
});

const TODAY = "2026-09-27";
const THREE_DAYS_AGO = "2026-09-24";

type Saved = {
	read?: Record<string, unknown>;
	tags?: Record<string, unknown>;
	comments?: Record<string, unknown>;
};

const papers = (count: number, prefix = "2609") =>
	Array.from({ length: count }, (_, i) =>
		paperEntry(
			`${prefix}.${String(i + 1).padStart(5, "0")}`,
			`P${i + 1}${prefix === "2609" ? "" : `-${prefix}`}`,
		),
	);

async function owner(site: FakeSite, saved: Saved = {}) {
	site.owner = {
		read: saved.read ?? {},
		tags: saved.tags ?? {},
		comments: saved.comments ?? {},
		feedback: {},
		takeaways: {},
	};
	await openPage(site, { owner: true });
}

const settle = () => new Promise((done) => setTimeout(done, 0));
const blank = (name: string) => {
	const found = document.querySelector<HTMLElement>(`[data-blank="${name}"]`);
	if (found === null) throw new Error(`no blank ${name}`);
	return found;
};
const words = () => [
	...document.querySelectorAll<HTMLButtonElement>(
		"#search-choices .search__word",
	),
];
const word = (label: string) => {
	const found = words().find((one) => one.getAttribute("aria-label") === label);
	if (found === undefined) throw new Error(`no choice ${label}`);
	return found;
};
// A choice's count.
const countOf = (label: string) =>
	word(label).querySelector("sup")?.textContent;
// Open a blank and pick a choice.
function pick(blankName: string, label: string) {
	if (blank(blankName).getAttribute("aria-expanded") !== "true")
		blank(blankName).click();
	word(label).click();
}
const sentence = () => texts(".search__sentence")[0];
const control = (id: string, name: string) => {
	const found = document
		.getElementById(id)
		?.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
	if (found === null || found === undefined) throw new Error(`no ${name}`);
	return found;
};
const day = (date: string) =>
	document.querySelector<HTMLDetailsElement>(`details[data-date="${date}"]`);

test("the read blank shows only the papers read to that depth, across days, and opens the days that hold one", async () => {
	const site = siteOf([
		{ date: TODAY, entries: papers(3) },
		{ date: THREE_DAYS_AGO, entries: papers(2, "2610") },
		{ date: "2026-09-22", entries: papers(1, "2611") },
	]);
	await owner(site, {
		read: {
			"arxiv:2609.00001": { depth: "abstract", date: TODAY },
			"arxiv:2610.00001": { depth: "abstract", date: TODAY },
		},
	});
	pick("read", "abstract read");
	expect(shownTitles()).toEqual(["P1", "P1-2610"]);
	expect(day(THREE_DAYS_AGO)?.open).toBe(true);
	expect(day("2026-09-22")?.hasAttribute("hidden")).toBe(true);
	await settle();
	expect(listedTitles()).toEqual(["P1", "P1-2610"]);
	pick("read", "read or not");
	expect(shownTitles()).toEqual(["P1", "P2", "P3"]);
});

test("the read blank holds one depth at a time", async () => {
	const site = siteOf([{ date: TODAY, entries: papers(2) }]);
	await owner(site, {
		read: {
			"arxiv:2609.00001": { depth: "abstract", date: TODAY },
			"arxiv:2609.00002": { depth: "paper", date: TODAY },
		},
	});
	pick("read", "abstract read");
	pick("read", "paper read");
	expect(
		["abstract read", "paper read"].map((label) =>
			word(label).getAttribute("aria-checked"),
		),
	).toEqual(["false", "true"]);
	expect(shownTitles()).toEqual(["P2"]);
	expect(sentence()).toContain("paper read");
});

test("a depth and a tag together show only the entries that match both", async () => {
	const site = siteOf([{ date: TODAY, entries: papers(3) }]);
	await owner(site, {
		read: { "arxiv:2609.00003": { depth: "abstract", date: TODAY } },
		tags: {
			"arxiv:2609.00001": { toRead: true },
			"arxiv:2609.00003": { toRead: true },
		},
	});
	pick("read", "unread");
	pick("read", "To read");
	expect(shownTitles()).toEqual(["P1"]);
	expect(sentence()).toContain("unread and tagged To read");
});

test("two tags together show only the entries that carry both", async () => {
	const site = siteOf([{ date: TODAY, entries: papers(3) }]);
	await owner(site, {
		tags: {
			"arxiv:2609.00001": { toRead: true },
			"arxiv:2609.00002": { learnFirst: true },
			"arxiv:2609.00003": { toRead: true, learnFirst: true },
		},
	});
	pick("read", "To read");
	pick("read", "Learn first");
	expect(shownTitles()).toEqual(["P3"]);
});

test("a read mark saved on news counts in no choice of the read blank, and nothing is sent for it", async () => {
	const site = siteOf([
		{ date: TODAY, entries: [...papers(2), newsEntry("n", "News item")] },
	]);
	await owner(site, { read: { "news:n": { depth: "paper", date: TODAY } } });
	blank("read").click();
	expect(
		["unread", "abstract read", "paper read"].map((label) =>
			label === "unread" ? countOf(label) : word(label).disabled,
		),
	).toEqual(["2", true, true]);
	expect(site.posts).toEqual([]);
});

test("the read blank's counts follow a state read again when the page comes back into view", async () => {
	const site = siteOf([{ date: TODAY, entries: papers(2) }]);
	await owner(site);
	blank("read").click();
	expect(countOf("unread")).toBe("2");
	site.owner = {
		read: { "arxiv:2609.00001": { depth: "abstract", date: TODAY } },
		tags: { "arxiv:2609.00002": { toRead: true } },
		comments: {},
		feedback: {},
		takeaways: {},
	};
	document.dispatchEvent(new Event("visibilitychange"));
	await vi.waitFor(() => expect(countOf("unread")).toBe("1"));
	expect([countOf("abstract read"), countOf("To read")]).toEqual(["1", "1"]);
});

test("pressing a read button while the sentence narrows updates the counts at once and keeps the entry shown until the sentence changes", async () => {
	const site = siteOf([{ date: TODAY, entries: papers(2) }]);
	await owner(site);
	pick("read", "unread");
	control("arxiv:2609.00001", "Abstract").click();
	expect(texts(".search__tally span")).toEqual(["1 of 2 entries"]);
	expect(shownTitles()).toEqual(["P1", "P2"]);
	blank("read").click();
	expect([countOf("unread"), countOf("abstract read")]).toEqual(["1", "1"]);
	pick("read", "read or not");
	pick("read", "unread");
	expect(shownTitles()).toEqual(["P2"]);
});

test("pressing a tag button while the sentence narrows updates the counts at once and keeps the entry shown until the sentence changes", async () => {
	const site = siteOf([{ date: TODAY, entries: papers(2) }]);
	await owner(site, {
		tags: {
			"arxiv:2609.00001": { toRead: true },
			"arxiv:2609.00002": { toRead: true },
		},
	});
	pick("read", "To read");
	control("arxiv:2609.00001", "To read").click();
	expect(texts(".search__tally span")).toEqual(["1 of 2 entries"]);
	expect(shownTitles()).toEqual(["P1", "P2"]);
	blank("read").click();
	expect(countOf("To read")).toBe("1");
	pick("read", "To read");
	pick("read", "To read");
	expect(shownTitles()).toEqual(["P2"]);
});

test("Reset shows everything again and folds the days the sentence opened", async () => {
	const site = siteOf([
		{ date: TODAY, entries: papers(3) },
		{ date: THREE_DAYS_AGO, entries: papers(2, "2610") },
	]);
	await owner(site, { tags: { "arxiv:2609.00001": { toRead: true } } });
	pick("read", "To read");
	document.querySelector<HTMLButtonElement>(".search__reset")?.click();
	expect(shownTitles()).toEqual(["P1", "P2", "P3"]);
	expect(day(THREE_DAYS_AGO)?.open).toBe(false);
});

test("an open day that the sentence hides is closed, and opens again when the sentence is back", async () => {
	const site = siteOf([
		{ date: TODAY, entries: papers(2) },
		{ date: THREE_DAYS_AGO, entries: papers(2, "2610") },
	]);
	await owner(site, { tags: { "arxiv:2609.00001": { toRead: true } } });
	const collapse = () =>
		document.querySelector<HTMLElement>(".contents__collapse");
	document.querySelector<HTMLButtonElement>(".contents__day")?.click();
	await settle();
	expect(day(THREE_DAYS_AGO)?.open).toBe(true);
	pick("read", "To read");
	await settle();
	expect([
		day(THREE_DAYS_AGO)?.hidden,
		day(THREE_DAYS_AGO)?.open,
		collapse()?.hidden,
	]).toEqual([true, false, true]);
	document.querySelector<HTMLButtonElement>(".search__reset")?.click();
	await settle();
	expect([
		day(THREE_DAYS_AGO)?.hidden,
		day(THREE_DAYS_AGO)?.open,
		collapse()?.hidden,
	]).toEqual([false, true, false]);
});

test("a sentence that shows nothing says so, and the note's Reset brings the Feed back", async () => {
	const site = siteOf([{ date: TODAY, entries: papers(2) }]);
	await owner(site);
	pick("read", "unread");
	control("arxiv:2609.00001", "Abstract").click();
	control("arxiv:2609.00002", "Abstract").click();
	pick("read", "unread");
	pick("read", "unread");
	expect(shownTitles()).toEqual([]);
	expect(texts(".search__empty")).toEqual(["Nothing matches. Reset"]);
	document.querySelector<HTMLButtonElement>(".search__empty button")?.click();
	expect(texts(".search__empty")).toEqual([]);
	expect(shownTitles()).toEqual(["P1", "P2"]);
});

test("the any time choice loads every month once and shows every day, and a month narrows to it", async () => {
	const site = siteOf([
		{ date: TODAY, entries: papers(2) },
		{ date: "2026-08-20", entries: papers(2, "2608") },
	]);
	await owner(site);
	expect(sentence()).toContain("this month");
	expect(day("2026-08-20")?.hidden).toBe(true);
	pick("time", "any time");
	await vi.waitFor(() =>
		expect(
			document.querySelector('details[data-date="2026-08-20"] article'),
		).not.toBeNull(),
	);
	expect(day("2026-08-20")?.hidden).toBe(false);
	expect(
		site.requested.filter((path) => path === "data/months/2026-08.json"),
	).toHaveLength(1);
	pick("time", "this month");
	expect(day("2026-08-20")?.hidden).toBe(true);
	expect(document.querySelector<HTMLElement>("section.day")?.hidden).toBe(
		false,
	);
});

test("an older month picked in the time blank is loaded and its days are shown", async () => {
	const site = siteOf([
		{ date: TODAY, entries: papers(2) },
		{ date: "2026-08-20", entries: papers(2, "2608") },
	]);
	await owner(site);
	pick("time", "in August");
	await vi.waitFor(() =>
		expect(
			document.querySelector('details[data-date="2026-08-20"] article'),
		).not.toBeNull(),
	);
	expect(day("2026-08-20")?.hidden).toBe(false);
	expect(document.querySelector<HTMLElement>("section.day")?.hidden).toBe(true);
	expect(sentence()).toContain("in August");
});

test("a month that loads only after a retry still shows only the entries the sentence describes", async () => {
	vi.spyOn(console, "error").mockImplementation(() => {});
	const site = siteOf([
		{ date: TODAY, entries: papers(1) },
		{
			date: "2026-08-20",
			entries: [
				...papers(2, "2608"),
				newsEntry("x", "News X"),
				newsEntry("y", "News Y"),
			],
		},
	]);
	site.statuses["data/months/2026-08.json"] = 500;
	await owner(site, {
		tags: {
			"arxiv:2609.00001": { toRead: true },
			"arxiv:2608.00001": { toRead: true },
		},
	});
	pick("time", "any time");
	await settle();
	await settle();
	pick("read", "To read");
	delete site.statuses["data/months/2026-08.json"];
	const august = day("2026-08-20");
	if (august === null) throw new Error("no August day");
	august.open = false;
	await settle();
	august.open = true;
	await vi.waitFor(() => expect(shownTitles()).toEqual(["P1", "P1-2608"]));
	expect(listedTitles()).toEqual(["P1", "P1-2608"]);
});

test("a link to an entry the sentence hides brings back that entry's month", async () => {
	const site = siteOf([
		{ date: TODAY, entries: papers(1) },
		{ date: "2026-08-20", entries: papers(2, "2608") },
	]);
	await owner(site, { tags: { "arxiv:2609.00001": { toRead: true } } });
	pick("read", "To read");
	location.hash = "#arxiv:2608.00001";
	await vi.waitFor(() =>
		expect(site.requested).toContain("data/months/2026-08.json"),
	);
	await vi.waitFor(() => expect(shownTitles()).toContain("P1-2608"));
	expect(sentence()).toContain("in August");
	expect(sentence()).not.toContain("To read");
});

test("a link to today's entry brings back this month after another month was chosen", async () => {
	const site = siteOf([
		{ date: TODAY, entries: papers(2) },
		{ date: "2026-08-20", entries: papers(2, "2608") },
	]);
	await owner(site);
	pick("time", "in August");
	await vi.waitFor(() => expect(shownTitles()).toEqual(["P1-2608", "P2-2608"]));
	location.hash = "#arxiv:2609.00001";
	await vi.waitFor(() => expect(sentence()).toContain("this month"));
	expect(shownTitles()).toContain("P1");
});

test("the arrow keys skip entries the sentence hides, and the contents list marks the entry they move to", async () => {
	const site = siteOf([{ date: TODAY, entries: papers(4) }]);
	await owner(site, {
		tags: {
			"arxiv:2609.00001": { toRead: true },
			"arxiv:2609.00004": { toRead: true },
		},
	});
	pick("read", "To read");
	document
		.querySelector<HTMLAnchorElement>('.contents a[href="#arxiv:2609.00001"]')
		?.click();
	await settle();
	document.body.dispatchEvent(
		new KeyboardEvent("keydown", {
			key: "ArrowRight",
			bubbles: true,
			cancelable: true,
		}),
	);
	await vi.waitFor(() => expect(location.hash).toBe("#arxiv:2609.00004"));
	await vi.waitFor(() =>
		expect(texts('.contents a[aria-current="true"]')).toEqual(["P4"]),
	);
});

test("the sentence is not remembered over a reload", async () => {
	const site = siteOf([{ date: TODAY, entries: papers(2) }]);
	await owner(site, { tags: { "arxiv:2609.00001": { toRead: true } } });
	pick("read", "To read");
	releasePage();
	document.body.replaceChildren();
	await owner(site, { tags: { "arxiv:2609.00001": { toRead: true } } });
	expect(sentence()).toBe(
		"Show me everything about any subject from any venue, this month, read or not.",
	);
	expect(shownTitles()).toEqual(["P1", "P2"]);
});

test("the sentence leaves the header's progress line and the heatmap as they were", async () => {
	const site = siteOf([{ date: TODAY, entries: papers(3) }]);
	await owner(site, {
		read: { "arxiv:2609.00001": { depth: "paper", date: TODAY } },
		tags: { "arxiv:2609.00001": { toRead: true } },
	});
	const before = [
		texts("#freshness .progress__text"),
		document.querySelector('.heatmap__day[data-date="2026-09-27"]')?.className,
	];
	pick("read", "To read");
	expect(texts("#freshness")[0]).toContain("Sunday 27 September");
	expect([
		texts("#freshness .progress__text"),
		document.querySelector('.heatmap__day[data-date="2026-09-27"]')?.className,
	]).toEqual(before);
	expect(before[0]).toEqual(["1 of 3 papers read"]);
});

test("a heatmap day in an older month brings back that month, loads it and opens the day", async () => {
	const site = siteOf([
		{ date: TODAY, entries: papers(2) },
		{ date: "2026-08-20", entries: papers(2, "2608") },
	]);
	await owner(site, { tags: { "arxiv:2609.00001": { toRead: true } } });
	pick("read", "To read");
	expect(shownTitles()).toEqual(["P1"]);
	document
		.querySelector<HTMLElement>('.heatmap__day[data-date="2026-08-20"]')
		?.click();
	await vi.waitFor(() => expect(day("2026-08-20")?.open).toBe(true));
	expect(sentence()).toContain("in August");
	expect(sentence()).not.toContain("To read");
	await vi.waitFor(() => expect(shownTitles()).toEqual(["P1-2608", "P2-2608"]));
});

test("the ad hoc choice counts the ad hoc entries of the months drawn, has the contents' icon, and combines with a depth", async () => {
	const entries = [
		paperEntry("2609.00001", "P1", { ad_hoc: true }),
		paperEntry("2609.00002", "P2", { ad_hoc: true }),
		paperEntry("2609.00003", "P3"),
	];
	const site = siteOf([{ date: TODAY, entries: entries }]);
	await owner(site, {
		read: { "arxiv:2609.00002": { depth: "abstract", date: TODAY } },
	});
	blank("read").click();
	expect(countOf("ad hoc")).toBe("2");
	expect(word("ad hoc").querySelector("svg")?.getAttribute("data-icon")).toBe(
		document
			.querySelector(".contents__tag--icon svg")
			?.getAttribute("data-icon"),
	);
	word("ad hoc").click();
	expect(shownTitles()).toEqual(["P1", "P2"]);
	pick("read", "unread");
	expect(shownTitles()).toEqual(["P1"]);
});

test("the ad hoc choice finds an ad hoc entry in a month not drawn yet, once the time reaches it", async () => {
	const site = siteOf([
		{ date: TODAY, entries: papers(1) },
		{
			date: "2026-08-20",
			entries: [
				paperEntry("2608.00001", "Old ad hoc", { ad_hoc: true }),
				paperEntry("2608.00002", "Old plain"),
			],
		},
	]);
	await owner(site);
	pick("time", "any time");
	pick("read", "ad hoc");
	await vi.waitFor(() => expect(shownTitles()).toEqual(["Old ad hoc"]));
});

// ---- Commented and highlighted ----

const SAVED_AT = "2026-09-27T01:00:00.000Z";
const ABSTRACT = "Some abstract words here.";
const notedPapers = (count: number) =>
	Array.from({ length: count }, (_, i) =>
		paperEntry(`2609.0000${i + 1}`, `P${i + 1}`, { abstract: ABSTRACT }),
	);
const said = (id: string) => ({
	id: id,
	text: "Check this.",
	created: SAVED_AT,
	edited: null,
});
const onPassage = (id: string, extra: Record<string, unknown> = {}) => ({
	id: id,
	field: "abstract",
	passage: "abstract words",
	occurrence: 1,
	comments: [],
	...extra,
});

test("commented shows the entries with a comment, on a passage, a highlight or the whole entry", async () => {
	const site = siteOf([{ date: TODAY, entries: notedPapers(5) }]);
	await owner(site, {
		comments: {
			"arxiv:2609.00001": [onPassage("t1", { comments: [said("c1")] })],
			"arxiv:2609.00002": [
				onPassage("t2", { highlight: true, comments: [said("c2")] }),
			],
			"arxiv:2609.00003": [{ id: "t3", comments: [said("c3")] }],
			"arxiv:2609.00004": [onPassage("t4", { highlight: true })],
		},
	});
	pick("read", "commented");
	expect(shownTitles()).toEqual(["P1", "P2", "P3"]);
});

test("highlighted shows the entries with a highlight, with or without a comment", async () => {
	const site = siteOf([{ date: TODAY, entries: notedPapers(4) }]);
	await owner(site, {
		comments: {
			"arxiv:2609.00001": [onPassage("t1", { comments: [said("c1")] })],
			"arxiv:2609.00002": [
				onPassage("t2", { highlight: true, comments: [said("c2")] }),
			],
			"arxiv:2609.00003": [onPassage("t3", { highlight: true })],
		},
	});
	pick("read", "highlighted");
	expect(shownTitles()).toEqual(["P2", "P3"]);
});

test("commented and highlighted together show the entries that have both", async () => {
	const site = siteOf([{ date: TODAY, entries: notedPapers(4) }]);
	await owner(site, {
		comments: {
			"arxiv:2609.00001": [
				{ id: "t1", comments: [said("c1")] },
				onPassage("t1b", { highlight: true }),
			],
			"arxiv:2609.00002": [
				onPassage("t2", { highlight: true, comments: [said("c2")] }),
			],
			"arxiv:2609.00003": [{ id: "t3", comments: [said("c3")] }],
			"arxiv:2609.00004": [onPassage("t4", { highlight: true })],
		},
	});
	pick("read", "commented");
	pick("read", "highlighted");
	expect(shownTitles()).toEqual(["P1", "P2"]);
});

test("a thread whose last comment was deleted no longer counts as commented", async () => {
	const site = siteOf([{ date: TODAY, entries: notedPapers(3) }]);
	await owner(site, {
		comments: {
			// A highlight keeps its thread when its comments are all deleted.
			"arxiv:2609.00001": [onPassage("t1", { highlight: true })],
			"arxiv:2609.00002": [onPassage("t2", { comments: [said("c2")] })],
		},
	});
	pick("read", "commented");
	expect(shownTitles()).toEqual(["P2"]);
	pick("read", "commented");
	pick("read", "highlighted");
	expect(shownTitles()).toEqual(["P1"]);
	expect(notesOfThreads([{ id: "t", highlight: true, comments: [] }])).toEqual({
		commented: false,
		highlighted: true,
	});
});

test("the sentence reads commented and highlighted in the marks blank, after the read and tag words", async () => {
	const site = siteOf([{ date: TODAY, entries: notedPapers(2) }]);
	await owner(site, {
		read: { "arxiv:2609.00001": { depth: "abstract", date: TODAY } },
		tags: { "arxiv:2609.00001": { toRead: true } },
		comments: {
			"arxiv:2609.00001": [
				onPassage("t1", { highlight: true, comments: [said("c1")] }),
			],
		},
	});
	pick("read", "abstract read");
	pick("read", "To read");
	pick("read", "highlighted");
	pick("read", "commented");
	pick("read", "ad hoc");
	expect(sentence()).toContain(
		"abstract read and tagged To read and commented and highlighted and added ad hoc.",
	);
	for (const label of ["commented", "highlighted"]) {
		expect(word(label).getAttribute("aria-pressed")).toBe("true");
	}
});

test("the public page offers neither commented nor highlighted", async () => {
	const site = siteOf([{ date: TODAY, entries: notedPapers(2) }]);
	await openPage(site);
	expect(document.querySelector('[data-blank="read"]')).toBeNull();
	for (const name of ["kind", "subject", "venue", "time"]) {
		blank(name).click();
		const labels = words().map((one) => one.getAttribute("aria-label"));
		expect(labels).not.toContain("commented");
		expect(labels).not.toContain("highlighted");
	}
	expect(sentence()).not.toMatch(/commented|highlighted/);
});

test("a comment or highlight made while Search shows commented or highlighted keeps the Feed as it was until the next pick", async () => {
	const site = siteOf([{ date: TODAY, entries: notedPapers(2) }]);
	await owner(site, {
		comments: {
			"arxiv:2609.00001": [onPassage("t1", { highlight: true })],
		},
	});
	pick("read", "highlighted");
	expect(shownTitles()).toEqual(["P1"]);
	// jsdom lays nothing out: the highlight gets one empty box to place its menu by.
	const box = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
	vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
		box,
	] as unknown as DOMRectList);
	document.querySelector<HTMLElement>("mark.comment-mark")?.click();
	const remove = [
		...document.querySelectorAll<HTMLButtonElement>(".highlight-menu button"),
	].find((button) => button.textContent?.trim() === "Remove highlight");
	if (remove === undefined) throw new Error("no Remove highlight button");
	remove.click();
	expect(document.querySelector("mark.comment-mark")).toBeNull();
	expect(shownTitles()).toEqual(["P1"]);
	pick("read", "highlighted");
	expect(shownTitles()).toEqual(["P1", "P2"]);
});
