// @vitest-environment jsdom
// The contents sidebar, its day rows, "Collapse all", links to entries and the arrow keys, on the page start() draws
// (site/page/contents.ts, older-day.ts, permalinks.ts). jsdom lays nothing out, so the entry being read is the one a
// jump last named.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	hashIds,
	hashTarget,
	startReloadAtTop,
} from "../../site/page/contents.ts";
import {
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
	// 12:00 on Sunday 27 September 2026 in Jakarta.
	vi.setSystemTime(new Date("2026-09-27T05:00:00Z"));
});

afterEach(() => {
	releasePage();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	unloadKatex();
	history.replaceState(null, "", "/");
	document.body.replaceChildren();
});

const TODAY = "2026-09-27";
const SATURDAY = "2026-09-26";
const THURSDAY = "2026-09-24";

// Entries with ids and titles a test can tell apart.
const papers = (prefix: string, count: number) =>
	Array.from({ length: count }, (_, i) =>
		paperEntry(
			`${prefix}.${String(i + 1).padStart(5, "0")}`,
			`${prefix} paper ${i + 1}`,
		),
	);

// Today with 8 papers, Saturday with 3 and Thursday with 2: all in September, so all drawn from one month file.
function eightThreeTwo() {
	return siteOf([
		{ date: TODAY, entries: papers("2609", 8) },
		{ date: SATURDAY, entries: papers("2610", 3) },
		{ date: THURSDAY, entries: papers("2611", 2) },
	]);
}

const contentsLink = (title: string) => {
	const link = [
		...document.querySelectorAll<HTMLAnchorElement>(".contents a"),
	].find((one) => one.textContent === title);
	if (link === undefined) throw new Error(`no contents title ${title}`);
	return link;
};
const dayRow = (label: string) => {
	const row = [
		...document.querySelectorAll<HTMLButtonElement>(".contents__day"),
	].find((one) => one.textContent === label);
	if (row === undefined) throw new Error(`no contents row ${label}`);
	return row;
};
const marked = () => texts('.contents a[aria-current="true"]');
const collapseAll = () => {
	const button = document.querySelector<HTMLElement>(".contents__collapse");
	if (button === null) throw new Error("no Collapse all");
	return button;
};
const pageDay = (date: string) => {
	const day = document.querySelector<HTMLDetailsElement>(
		`details[data-date="${date}"]`,
	);
	if (day === null) throw new Error(`no day ${date}`);
	return day;
};
// The settled toggle of a day, which jsdom fires after `open` changes.
const settle = () => new Promise((done) => setTimeout(done, 0));

// Click a title in the contents and wait for the hash change the click makes, so no late hashchange moves the mark again.
async function goTo(title: string) {
	const link = contentsLink(title);
	let changed: Promise<unknown> | null = null;
	if (location.hash !== link.getAttribute("href"))
		changed = new Promise((done) => {
			window.addEventListener("hashchange", done, { once: true });
		});
	link.click();
	await changed;
	await settle();
}

function press(
	key: string,
	init: KeyboardEventInit = {},
	on: Element = document.body,
) {
	const event = new KeyboardEvent("keydown", {
		key: key,
		bubbles: true,
		cancelable: true,
		...init,
	});
	on.dispatchEvent(event);
	return event;
}

test("the contents show today's date and titles under their groups, and each older day as a row with its item count", async () => {
	const site = siteOf([
		{
			date: TODAY,
			entries: [
				newsEntry("tc", "Techcrunch news", { url: "https://techcrunch.com/a" }),
				paperEntry("2609.00001", "First paper"),
				{
					id: "url:lw",
					type: "article",
					title: "LessWrong post",
					url: "https://www.lesswrong.com/p",
				},
				paperEntry("2609.00002", "Second paper"),
				{
					id: "url:an",
					type: "article",
					title: "Anthropic post",
					url: "https://www.anthropic.com/p",
				},
			],
		},
		{ date: SATURDAY, entries: papers("2610", 3) },
		{ date: THURSDAY, entries: papers("2611", 2) },
	]);
	await openPage(site);
	expect(texts(".contents__date")).toEqual(["Sunday 27 September"]);
	expect(texts(".contents__newest .contents__group")).toEqual([
		"Papers",
		"From the labs",
		"LessWrong",
		"News",
	]);
	expect(texts(".contents__newest .contents__section li")).toEqual([
		"First paper",
		"Second paper",
		"Anthropic post",
		"LessWrong post",
		"Techcrunch news",
	]);
	expect(texts(".contents__day")).toEqual([
		"Sat 26 Sep · 3 items",
		"Thu 24 Sep · 2 items",
	]);
	expect(texts(".contents__count")).toEqual(["· 5 items"]);
});

test('in the contents, the surprise paper is tagged "Surprise", an ad hoc paper shows an icon labelled "Ad hoc", and other papers have no tag', async () => {
	const entries = [
		paperEntry("2609.00001", "Plain"),
		paperEntry("2609.00002", "Odd one", { pick: "surprise" }),
		paperEntry("2609.00003", "Added by hand", { ad_hoc: true }),
	];
	await openPage(siteOf([{ date: TODAY, entries: entries }]));
	const item = (title: string) => contentsLink(title).closest("li");
	expect(texts(".contents__tag")).toEqual(["", "Surprise"]);
	expect(item("Odd one")?.querySelector(".contents__tag")?.textContent).toBe(
		"Surprise",
	);
	expect(item("Plain")?.querySelector(".contents__tag")).toBeNull();
	const icon = item("Added by hand")?.querySelector(".contents__tag--icon");
	expect(icon?.getAttribute("aria-label")).toBe("Ad hoc");
	expect(icon?.getAttribute("title")).toBe("Ad hoc");
	expect(icon?.textContent).toBe("");
	expect(icon?.querySelector("svg")).not.toBeNull();
});

test("in the contents, a paper title shows typeset math, and a TeX link in a title shows as plain words inside the title's link", async () => {
	loadKatex();
	await openPage(
		siteOf([
			{
				date: TODAY,
				entries: [
					paperEntry("2609.00001", "Sorting in $O(n^2)$ time"),
					paperEntry(
						"2609.00002",
						"The \\href{https://example.com/d}{Data} paper",
					),
				],
			},
		]),
	);
	expect(contentsLink("The Data paper").querySelector("a")).toBeNull();
	expect(contentsLink("The Data paper").getAttribute("href")).toBe(
		"#arxiv:2609.00002",
	);
	const first = document.querySelector('.contents a[href="#arxiv:2609.00001"]');
	expect(first?.querySelector(".katex")).not.toBeNull();
});

test("clicking an older day's row in the contents unfolds it and lists its titles, and clicking again folds it", async () => {
	await openPage(eightThreeTwo());
	const row = dayRow("Sat 26 Sep · 3 items");
	const titles = row.nextElementSibling as HTMLElement;
	expect(row.getAttribute("aria-expanded")).toBe("false");
	expect(titles.hidden).toBe(true);
	row.click();
	await settle();
	expect(pageDay(SATURDAY).open).toBe(true);
	expect(row.getAttribute("aria-expanded")).toBe("true");
	expect(titles.hidden).toBe(false);
	expect(texts(".contents__day-titles:not([hidden]) li")).toEqual([
		"2610 paper 1",
		"2610 paper 2",
		"2610 paper 3",
	]);
	row.click();
	await settle();
	expect(pageDay(SATURDAY).open).toBe(false);
	expect(titles.hidden).toBe(true);
});

test("folding a day in the page also folds it in the contents, and unfolding it in the page unfolds it there", async () => {
	await openPage(eightThreeTwo());
	const row = dayRow("Sat 26 Sep · 3 items");
	pageDay(SATURDAY).open = true;
	await settle();
	expect(row.getAttribute("aria-expanded")).toBe("true");
	pageDay(SATURDAY).open = false;
	await settle();
	expect(row.getAttribute("aria-expanded")).toBe("false");
	expect((row.nextElementSibling as HTMLElement).hidden).toBe(true);
});

test('"Collapse all" is hidden while no older day is open, and shows once one opens from the contents or the page', async () => {
	await openPage(eightThreeTwo());
	expect(collapseAll().hidden).toBe(true);
	dayRow("Sat 26 Sep · 3 items").click();
	await settle();
	expect(collapseAll().hidden).toBe(false);
	pageDay(SATURDAY).open = false;
	await settle();
	expect(collapseAll().hidden).toBe(true);
	pageDay(THURSDAY).open = true;
	await settle();
	expect(collapseAll().hidden).toBe(false);
});

test('"Collapse all" folds every older day, keeps today listed, and hides itself', async () => {
	await openPage(eightThreeTwo());
	dayRow("Sat 26 Sep · 3 items").click();
	dayRow("Thu 24 Sep · 2 items").click();
	await settle();
	collapseAll().click();
	await settle();
	expect(pageDay(SATURDAY).open).toBe(false);
	expect(pageDay(THURSDAY).open).toBe(false);
	expect(texts(".contents__day-titles:not([hidden]) li")).toEqual([]);
	expect(texts(".contents__newest li")).toHaveLength(8);
	expect(collapseAll().hidden).toBe(true);
});

test("a permalink into a folded day unfolds it in the page and in the contents, with its title marked", async () => {
	await openPage(eightThreeTwo(), { hash: "#arxiv:2610.00002" });
	await settle();
	expect(pageDay(SATURDAY).open).toBe(true);
	expect(dayRow("Sat 26 Sep · 3 items").getAttribute("aria-expanded")).toBe(
		"true",
	);
	expect(marked()).toEqual(["2610 paper 2"]);
});

test("a permalink to an id that is in no digest loads only the newest month and still draws today's entries", async () => {
	const site = siteOf([
		{ date: "2026-09-27", entries: papers("2609", 2) },
		{ date: "2026-08-20", entries: papers("2608", 2) },
	]);
	await openPage(site, { hash: "#arxiv:2501.00000" });
	await settle();
	expect(
		site.requested.filter(
			(path) => path !== "data/selected.json" && path !== "data/search.json",
		),
	).toEqual(["data/index.json", "data/months/2026-09.json"]);
	expect(texts("section.day .entry__title")).toEqual([
		"2609 paper 1",
		"2609 paper 2",
	]);
});

test("a permalink with broken percent encoding is ignored, and a valid permalink after it still opens its day", async () => {
	await openPage(eightThreeTwo(), { hash: "#url:50%off" });
	await settle();
	expect(document.querySelectorAll("article")).toHaveLength(13);
	expect(pageDay(SATURDAY).open).toBe(false);
	location.hash = "#arxiv:2610.00001";
	await vi.waitFor(() => expect(pageDay(SATURDAY).open).toBe(true));
});

test("an id with a % in it is found as written and as decoded", () => {
	const wanted = document.createElement("article");
	wanted.id = "url:https://example.com/50%off?x=1";
	document.body.append(wanted);
	history.replaceState(null, "", "/#url:https://example.com/50%25off?x=1");
	expect(hashIds()).toEqual([
		"url:https://example.com/50%25off?x=1",
		"url:https://example.com/50%off?x=1",
	]);
	expect(hashTarget()).toBe(wanted);
	history.replaceState(null, "", "/#url:50%off");
	expect(hashIds()).toEqual(["url:50%off", "url:50%off"]);
	expect(hashTarget()).toBeNull();
	history.replaceState(null, "", "/");
	expect(hashIds()).toEqual([]);
});

test("clicking a title in the contents marks it current and goes to its entry", async () => {
	await openPage(
		siteOf([
			{
				date: TODAY,
				entries: [
					...papers("2609", 8),
					newsEntry("n", "The news", {
						id: "url:https://example.com/news/1?ref=feed",
						url: "https://example.com/news/1",
					}),
				],
			},
		]),
	);
	const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");
	await goTo("The news");
	expect(marked()).toEqual(["The news"]);
	expect(location.hash).toBe("#url:https://example.com/news/1?ref=feed");
	expect(scrolled).not.toHaveBeenCalledWith(undefined);
});

test("the right arrow key goes to the next entry in the contents' order, and the left arrow back", async () => {
	await openPage(eightThreeTwo());
	await goTo("2609 paper 1");
	const right = press("ArrowRight");
	expect(right.defaultPrevented).toBe(true);
	await vi.waitFor(() => expect(marked()).toEqual(["2609 paper 2"]));
	expect(location.hash).toBe("#arxiv:2609.00002");
	press("ArrowRight");
	await vi.waitFor(() => expect(marked()).toEqual(["2609 paper 3"]));
	press("ArrowRight");
	await vi.waitFor(() => expect(marked()).toEqual(["2609 paper 4"]));
	press("ArrowLeft");
	await vi.waitFor(() => expect(marked()).toEqual(["2609 paper 3"]));
});

test("the left arrow on the first entry and the right arrow on the last entry are left to the browser", async () => {
	await openPage(
		siteOf([
			{ date: TODAY, entries: papers("2609", 3) },
			{ date: SATURDAY, entries: papers("2610", 3) },
		]),
	);
	await goTo("2609 paper 1");
	const hash = location.hash;
	const left = press("ArrowLeft");
	expect(left.defaultPrevented).toBe(false);
	expect(location.hash).toBe(hash);
	await goTo("2609 paper 3");
	const right = press("ArrowRight");
	expect(right.defaultPrevented).toBe(false);
	expect(marked()).toEqual(["2609 paper 3"]);
});

test("the right arrow key continues into an unfolded older day and skips a folded one", async () => {
	await openPage(eightThreeTwo());
	await goTo("2609 paper 8");
	expect(press("ArrowRight").defaultPrevented).toBe(false);
	dayRow("Sat 26 Sep · 3 items").click();
	await settle();
	await goTo("2609 paper 8");
	press("ArrowRight");
	await vi.waitFor(() => expect(marked()).toEqual(["2610 paper 1"]));
});

test("an arrow key with Cmd, Ctrl, Alt or Shift is left to the browser", async () => {
	await openPage(eightThreeTwo());
	await goTo("2609 paper 3");
	for (const modifier of ["metaKey", "ctrlKey", "altKey", "shiftKey"]) {
		const event = press("ArrowRight", { [modifier]: true });
		expect(event.defaultPrevented).toBe(false);
	}
	expect(marked()).toEqual(["2609 paper 3"]);
});

test("an arrow key in a text box, or while a side panel is open, does not move to another entry", async () => {
	await openPage(eightThreeTwo());
	await goTo("2609 paper 3");
	const box = document.createElement("textarea");
	document.body.append(box);
	expect(press("ArrowRight", {}, box).defaultPrevented).toBe(false);
	box.remove();
	const panel = document.createElement("dialog");
	panel.setAttribute("open", "");
	document.body.append(panel);
	expect(press("ArrowRight").defaultPrevented).toBe(false);
	expect(marked()).toEqual(["2609 paper 3"]);
});

test("a wide window shows the contents open, and a narrow one folds them into one row", async () => {
	await openPage(eightThreeTwo());
	expect(
		document.querySelector<HTMLDetailsElement>("details.contents__box")?.open,
	).toBe(true);
	document.body.replaceChildren();
	await openPage(eightThreeTwo(), { narrow: true });
	const box = document.querySelector<HTMLDetailsElement>(
		"details.contents__box",
	);
	expect(box?.open).toBe(false);
	expect(box?.querySelector("summary")?.textContent).toBe("Contents · 8 items");
});

test("on a narrow window a tapped title folds the contents, and a tapped day row does not", async () => {
	await openPage(eightThreeTwo(), { narrow: true });
	const box = document.querySelector<HTMLDetailsElement>(
		"details.contents__box",
	);
	if (box === null) throw new Error("no contents");
	box.open = true;
	dayRow("Sat 26 Sep · 3 items").click();
	await settle();
	expect(box.open).toBe(true);
	contentsLink("2609 paper 5").click();
	expect(box.open).toBe(false);
});

test("a reload starts again from the top: the hash is dropped and the browser's own scroll restoration is turned off", () => {
	const scrollTo = vi.fn();
	vi.stubGlobal("scrollTo", scrollTo);
	Object.defineProperty(window, "navigation", {
		value: { activation: { navigationType: "reload" } },
		configurable: true,
	});
	history.replaceState(null, "", "/liminal-space/?q=1#arxiv:2609.00002");
	startReloadAtTop();
	expect(history.scrollRestoration).toBe("manual");
	expect(location.hash).toBe("");
	expect(location.search).toBe("?q=1");
	document.dispatchEvent(new Event("DOMContentLoaded"));
	expect(scrollTo).toHaveBeenCalledWith(0, 0);
	window.dispatchEvent(new Event("pagehide"));
	expect(history.scrollRestoration).toBe("auto");
	Reflect.deleteProperty(window, "navigation");
});

test("the hash stays when the page is opened by following a link, and when the browser has no navigation API", () => {
	history.replaceState(null, "", "/liminal-space/#arxiv:2609.00002");
	startReloadAtTop();
	expect(location.hash).toBe("#arxiv:2609.00002");
	Object.defineProperty(window, "navigation", {
		value: { activation: { navigationType: "navigate" } },
		configurable: true,
	});
	startReloadAtTop();
	expect(location.hash).toBe("#arxiv:2609.00002");
	Reflect.deleteProperty(window, "navigation");
});
