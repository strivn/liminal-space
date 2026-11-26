// @vitest-environment jsdom
// The Search sentence: its blanks, what each choice shows in the Feed, and the choice panels.
import { afterEach, expect, test, vi } from "vitest";
import type { SearchEntry } from "../../shared/site-data-shape.ts";
import { PHONE_QUERY } from "../../site/page/phone.ts";
import {
	createSearch,
	type EntryMarks,
	matchesSentence,
	type Sentence,
	startingSentence,
} from "../../site/page/search.ts";
import { openPage, paperEntry, releasePage, siteOf } from "./page-site.ts";

const TODAY = "2026-11-26";
const WIDE_QUERY = "(min-width: 1080px)";

afterEach(() => {
	releasePage();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	history.replaceState(null, "", "/");
	document.body.replaceChildren();
});

function entry(fields: Partial<SearchEntry> & { id: string }): SearchEntry {
	return {
		date: TODAY,
		type: "paper",
		topic: null,
		keywords: [],
		venue: null,
		...fields,
	};
}

function topic(name: string, field = "Computer Science") {
	return { name, field };
}

// The ids shown, given marks by id.
function shown(
	sentence: Partial<Sentence>,
	entries: SearchEntry[],
	marks: Record<string, EntryMarks> | null = null,
) {
	const full = { ...startingSentence(TODAY), time: "any", ...sentence };
	return entries
		.filter((e) =>
			matchesSentence(
				e,
				full,
				TODAY,
				marks === null ? null : (marks[e.id] ?? null),
			),
		)
		.map((e) => e.id);
}

// Entries for the panels.
const ENTRIES = [
	entry({
		id: "a",
		topic: topic("Adversarial Robustness"),
		keywords: ["jailbreak detection"],
		venue: "ACL Findings 2026",
	}),
	entry({
		id: "b",
		topic: topic("Ethics of AI"),
		keywords: ["jailbreak detection", "monitoring"],
		venue: "ACL 2026",
	}),
	entry({
		id: "c",
		date: "2026-11-20",
		topic: topic("Adversarial Robustness"),
	}),
	entry({ id: "d", type: "news" }),
	entry({
		id: "e",
		date: "2026-10-30",
		topic: topic("Ethics of AI"),
		keywords: ["red teaming"],
		venue: "ICML 2026",
	}),
	entry({ id: "f" }),
];
const THIS_MONTH = ["a", "b", "c", "d", "f"];

type Mount = {
	wide?: boolean;
	phone?: boolean;
	marks?: Record<string, EntryMarks> | null;
};

// The sentence over `entries`; null `marks` is the public page.
function mount(entries: SearchEntry[], options: Mount = {}) {
	vi.stubGlobal("matchMedia", (query: string) => ({
		matches:
			(query === PHONE_QUERY && options.phone === true) ||
			(query === WIDE_QUERY && options.wide === true),
		media: query,
		addEventListener: () => {},
		removeEventListener: () => {},
	}));
	document.body.replaceChildren();
	const sidebar = document.createElement("div");
	sidebar.className = "sidebar";
	const root = document.createElement("div");
	sidebar.append(root);
	document.body.append(sidebar);
	const marks = options.marks ?? null;
	const changes: { shown: string[]; narrowed: boolean }[] = [];
	const loaded: string[][] = [];
	const search = createSearch(root, TODAY, {
		entries: () => entries,
		marksOf:
			marks === null
				? null
				: (id) => marks[id] ?? { read: "unread", tags: [], adHoc: false },
		loadMonths: async (months) => {
			loaded.push([...months].sort());
		},
		onChange: (ids, narrowed) => {
			changes.push({ shown: [...ids].sort(), narrowed: narrowed });
		},
	});
	const panel = () => {
		const found = root.querySelector<HTMLElement>(".search__choices");
		if (found === null) throw new Error("no choices");
		return found;
	};
	return { root, sidebar, search, changes, loaded, panel };
}

const blank = (name: string) => {
	const found = document.querySelector<HTMLElement>(`[data-blank="${name}"]`);
	if (found === null) throw new Error(`no blank ${name}`);
	return found;
};
const words = () => [
	...document.querySelectorAll<HTMLButtonElement>(
		".search__choices .search__word",
	),
];
const word = (label: string) => {
	const found = words().find((one) => one.getAttribute("aria-label") === label);
	if (found === undefined) throw new Error(`no choice ${label}`);
	return found;
};
const labels = () => words().map((one) => one.getAttribute("aria-label"));
// The number beside a choice.
const countOf = (label: string) =>
	word(label).querySelector("sup")?.textContent;
function pick(blankName: string, label: string) {
	if (blank(blankName).getAttribute("aria-expanded") !== "true")
		blank(blankName).click();
	word(label).click();
}
const sentenceText = () =>
	document.querySelector(".search__sentence")?.textContent;
const tallyText = () =>
	document.querySelector(".search__tally span")?.textContent;
const reset = () => document.querySelector<HTMLButtonElement>(".search__reset");

test("the sentence reads Show me [everything] about [any subject] from [any venue], [this month] on the public page, and adds [read or not] on the owner's", () => {
	mount(ENTRIES);
	expect(sentenceText()).toBe(
		"Show me everything about any subject from any venue, this month.",
	);
	expect(document.querySelector('[data-blank="read"]')).toBeNull();

	mount(ENTRIES, {
		marks: { e: { read: "unread", tags: ["To read"], adHoc: false } },
	});
	expect(sentenceText()).toBe(
		"Show me everything about any subject from any venue, this month, read or not.",
	);
	pick("time", "in October");
	pick("kind", "papers");
	pick("subject", "Ethics of AI");
	pick("subject", "red teaming");
	pick("venue", "ICML 2026");
	pick("read", "unread");
	pick("read", "To read");
	expect(sentenceText()).toBe(
		"Show me papers about Ethics of AI or red teaming from ICML 2026, in October, unread and tagged To read.",
	);
});
test("a topic shows only papers whose main OpenAlex topic it is, and a keyword shows only papers that carry it", () => {
	const entries = [
		entry({
			id: "a",
			topic: topic("Adversarial Robustness"),
			keywords: ["jailbreak detection"],
		}),
		entry({
			id: "b",
			topic: topic("Ethics of AI"),
			keywords: ["jailbreak detection", "monitoring"],
		}),
		entry({ id: "c", topic: topic("Adversarial Robustness") }),
		entry({ id: "d" }),
	];
	expect(shown({ subjects: ["t:Adversarial Robustness"] }, entries)).toEqual([
		"a",
		"c",
	]);
	expect(shown({ subjects: ["k:jailbreak detection"] }, entries)).toEqual([
		"a",
		"b",
	]);
	expect(shown({ subjects: ["f:Computer Science"] }, entries)).toEqual([
		"a",
		"b",
		"c",
	]);
	expect(shown({ subjects: ["none"] }, entries)).toEqual(["d"]);
	expect(shown({ subjects: ["k:jailbreak"] }, entries)).toEqual([]);
});
test("two picked subjects show entries about either, or only entries with both when the reader picks all", () => {
	const entries = [
		entry({ id: "a", topic: topic("Adversarial Robustness") }),
		entry({
			id: "b",
			topic: topic("Ethics of AI"),
			keywords: ["jailbreak detection"],
		}),
		entry({
			id: "c",
			topic: topic("Adversarial Robustness"),
			keywords: ["jailbreak detection"],
		}),
	];
	const subjects = ["t:Adversarial Robustness", "k:jailbreak detection"];
	expect(shown({ subjects, join: "or" }, entries)).toEqual(["a", "b", "c"]);
	expect(shown({ subjects, join: "and" }, entries)).toEqual(["c"]);
});
test("the kind blank shows everything, papers only, or news and articles only", () => {
	const entries = [
		entry({ id: "paper" }),
		entry({ id: "news", type: "news" }),
		entry({ id: "report", type: "report" }),
	];
	expect(shown({ kind: "all" }, entries)).toEqual(["paper", "news", "report"]);
	expect(shown({ kind: "paper" }, entries)).toEqual(["paper"]);
	expect(shown({ kind: "reading" }, entries)).toEqual(["news", "report"]);
});
test("a conference shows every one of its tracks, and a track shows only that track", () => {
	const entries = [
		entry({ id: "main", venue: "ACL 2026" }),
		entry({ id: "findings", venue: "ACL Findings 2026" }),
		entry({ id: "findings-again", venue: "ACL 2026 Findings" }),
		entry({ id: "workshop", venue: "ACL 2026 Workshop (BiAlign)" }),
		entry({ id: "other", venue: "ICML 2026" }),
		entry({ id: "preprint" }),
	];
	expect(shown({ venue: "ACL 2026" }, entries)).toEqual([
		"main",
		"findings",
		"findings-again",
		"workshop",
	]);
	expect(shown({ venue: "ACL 2026|Findings" }, entries)).toEqual([
		"findings",
		"findings-again",
	]);
	expect(shown({ venue: "ACL 2026|" }, entries)).toEqual(["main"]);
	expect(shown({ venue: "" }, entries)).toHaveLength(entries.length);
});
test("the time blank shows today, the last week, one month or any time, and loads the months its choice needs", () => {
	const entries = [
		entry({ id: "today" }),
		entry({ id: "six-days-ago", date: "2026-11-20" }),
		entry({ id: "seven-days-ago", date: "2026-11-19" }),
		entry({ id: "october", date: "2026-10-30" }),
		entry({ id: "september", date: "2026-09-02" }),
	];
	expect(shown({ time: "today" }, entries)).toEqual(["today"]);
	expect(shown({ time: "week" }, entries)).toEqual(["today", "six-days-ago"]);
	expect(shown({ time: "m:2026-10" }, entries)).toEqual(["october"]);
	expect(shown({ time: "any" }, entries)).toHaveLength(entries.length);
	expect(shown({ time: startingSentence(TODAY).time }, entries)).toEqual([
		"today",
		"six-days-ago",
		"seven-days-ago",
	]);

	// Only months holding shown entries load.
	const page = mount(entries);
	expect(page.loaded).toEqual([["2026-11"]]);
	pick("time", "in October");
	pick("time", "in September");
	pick("time", "today");
	pick("time", "in the last week");
	expect(page.loaded.slice(1)).toEqual([
		["2026-10"],
		["2026-09"],
		["2026-11"],
		["2026-11"],
	]);
	pick("time", "any time");
	expect(page.loaded.at(-1)).toEqual(["2026-09", "2026-10", "2026-11"]);
});
test("the read blank shows unread, abstract read or paper read papers, those tagged To read or Learn first, and those added ad hoc", () => {
	const entries = [
		entry({ id: "unread" }),
		entry({ id: "abstract" }),
		entry({ id: "paper" }),
		entry({ id: "to-read" }),
		entry({ id: "both-tags" }),
		entry({ id: "ad-hoc" }),
		entry({ id: "news", type: "news" }),
	];
	const mark = (fields: Partial<EntryMarks>): EntryMarks => ({
		read: "unread",
		tags: [],
		adHoc: false,
		...fields,
	});
	const marks = {
		unread: mark({}),
		abstract: mark({ read: "abstract" }),
		paper: mark({ read: "paper" }),
		"to-read": mark({ tags: ["To read"] }),
		"both-tags": mark({ tags: ["To read", "Learn first"] }),
		"ad-hoc": mark({ adHoc: true }),
		news: mark({}),
	};
	const read = (fields: Partial<Sentence["marks"]>) => ({
		marks: { read: null, tags: [], adHoc: false, ...fields },
	});
	expect(shown(read({ read: "unread" }), entries, marks)).toEqual([
		"unread",
		"to-read",
		"both-tags",
		"ad-hoc",
	]);
	expect(shown(read({ read: "abstract" }), entries, marks)).toEqual([
		"abstract",
	]);
	expect(shown(read({ read: "paper" }), entries, marks)).toEqual(["paper"]);
	expect(shown(read({ tags: ["To read"] }), entries, marks)).toEqual([
		"to-read",
		"both-tags",
	]);
	expect(
		shown(read({ tags: ["To read", "Learn first"] }), entries, marks),
	).toEqual(["both-tags"]);
	expect(shown(read({ adHoc: true }), entries, marks)).toEqual(["ad-hoc"]);
	// Public page: no marks.
	expect(shown(read({ read: "paper" }), entries)).toHaveLength(entries.length);
});
test("every choice shows how many entries it would give with the other blanks as they are, and a choice that gives none cannot be picked", () => {
	const page = mount(ENTRIES);
	blank("kind").click();
	expect(["everything", "papers", "news and articles"].map(countOf)).toEqual([
		"5",
		"4",
		"1",
	]);
	expect(tallyText()).toBe("5 of 6 entries");
	expect(document.querySelector(".search__count b")?.textContent).toBe("5");

	// October's paper is out of this month.
	blank("subject").click();
	expect(countOf("Ethics of AI")).toBe("1");
	expect(word("red teaming").disabled).toBe(true);
	const before = page.changes.length;
	word("red teaming").click();
	expect(page.changes).toHaveLength(before);
	blank("venue").click();
	expect(countOf("ACL 2026")).toBe("2");
	expect(word("ICML 2026").disabled).toBe(true);

	// Any time gives them entries.
	pick("time", "any time");
	blank("subject").click();
	expect(word("red teaming").disabled).toBe(false);
	expect(countOf("red teaming")).toBe("1");
	blank("kind").click();
	expect(["everything", "papers", "news and articles"].map(countOf)).toEqual([
		"6",
		"5",
		"1",
	]);

	// Counts follow the other blanks.
	pick("kind", "papers");
	blank("venue").click();
	expect(countOf("any venue")).toBe("5");
	expect(countOf("ACL 2026")).toBe("2");
});
test("the current month is drawn as a choice already made, and Reset shows only after a blank moved from where it started", () => {
	mount(ENTRIES, { marks: {} });
	const set = () =>
		[...document.querySelectorAll(".search__blank--set")].map((one) =>
			one.getAttribute("data-blank"),
		);
	expect(set()).toEqual(["time"]);
	expect(reset()).toBeNull();

	pick("kind", "papers");
	expect(set()).toEqual(["kind", "time"]);
	expect(reset()).not.toBeNull();
	// Back where it started.
	pick("kind", "everything");
	expect(set()).toEqual(["time"]);
	expect(reset()).toBeNull();

	pick("time", "any time");
	expect(reset()).not.toBeNull();
	pick("time", "this month");
	expect(reset()).toBeNull();
	pick("read", "unread");
	expect(set()).toEqual(["time", "read"]);
	expect(reset()).not.toBeNull();
});
test("Reset puts every blank back and shows the entries of the current month", () => {
	const page = mount(ENTRIES, { marks: {} });
	pick("time", "any time");
	pick("kind", "papers");
	pick("subject", "Ethics of AI");
	pick("venue", "ACL 2026");
	pick("read", "unread");
	expect(page.changes.at(-1)).toEqual({ shown: ["b"], narrowed: true });
	reset()?.click();
	expect(sentenceText()).toBe(
		"Show me everything about any subject from any venue, this month, read or not.",
	);
	expect(page.changes.at(-1)).toEqual({ shown: THIS_MONTH, narrowed: false });
	expect(tallyText()).toBe("5 of 6 entries");
	expect(reset()).toBeNull();
	expect(page.panel().hidden).toBe(true);
});
test("typing in the subject box lists the topics and keywords that contain the typed letters, and changes nothing in the Feed", () => {
	const page = mount(ENTRIES);
	blank("subject").click();
	const box = document.querySelector<HTMLInputElement>(".search__box");
	if (box === null) throw new Error("no box");
	const type = (text: string) => {
		box.value = text;
		box.dispatchEvent(new Event("input", { bubbles: true }));
	};
	const changes = page.changes.length;
	type("ROBUST");
	expect(labels()).toEqual(["Adversarial Robustness"]);
	type("monit");
	expect(labels()).toEqual(["monitoring"]);
	type("ethics");
	expect(labels()).toEqual(["Ethics of AI"]);
	type("zzz");
	expect(labels()).toEqual([]);
	expect(document.querySelector(".search__none")?.textContent).toBe(
		"No topic or keyword matches.",
	);
	// Nothing changed.
	expect(page.changes).toHaveLength(changes);
	expect(sentenceText()).toContain("about any subject");
	expect(tallyText()).toBe("5 of 6 entries");

	// Enter picks and closes.
	type("ethics");
	box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
	expect(sentenceText()).toContain("about Ethics of AI");
	expect(page.panel().hidden).toBe(true);
	expect(page.changes).toHaveLength(changes + 1);
});
// The owner's page over `entries`, nothing read.
async function openOwnerPage(entries: ReturnType<typeof paperEntry>[]) {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-09-27T05:00:00Z"));
	const site = siteOf([{ date: "2026-09-27", entries: entries }]);
	site.owner = {
		read: {},
		tags: {},
		comments: {},
		feedback: {},
		takeaways: {},
	};
	await openPage(site, { owner: true });
}
const openalex = (topic: string, keywords: string[] = []) => ({
	openalex: {
		topics: [{ name: topic, field: "Computer Science", score: 0.9 }],
		keywords: keywords,
	},
});
const about = (id: string) =>
	[...document.querySelectorAll(`[id="${id}"] .entry__about p`)].map(
		(line) => line.textContent,
	);
const subjectButton = (id: string, name: string) => {
	const found = [
		...document.querySelectorAll<HTMLElement>(`[id="${id}"] [data-subject]`),
	].find((one) => one.textContent === name);
	if (found === undefined) throw new Error(`no ${name} under ${id}`);
	return found;
};
const shownIds = () =>
	[...document.querySelectorAll<HTMLElement>("main article")]
		.filter((one) => !one.closest("[hidden], details:not([open])"))
		.map((one) => one.id);
test("a topic or keyword under a paper adds itself to the subject and keeps the other blanks and the reading place", async () => {
	await openOwnerPage([
		paperEntry(
			"2609.00001",
			"P1",
			openalex("Adversarial Robustness", [
				"jailbreak detection",
				"monitoring",
				"one",
				"two",
				"three",
				"four",
			]),
		),
		paperEntry(
			"2609.00002",
			"P2",
			openalex("Ethics of AI", ["jailbreak detection"]),
		),
		paperEntry("2609.00003", "P3", openalex("Adversarial Robustness")),
		{ id: "news:n", type: "news", title: "N" },
	]);
	// The topic, and 5 keywords; news has none.
	expect(about("arxiv:2609.00001")).toEqual([
		"Topics (OpenAlex): Adversarial Robustness",
		"Keywords (OpenAlex): jailbreak detection, monitoring, one, two, three",
	]);
	expect(document.querySelector('[id="news:n"] .entry__about')).toBeNull();

	// Picked blanks stay.
	pick("kind", "papers");
	pick("read", "unread");
	const place = vi.fn();
	vi.stubGlobal("scrollBy", place);
	const second = document.getElementById("arxiv:2609.00002");
	if (second === null) throw new Error("no second paper");
	second.getBoundingClientRect = vi
		.fn()
		.mockReturnValueOnce({ top: 300 })
		.mockReturnValue({ top: 120 });
	subjectButton("arxiv:2609.00002", "jailbreak detection").click();
	expect(sentenceText()).toBe(
		"Show me papers about jailbreak detection from any venue, this month, unread.",
	);
	expect(shownIds()).toEqual(["arxiv:2609.00001", "arxiv:2609.00002"]);
	// The page scrolls by how far the paper moved.
	expect(place).toHaveBeenCalledWith(0, -180);

	// Pressed under every paper that has it.
	const pressed = () =>
		[...document.querySelectorAll('[aria-pressed="true"][data-subject]')].map(
			(one) => `${one.closest("article")?.id} ${one.textContent}`,
		);
	expect(pressed()).toEqual([
		"arxiv:2609.00001 jailbreak detection",
		"arxiv:2609.00002 jailbreak detection",
	]);
	subjectButton("arxiv:2609.00001", "Adversarial Robustness").click();
	expect(sentenceText()).toContain(
		"about jailbreak detection or Adversarial Robustness",
	);
	expect(shownIds()).toEqual([
		"arxiv:2609.00001",
		"arxiv:2609.00002",
		"arxiv:2609.00003",
	]);
	expect(pressed()).toHaveLength(4);
	// A held one changes nothing.
	subjectButton("arxiv:2609.00001", "Adversarial Robustness").click();
	expect(sentenceText()).toContain(
		"about jailbreak detection or Adversarial Robustness",
	);
});
test("security: topic and keyword names under a paper are drawn as text, never as HTML", async () => {
	const topicName = "<img src=x onerror=alert(1)>";
	const keywordName = "<script>alert(2)</script>";
	await openOwnerPage([
		paperEntry("2609.00001", "P1", openalex(topicName, [keywordName])),
	]);
	const lines = document.querySelector('[id="arxiv:2609.00001"] .entry__about');
	expect(lines?.querySelectorAll("img, script, iframe, b")).toHaveLength(0);
	expect(lines?.querySelectorAll("button")).toHaveLength(2);
	expect(about("arxiv:2609.00001")).toEqual([
		`Topics (OpenAlex): ${topicName}`,
		`Keywords (OpenAlex): ${keywordName}`,
	]);
	expect(lines?.innerHTML).toContain("&lt;img src=x onerror=alert(1)&gt;");
	// Clicked, it joins the sentence as text too.
	subjectButton("arxiv:2609.00001", topicName).click();
	expect(sentenceText()).toContain(`about ${topicName}`);
	expect(
		document.querySelectorAll("main img, main script, #search img"),
	).toHaveLength(0);
});
test("a paper OpenAlex has not classified yet reads Topics (OpenAlex): none yet, and the subject no topic yet finds it", async () => {
	await openOwnerPage([
		paperEntry(
			"2609.00001",
			"P1",
			openalex("Adversarial Robustness", ["monitoring"]),
		),
		paperEntry("2609.00002", "P2"),
	]);
	expect(about("arxiv:2609.00002")).toEqual(["Topics (OpenAlex): none yet"]);
	expect(
		document.querySelector('[id="arxiv:2609.00002"] [data-subject]'),
	).toBeNull();
	pick("subject", "no topic yet");
	expect(sentenceText()).toContain("about no topic yet");
	expect(shownIds()).toEqual(["arxiv:2609.00002"]);
});
test("on a wide window the choices open beside the sidebar, so the sentence and its count stay in view", () => {
	vi.stubGlobal("innerWidth", 1280);
	vi.stubGlobal("innerHeight", 800);
	const page = mount(ENTRIES, { wide: true });
	const rect = (fields: Partial<DOMRect>) => () => fields as DOMRect;
	page.sidebar.getBoundingClientRect = rect({ right: 276 });
	page.root.getBoundingClientRect = rect({ top: 120 });
	blank("subject").click();
	const style = page.panel().style;
	// Level with the sentence, 16px from the sidebar.
	expect([
		style.getPropertyValue("--search-left"),
		style.getPropertyValue("--search-top"),
		style.getPropertyValue("--search-width"),
		style.getPropertyValue("--search-max"),
	]).toEqual(["292px", "120px", "520px", "664px"]);
	expect(page.panel().getAttribute("role")).toBe("region");
	expect(page.panel().hasAttribute("aria-modal")).toBe(false);
	expect(page.panel().getAttribute("aria-labelledby")).toBe(
		"search-choices-title",
	);

	// The head's count follows changes.
	expect(document.querySelector(".search__count b")?.textContent).toBe("5");
	word("Ethics of AI").click();
	expect(page.panel().hidden).toBe(false);
	expect(document.querySelector(".search__count b")?.textContent).toBe("1");
	expect(document.querySelector(".search__sentence")?.textContent).toContain(
		"about Ethics of AI",
	);

	// It follows a scroll.
	page.root.getBoundingClientRect = rect({ top: 40 });
	window.dispatchEvent(new Event("scroll"));
	expect(style.getPropertyValue("--search-top")).toBe("40px");
	page.root.getBoundingClientRect = rect({ top: -300 });
	window.dispatchEvent(new Event("scroll"));
	expect(style.getPropertyValue("--search-top")).toBe("16px");

	// Narrow places nothing.
	const narrow = mount(ENTRIES);
	blank("kind").click();
	expect(narrow.panel().style.getPropertyValue("--search-left")).toBe("");
});
test("on a phone the choices open in a sheet that holds the count, and keeps focus inside it until Done or Escape", () => {
	const page = mount(ENTRIES, { phone: true });
	blank("subject").click();
	const panel = page.panel();
	expect(panel.getAttribute("role")).toBe("dialog");
	expect(panel.getAttribute("aria-modal")).toBe("true");
	expect(
		panel.querySelector(".search__choices-head .search__count b")?.textContent,
	).toBe("5");
	expect(panel.querySelector('[class*="handle"]')).toBeNull();
	expect(document.querySelector<HTMLElement>(".search__backdrop")?.hidden).toBe(
		false,
	);
	// Focus enters the sheet, not the box.
	expect(panel.contains(document.activeElement)).toBe(true);
	expect(document.activeElement).not.toBe(
		document.querySelector(".search__box"),
	);

	// Tab wraps both ways.
	const focusable = [
		...panel.querySelectorAll<HTMLElement>("button:not(:disabled), input"),
	];
	const first = focusable[0];
	const last = focusable.at(-1);
	if (first === undefined || last === undefined) throw new Error("no controls");
	const press = (shiftKey: boolean) =>
		document.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "Tab",
				shiftKey: shiftKey,
				bubbles: true,
				cancelable: true,
			}),
		);
	last.focus();
	press(false);
	expect(document.activeElement).toBe(first);
	press(true);
	expect(document.activeElement).toBe(last);

	// Escape and Done close it.
	document.dispatchEvent(
		new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
	);
	expect(panel.hidden).toBe(true);
	expect(document.activeElement).toBe(blank("subject"));
	blank("subject").click();
	panel.querySelector<HTMLButtonElement>(".search__done")?.click();
	expect(panel.hidden).toBe(true);
	expect(document.activeElement).toBe(blank("subject"));
	blank("subject").click();
	document.querySelector<HTMLElement>(".search__backdrop")?.click();
	expect(panel.hidden).toBe(true);
});
test("accessibility: each blank is named for what it filters, single-choice panels are radio groups, and the count is spoken once the reader stops changing it", () => {
	vi.useFakeTimers();
	mount(ENTRIES, { marks: {} });
	expect(
		["kind", "subject", "venue", "time", "read"].map((name) => [
			blank(name).getAttribute("aria-label"),
			blank(name).getAttribute("aria-expanded"),
			blank(name).getAttribute("aria-controls"),
		]),
	).toEqual([
		["Kind: everything", "false", "search-choices"],
		["Subject: any subject", "false", "search-choices"],
		["Venue: any venue", "false", "search-choices"],
		["Time: this month", "false", "search-choices"],
		["Read: read or not", "false", "search-choices"],
	]);
	blank("kind").click();
	expect(blank("kind").getAttribute("aria-expanded")).toBe("true");

	// Radios: the one made is the tab stop.
	const group = document.querySelector('[role="radiogroup"]');
	expect(group?.getAttribute("aria-label")).toBe("Kind");
	const radios = [
		...(group?.querySelectorAll<HTMLElement>('[role="radio"]') ?? []),
	];
	expect(
		radios.map((one) => [
			one.getAttribute("aria-label"),
			one.getAttribute("aria-checked"),
			one.tabIndex,
		]),
	).toEqual([
		["everything", "true", 0],
		["papers", "false", -1],
		["news and articles", "false", -1],
	]);
	radios[0]?.focus();
	group?.dispatchEvent(
		new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
	);
	expect(document.activeElement).toBe(radios[1]);
	group?.dispatchEvent(
		new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
	);
	group?.dispatchEvent(
		new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
	);
	expect(document.activeElement).toBe(radios[2]);
	// The count is the description.
	expect(
		radios.map(
			(one) =>
				document.getElementById(one.getAttribute("aria-describedby") ?? "")
					?.textContent,
		),
	).toEqual(["5 entries", "4 entries", "1 entry"]);
	for (const name of ["time", "venue"]) {
		blank(name).click();
		expect(
			document.querySelector('[role="radiogroup"]')?.getAttribute("aria-label"),
		).toBe(name === "time" ? "Time" : "Venue");
	}
	// Toggles are pressed or not.
	blank("subject").click();
	expect(word("Ethics of AI").getAttribute("aria-pressed")).toBe("false");

	// The count is spoken once it settles.
	const live = document.querySelector(".search__tally + [aria-live]");
	expect(live?.getAttribute("aria-live")).toBe("polite");
	pick("kind", "papers");
	vi.advanceTimersByTime(300);
	pick("time", "any time");
	vi.advanceTimersByTime(599);
	expect(live?.textContent).toBe("");
	vi.advanceTimersByTime(1);
	expect(live?.textContent).toBe("5 entries");
});
test("security: topic, keyword and venue names from the search file are drawn as text, never as HTML", () => {
	const topicName = "<img src=x onerror=alert(1)>";
	const keywordName = "<script>alert(2)</script>";
	const venueName = "<iframe src=//evil.example></iframe> 2026";
	const page = mount([
		entry({
			id: "x",
			topic: topic(topicName, "<b>field</b>"),
			keywords: [keywordName],
			venue: venueName,
		}),
	]);
	// No element comes from a name: open, closed, and in the sentence.
	const noMarkup = () => {
		expect(page.root.querySelectorAll("img, script, iframe")).toHaveLength(0);
		expect(
			[...page.root.querySelectorAll("b")].map((one) => one.textContent),
		).not.toContain("field");
	};
	blank("subject").click();
	noMarkup();
	const subjects = labels();
	expect(subjects).toContain(topicName);
	expect(subjects).toContain(keywordName);
	expect(subjects).toContain("anything in <b>field</b>");
	expect(page.panel().textContent).toContain(topicName);
	pick("subject", topicName);
	pick("subject", keywordName);
	noMarkup();
	blank("venue").click();
	noMarkup();
	expect(labels()).toContain(venueName);
	expect(page.panel().textContent).toContain(venueName);
	pick("venue", venueName);
	noMarkup();
	expect(page.root.textContent).toContain(topicName);
	expect(page.root.textContent).toContain(keywordName);
	expect(page.root.innerHTML).toContain("&lt;img src=x onerror=alert(1)&gt;");
});
test("a page whose search file is not the search shape offers no topics, keywords or venues", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-09-27T05:00:00Z"));
	vi.spyOn(console, "warn").mockImplementation(() => {});
	const site = siteOf([
		{ date: "2026-09-27", entries: [paperEntry("2609.00001", "P1")] },
	]);
	site.files["data/search.json"] = { entries: "none" };
	await openPage(site);
	blank("subject").click();
	expect(labels()).toEqual(["any subject"]);
	blank("venue").click();
	expect(labels()).toEqual(["any venue"]);
	// The Feed still shows entries.
	expect(document.querySelectorAll("main article")).toHaveLength(1);
	expect(tallyText()).toBe("1 of 1 entries");
});
