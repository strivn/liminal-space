// @vitest-environment jsdom
// The owner's page start() draws from an in-memory site: read toggles and chips, tags, likes, the heatmap, the header's
// progress line, and the month in view (site/page/render.ts, state.ts, read-board.ts, tag-board.ts, month-scope.ts).
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	type FakeSite,
	newsEntry,
	openPage,
	paperEntry,
	releasePage,
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
	feedback?: Record<string, unknown>;
	takeaways?: Record<string, unknown>;
	comments?: Record<string, unknown>;
};

// Papers 2609.00001 to 2609.0000n titled "P1" to "Pn", unless a prefix says otherwise.
const papers = (count: number, prefix = "2609") =>
	Array.from({ length: count }, (_, i) =>
		paperEntry(
			`${prefix}.${String(i + 1).padStart(5, "0")}`,
			`P${i + 1}${prefix === "2609" ? "" : `-${prefix}`}`,
		),
	);

// The owner's page over `site`, which holds `saved` as the owner's state.
async function owner(site: FakeSite, saved: Saved = {}) {
	site.owner = {
		read: saved.read ?? {},
		tags: saved.tags ?? {},
		comments: saved.comments ?? {},
		feedback: saved.feedback ?? {},
		takeaways: saved.takeaways ?? {},
	};
	await openPage(site, { owner: true });
}

const settle = () => new Promise((done) => setTimeout(done, 0));
const entry = (id: string) => {
	const found = document.getElementById(id);
	if (found === null) throw new Error(`no entry ${id}`);
	return found;
};
const control = (id: string, name: string) => {
	const found = entry(id).querySelector<HTMLButtonElement>(
		`button[aria-label="${name}"]`,
	);
	if (found === null) throw new Error(`no ${name} on ${id}`);
	return found;
};
const pressed = (id: string, name: string) =>
	control(id, name).getAttribute("aria-pressed") === "true";
const chip = (label: string) => {
	const found = [
		...document.querySelectorAll<HTMLButtonElement>(".tag-chip, .read-chip"),
	].find((one) =>
		(one.getAttribute("aria-label") ?? "").startsWith(`${label} (`),
	);
	if (found === undefined) throw new Error(`no chip ${label}`);
	return found;
};
const chipLabels = () =>
	[...document.querySelectorAll(".tag-filter button, .read-filter button")].map(
		(one) => one.getAttribute("aria-label"),
	);
// The titles of the entries the page shows now: not hidden by a filter, not in a hidden or folded day.
const shownTitles = () =>
	[...document.querySelectorAll<HTMLElement>("main article")]
		.filter(
			(one) =>
				!one.hidden &&
				!one.closest("[hidden], .month-hidden, details:not([open])"),
		)
		.map((one) => one.querySelector(".entry__title")?.textContent);
// The titles the contents list now, less the ones a filter hid.
const listedTitles = () =>
	[...document.querySelectorAll<HTMLElement>(".contents li:not([role])")]
		.filter((one) => !one.closest("[hidden]"))
		.map((one) => one.textContent);
const posts = (site: FakeSite, route: string) =>
	site.posts
		.filter((one) => one.path === `api/owner/${route}`)
		.map((one) => one.body);

// ---- Read toggles ----

test("an id with %, ? and # keeps its read state over a reload", async () => {
	const id = "doi:10.5555/a?b=50%25#c";
	const paper = { id: id, type: "paper", title: "Odd id" };
	const site = siteOf([{ date: TODAY, entries: [paper] }]);
	await owner(site);
	control(id, "Abstract").click();
	await settle();
	expect(posts(site, "read")).toEqual([
		{ id: id, depth: "abstract", date: "2026-09-27" },
	]);
	releasePage();
	document.body.replaceChildren();
	await owner(site, { read: { [id]: { depth: "abstract", date: TODAY } } });
	expect(pressed(id, "Abstract")).toBe(true);
});

test("a read mark saved on news counts nowhere, and nothing is sent for it", async () => {
	const site = siteOf([
		{ date: TODAY, entries: [...papers(2), newsEntry("n", "News item")] },
	]);
	await owner(site, { read: { "news:n": { depth: "paper", date: TODAY } } });
	expect(chipLabels()).toEqual([
		"To read (0)",
		"Learn first (0)",
		"Ad hoc (0)",
		"Unread (2)",
		"Abstract (0)",
		"Paper (0)",
	]);
	expect(site.posts).toEqual([]);
});

test("a paper marked read on another device shows as read, with its count, when the page comes back into view", async () => {
	const site = siteOf([{ date: TODAY, entries: papers(2) }]);
	await owner(site);
	site.owner = {
		read: { "arxiv:2609.00001": { depth: "abstract", date: TODAY } },
		tags: {},
		comments: {},
		feedback: {},
		takeaways: {},
	};
	document.dispatchEvent(new Event("visibilitychange"));
	await vi.waitFor(() =>
		expect(pressed("arxiv:2609.00001", "Abstract")).toBe(true),
	);
	expect(chip("Abstract").getAttribute("aria-label")).toBe("Abstract (1)");
});

test("privacy: the public page has no icon rail, no chips, no heatmap and no progress line, and calls no API route", async () => {
	const site = siteOf([{ date: TODAY, entries: papers(2) }]);
	await openPage(site);
	expect(document.querySelector(".entry__rail")).toBeNull();
	expect(document.querySelector(".tag-filter, .read-filter")).toBeNull();
	expect(document.getElementById("heatmap")).toBeNull();
	expect(document.querySelector(".progress")).toBeNull();
	expect(site.requested.filter((path) => path.startsWith("api/"))).toEqual([]);
});

test("when the owner's state can't be read the page draws as the public page and says so", async () => {
	const site = siteOf([{ date: TODAY, entries: papers(2) }]);
	await openPage(site, { owner: true });
	expect(texts("#freshness .status")).toContain(
		"Couldn't load your reading state",
	);
	expect(document.querySelector(".entry__rail")).toBeNull();
});

// ---- Read chips ----

test("a read chip shows only the papers read to that depth, across days, and opens the days that hold one", async () => {
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
	chip("Abstract").click();
	expect(shownTitles()).toEqual(["P1", "P1-2610"]);
	expect(
		document.querySelector<HTMLDetailsElement>(
			`details[data-date="${THREE_DAYS_AGO}"]`,
		)?.open,
	).toBe(true);
	expect(
		document
			.querySelector('details[data-date="2026-09-22"]')
			?.hasAttribute("hidden"),
	).toBe(true);
	await settle();
	expect(listedTitles()).toEqual(["P1", "P1-2610"]);
	chip("Abstract").click();
	expect(shownTitles()).toEqual(["P1", "P2", "P3"]);
});

test("only one read chip is on at a time", async () => {
	const site = siteOf([{ date: TODAY, entries: papers(2) }]);
	await owner(site, {
		read: {
			"arxiv:2609.00001": { depth: "abstract", date: TODAY },
			"arxiv:2609.00002": { depth: "paper", date: TODAY },
		},
	});
	chip("Abstract").click();
	chip("Paper").click();
	expect(
		[chip("Abstract"), chip("Paper")].map((one) =>
			one.getAttribute("aria-pressed"),
		),
	).toEqual(["false", "true"]);
	expect(shownTitles()).toEqual(["P2"]);
});

test("a read chip and a tag chip together show only entries that match both", async () => {
	const site = siteOf([{ date: TODAY, entries: papers(3) }]);
	await owner(site, {
		read: { "arxiv:2609.00003": { depth: "abstract", date: TODAY } },
		tags: {
			"arxiv:2609.00001": { toRead: true },
			"arxiv:2609.00003": { toRead: true },
		},
	});
	chip("Unread").click();
	chip("To read").click();
	expect(shownTitles()).toEqual(["P1"]);
});

test("a read chip with nothing matching says so", async () => {
	const site = siteOf([{ date: TODAY, entries: papers(2) }]);
	await owner(site);
	expect(chip("Paper").getAttribute("aria-label")).toBe("Paper (0)");
	chip("Paper").click();
	expect(texts(".tag-filter__empty")).toEqual(['No entries are read "Paper"']);
	chip("Unread").click();
	chip("To read").click();
	expect(texts(".tag-filter__empty")).toEqual(["No entries match the filters"]);
});

test("while a chip filters, pressing a read button updates the counts at once and keeps the entry shown until the filter changes", async () => {
	const site = siteOf([{ date: TODAY, entries: papers(2) }]);
	await owner(site);
	chip("Unread").click();
	control("arxiv:2609.00001", "Abstract").click();
	expect(
		[chip("Unread"), chip("Abstract")].map((one) =>
			one.getAttribute("aria-label"),
		),
	).toEqual(["Unread (1)", "Abstract (1)"]);
	expect(shownTitles()).toEqual(["P1", "P2"]);
	chip("Unread").click();
	chip("Unread").click();
	expect(shownTitles()).toEqual(["P2"]);
});

test("the read chips count only the selected month, and All months counts every month the index lists", async () => {
	const site = siteOf([
		{ date: TODAY, entries: papers(2) },
		{ date: "2026-08-20", entries: papers(2, "2608") },
	]);
	await owner(site, {
		read: { "arxiv:2608.00001": { depth: "abstract", date: TODAY } },
	});
	expect(site.requested).not.toContain("data/months/2026-08.json");
	expect(chipLabels().slice(-3)).toEqual([
		"Unread (2)",
		"Abstract (0)",
		"Paper (0)",
	]);
	document.querySelector<HTMLButtonElement>(".month-all")?.click();
	await vi.waitFor(() =>
		expect(chipLabels().slice(-3)).toEqual([
			"Unread (3)",
			"Abstract (1)",
			"Paper (0)",
		]),
	);
});

// ---- Tags ----

test("a tag is saved under the entry's id, and clearing it is saved as off", async () => {
	const site = siteOf([{ date: TODAY, entries: papers(1) }]);
	await owner(site);
	control("arxiv:2609.00001", "Learn first").click();
	control("arxiv:2609.00001", "Learn first").click();
	await settle();
	expect(posts(site, "tags")).toEqual([
		{ id: "arxiv:2609.00001", tag: "learnFirst", on: true },
		{ id: "arxiv:2609.00001", tag: "learnFirst", on: false },
	]);
});

test('pressing "Paper" clears "To read" and keeps "Learn first", and unpressing "Paper" does not bring it back', async () => {
	const site = siteOf([{ date: TODAY, entries: papers(1) }]);
	await owner(site, {
		tags: { "arxiv:2609.00001": { toRead: true, learnFirst: true } },
	});
	const id = "arxiv:2609.00001";
	control(id, "Paper").click();
	expect([pressed(id, "To read"), pressed(id, "Learn first")]).toEqual([
		false,
		true,
	]);
	await settle();
	expect(posts(site, "tags")).toEqual([{ id: id, tag: "toRead", on: false }]);
	control(id, "Paper").click();
	expect(pressed(id, "To read")).toBe(false);
});

test("a tag set on another device shows, with its count, when the page comes back into view", async () => {
	const site = siteOf([{ date: TODAY, entries: papers(1) }]);
	await owner(site);
	site.owner = {
		read: {},
		tags: { "arxiv:2609.00001": { toRead: true } },
		comments: {},
		feedback: {},
		takeaways: {},
	};
	document.dispatchEvent(new Event("visibilitychange"));
	await vi.waitFor(() =>
		expect(pressed("arxiv:2609.00001", "To read")).toBe(true),
	);
	expect(chip("To read").getAttribute("aria-label")).toBe("To read (1)");
});

test("the tag chips count tagged entries across the loaded days, and a chip shows only entries with its tag and opens their days", async () => {
	const site = siteOf([
		{ date: TODAY, entries: papers(3) },
		{ date: THREE_DAYS_AGO, entries: papers(2, "2610") },
		{ date: "2026-09-22", entries: papers(1, "2611") },
	]);
	await owner(site, {
		tags: {
			"arxiv:2609.00001": { toRead: true },
			"arxiv:2609.00002": { toRead: true },
			"arxiv:2610.00001": { toRead: true, learnFirst: true },
		},
	});
	expect(
		[chip("To read"), chip("Learn first")].map((one) =>
			one.getAttribute("aria-label"),
		),
	).toEqual(["To read (3)", "Learn first (1)"]);
	chip("To read").click();
	expect(shownTitles()).toEqual(["P1", "P2", "P1-2610"]);
	expect(
		document.querySelector<HTMLDetailsElement>(
			`details[data-date="${THREE_DAYS_AGO}"]`,
		)?.open,
	).toBe(true);
	expect(
		document
			.querySelector('details[data-date="2026-09-22"]')
			?.hasAttribute("hidden"),
	).toBe(true);
});

test("both tag chips on show only entries with both tags", async () => {
	const site = siteOf([{ date: TODAY, entries: papers(3) }]);
	await owner(site, {
		tags: {
			"arxiv:2609.00001": { toRead: true },
			"arxiv:2609.00002": { learnFirst: true },
			"arxiv:2609.00003": { toRead: true, learnFirst: true },
		},
	});
	chip("To read").click();
	chip("Learn first").click();
	expect(shownTitles()).toEqual(["P3"]);
});

test("turning a chip off shows everything again and folds the days it opened", async () => {
	const site = siteOf([
		{ date: TODAY, entries: papers(3) },
		{ date: THREE_DAYS_AGO, entries: papers(2, "2610") },
	]);
	await owner(site, { tags: { "arxiv:2609.00001": { toRead: true } } });
	chip("To read").click();
	chip("To read").click();
	expect(shownTitles()).toEqual(["P1", "P2", "P3"]);
	expect(
		document.querySelector<HTMLDetailsElement>(
			`details[data-date="${THREE_DAYS_AGO}"]`,
		)?.open,
	).toBe(false);
});

test("an open day that a filter hides is closed, and opens again when the filter is turned off", async () => {
	const site = siteOf([
		{ date: TODAY, entries: papers(2) },
		{ date: THREE_DAYS_AGO, entries: papers(2, "2610") },
	]);
	await owner(site, { tags: { "arxiv:2609.00001": { toRead: true } } });
	const day = () =>
		document.querySelector<HTMLDetailsElement>(
			`details[data-date="${THREE_DAYS_AGO}"]`,
		);
	const collapse = () =>
		document.querySelector<HTMLElement>(".contents__collapse");
	document.querySelector<HTMLButtonElement>(".contents__day")?.click();
	await settle();
	expect(day()?.open).toBe(true);
	chip("To read").click();
	await settle();
	expect([day()?.hidden, day()?.open, collapse()?.hidden]).toEqual([
		true,
		false,
		true,
	]);
	chip("To read").click();
	await settle();
	expect([day()?.hidden, day()?.open, collapse()?.hidden]).toEqual([
		false,
		true,
		false,
	]);
});

test("while a chip filters, pressing a tag button updates the counts at once and keeps the entry shown until the filter changes", async () => {
	const site = siteOf([{ date: TODAY, entries: papers(2) }]);
	await owner(site, {
		tags: {
			"arxiv:2609.00001": { toRead: true },
			"arxiv:2609.00002": { toRead: true },
		},
	});
	chip("To read").click();
	control("arxiv:2609.00001", "To read").click();
	expect(chip("To read").getAttribute("aria-label")).toBe("To read (1)");
	expect(shownTitles()).toEqual(["P1", "P2"]);
	chip("To read").click();
	chip("To read").click();
	expect(shownTitles()).toEqual(["P2"]);
});

test("the tag chips count only the selected month, and turning a chip on loads no older month", async () => {
	const site = siteOf([
		{ date: TODAY, entries: papers(3) },
		{ date: "2026-08-20", entries: papers(2, "2608") },
	]);
	await owner(site, {
		tags: {
			"arxiv:2609.00001": { toRead: true },
			"arxiv:2608.00001": { toRead: true },
			"arxiv:2608.00002": { toRead: true },
		},
	});
	expect(chip("To read").getAttribute("aria-label")).toBe("To read (1)");
	chip("To read").click();
	expect(site.requested).not.toContain("data/months/2026-08.json");
	expect(shownTitles()).toEqual(["P1"]);
});

test("a month that loads only after a retry still shows only tagged entries", async () => {
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
	document.querySelector<HTMLButtonElement>(".month-all")?.click();
	await settle();
	await settle();
	chip("To read").click();
	delete site.statuses["data/months/2026-08.json"];
	const day = document.querySelector<HTMLDetailsElement>(
		'details[data-date="2026-08-20"]',
	);
	if (day === null) throw new Error("no August day");
	day.open = false;
	await settle();
	day.open = true;
	await vi.waitFor(() => expect(shownTitles()).toEqual(["P1", "P1-2608"]));
	expect(listedTitles()).toEqual(["P1", "P1-2608"]);
});

test("a permalink to an entry the filter hides leaves the filter on and says nothing is tagged", async () => {
	const site = siteOf([
		{ date: TODAY, entries: papers(1) },
		{ date: "2026-08-20", entries: papers(2, "2608") },
	]);
	await owner(site, { tags: { "arxiv:2609.00001": { toRead: true } } });
	chip("To read").click();
	location.hash = "#arxiv:2608.00001";
	await vi.waitFor(() =>
		expect(site.requested).toContain("data/months/2026-08.json"),
	);
	await settle();
	expect(texts(".tag-filter__empty")).toEqual([
		'No entries are tagged "To read"',
	]);
});

test("the arrow keys skip entries a chip hides, and the contents list marks the entry they move to", async () => {
	const site = siteOf([{ date: TODAY, entries: papers(4) }]);
	await owner(site, {
		tags: {
			"arxiv:2609.00001": { toRead: true },
			"arxiv:2609.00004": { toRead: true },
		},
	});
	chip("To read").click();
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

test("the filters are not remembered over a reload", async () => {
	const site = siteOf([{ date: TODAY, entries: papers(2) }]);
	await owner(site, { tags: { "arxiv:2609.00001": { toRead: true } } });
	chip("To read").click();
	releasePage();
	document.body.replaceChildren();
	await owner(site, { tags: { "arxiv:2609.00001": { toRead: true } } });
	expect(
		document.querySelectorAll('.tag-chip[aria-pressed="true"]'),
	).toHaveLength(0);
	expect(shownTitles()).toEqual(["P1", "P2"]);
});

test("the filters leave the header's progress line and the heatmap as they were", async () => {
	const site = siteOf([{ date: TODAY, entries: papers(3) }]);
	await owner(site, {
		read: { "arxiv:2609.00001": { depth: "paper", date: TODAY } },
		tags: { "arxiv:2609.00001": { toRead: true } },
	});
	const before = [
		texts("#freshness .progress__text"),
		document.querySelector('.heatmap__day[data-date="2026-09-27"]')?.className,
	];
	chip("To read").click();
	expect(texts("#freshness")[0]).toContain("Sunday 27 September");
	expect([
		texts("#freshness .progress__text"),
		document.querySelector('.heatmap__day[data-date="2026-09-27"]')?.className,
	]).toEqual(before);
	expect(before[0]).toEqual(["1 of 3 papers read"]);
});

// ---- Likes and dislikes ----

test("Like replaces OK, and pressing Like again clears it", async () => {
	const site = siteOf([
		{ date: TODAY, entries: [newsEntry("a", "A news item")] },
	]);
	await owner(site);
	const id = "news:a";
	control(id, "OK").click();
	control(id, "Like").click();
	expect([
		pressed(id, "OK"),
		pressed(id, "Like"),
		pressed(id, "Dislike"),
	]).toEqual([false, true, false]);
	control(id, "Like").click();
	expect([
		pressed(id, "OK"),
		pressed(id, "Like"),
		pressed(id, "Dislike"),
	]).toEqual([false, false, false]);
	await settle();
	expect(posts(site, "feedback")).toEqual([
		{ id: id, mark: "ok", date: "2026-09-27" },
		{ id: id, mark: "like", date: "2026-09-27" },
		{ id: id, mark: null, date: "2026-09-27" },
	]);
});

test("a saved Dislike or OK shows pressed, and a disliked entry stays on the page", async () => {
	const site = siteOf([
		{
			date: TODAY,
			entries: [newsEntry("a", "A news item"), newsEntry("b", "Another")],
		},
	]);
	await owner(site, {
		feedback: {
			"news:a": { mark: "dislike", date: TODAY },
			"news:b": { mark: "ok", date: TODAY },
		},
	});
	expect(pressed("news:a", "Dislike")).toBe(true);
	expect(pressed("news:b", "OK")).toBe(true);
	expect(shownTitles()).toEqual(["A news item", "Another"]);
});

test("a Like the site refuses is undone", async () => {
	const site = siteOf([
		{ date: TODAY, entries: [newsEntry("a", "A news item")] },
	]);
	site.statuses["api/owner/feedback"] = 500;
	await owner(site);
	control("news:a", "Like").click();
	await vi.waitFor(() => expect(pressed("news:a", "Like")).toBe(false));
});

test("a Like saved on another device shows when the page comes back into view", async () => {
	const site = siteOf([
		{ date: TODAY, entries: [newsEntry("a", "A news item")] },
	]);
	await owner(site);
	site.owner = {
		read: {},
		tags: {},
		comments: {},
		feedback: { "news:a": { mark: "like", date: TODAY } },
		takeaways: {},
	};
	document.dispatchEvent(new Event("visibilitychange"));
	await vi.waitFor(() => expect(pressed("news:a", "Like")).toBe(true));
});

// ---- Presses the site refuses ----

// What the page's status region, which a screen reader speaks, says now.
const said = () =>
	(document.querySelector('[role="status"]')?.textContent ?? "").trim();

test("a tag the site refuses is undone, and the page says it wasn't saved", async () => {
	const site = siteOf([{ date: TODAY, entries: papers(1) }]);
	site.statuses["api/owner/tags"] = 500;
	await owner(site);
	const id = "arxiv:2609.00001";
	control(id, "Learn first").click();
	expect(pressed(id, "Learn first")).toBe(true);
	await vi.waitFor(() => expect(pressed(id, "Learn first")).toBe(false));
	expect(said()).toMatch(/^Not saved: /);
	expect(chipLabels()).toContain("Learn first (0)");
});

test("a read mark the site refuses is undone on the buttons and on the day's square, and the page says so", async () => {
	const site = siteOf([{ date: TODAY, entries: papers(2) }]);
	site.statuses["api/owner/read"] = 500;
	await owner(site);
	const id = "arxiv:2609.00001";
	control(id, "Paper").click();
	expect([pressed(id, "Paper"), level(TODAY)]).toEqual([true, "some"]);
	await vi.waitFor(() => expect(pressed(id, "Paper")).toBe(false));
	expect(level(TODAY)).toBe("none");
	expect(said()).toMatch(/^Not saved: /);
});

test("a read mark refused after a saved one goes back to the saved one", async () => {
	const site = siteOf([{ date: TODAY, entries: papers(1) }]);
	await owner(site);
	const id = "arxiv:2609.00001";
	control(id, "Abstract").click();
	await settle();
	site.statuses["api/owner/read"] = 500;
	control(id, "Paper").click();
	await vi.waitFor(() => expect(pressed(id, "Paper")).toBe(false));
	expect(pressed(id, "Abstract")).toBe(true);
});

test('pressing "Abstract" leaves "To read" as it is', async () => {
	const site = siteOf([{ date: TODAY, entries: papers(1) }]);
	const id = "arxiv:2609.00001";
	await owner(site, { tags: { [id]: { toRead: true } } });
	control(id, "Abstract").click();
	await settle();
	expect(pressed(id, "To read")).toBe(true);
	expect(posts(site, "tags")).toEqual([]);
});

test("the app's badge counts today's unread papers, and reading one lowers it", async () => {
	const setAppBadge = vi.fn(async () => {});
	vi.stubGlobal("Notification", { permission: "granted" });
	vi.stubGlobal("navigator", {
		...navigator,
		userAgent: navigator.userAgent,
		setAppBadge: setAppBadge,
		clearAppBadge: async () => {},
	});
	const site = siteOf([{ date: TODAY, entries: papers(3) }]);
	await owner(site, {
		read: { "arxiv:2609.00001": { depth: "abstract", date: TODAY } },
	});
	await vi.waitFor(() => expect(setAppBadge).toHaveBeenLastCalledWith(2));
	control("arxiv:2609.00002", "Abstract").click();
	await vi.waitFor(() => expect(setAppBadge).toHaveBeenLastCalledWith(1));
});

// ---- Heatmap and the header's line ----

const square = (date: string) => {
	const found = document.querySelector<HTMLElement>(
		`.heatmap__day[data-date="${date}"]`,
	);
	if (found === null) throw new Error(`no square ${date}`);
	return found;
};
const level = (date: string) =>
	/heatmap__day--(\S+)/.exec(square(date).className)?.[1];

test("a day without a digest is a plain square, and a day with one is a button", async () => {
	const site = siteOf([{ date: TODAY, entries: papers(1) }]);
	await owner(site);
	expect(square(TODAY).tagName).toBe("BUTTON");
	expect(square("2026-09-25").tagName).toBe("SPAN");
	expect(level("2026-09-25")).toBe("no-digest");
});

test("a square for a day in a month the page hasn't loaded is shaded from the index", async () => {
	const site = siteOf([
		{ date: TODAY, entries: papers(1) },
		{ date: "2026-08-20", entries: papers(4, "2608") },
	]);
	await owner(site, {
		read: {
			"arxiv:2608.00001": { depth: "abstract", date: TODAY },
			"arxiv:2608.00002": { depth: "abstract", date: TODAY },
		},
	});
	expect(site.requested).not.toContain("data/months/2026-08.json");
	expect(level("2026-08-20")).toBe("some");
});

test("pressing a read button shades the square of the digest's day at once, not the square of today", async () => {
	const site = siteOf([
		{ date: TODAY, entries: papers(2) },
		{ date: "2026-09-26", entries: papers(2, "2610") },
	]);
	await owner(site);
	control("arxiv:2609.00001", "Paper").click();
	expect(level(TODAY)).toBe("some");
	control("arxiv:2609.00001", "Paper").click();
	expect(level(TODAY)).toBe("none");
	const saturday = document.querySelector<HTMLDetailsElement>(
		'details[data-date="2026-09-26"]',
	);
	if (saturday === null) throw new Error("no Saturday");
	saturday.open = true;
	for (const id of ["arxiv:2610.00001", "arxiv:2610.00002"])
		control(id, "Abstract").click();
	expect([level("2026-09-26"), level(TODAY)]).toEqual(["all", "none"]);
});

test("a paper read in depth crowns its day's square, and clearing the last in-depth read removes the crown", async () => {
	const site = siteOf([{ date: TODAY, entries: papers(2) }]);
	await owner(site, {
		read: { "arxiv:2609.00001": { depth: "paper", date: TODAY } },
	});
	expect(square(TODAY).querySelector(".heatmap__crown")).not.toBeNull();
	control("arxiv:2609.00001", "Paper").click();
	expect(square(TODAY).querySelector(".heatmap__crown")).toBeNull();
});

test("the header's progress line shows the share of the newest digest's papers read, and updates at once when a read button is pressed", async () => {
	const site = siteOf([
		{
			date: TODAY,
			entries: [...papers(6), newsEntry("a", "A"), newsEntry("b", "B")],
		},
	]);
	await owner(site, {
		read: {
			"arxiv:2609.00001": { depth: "abstract", date: TODAY },
			"arxiv:2609.00002": { depth: "paper", date: TODAY },
			"arxiv:2609.00003": { depth: "abstract", date: TODAY },
		},
	});
	expect(texts(".progress__text")).toEqual(["3 of 6 papers read"]);
	expect(
		document.querySelector<HTMLElement>(".progress__bar i")?.style.width,
	).toBe("50%");
	control("arxiv:2609.00004", "Abstract").click();
	expect(texts(".progress__text")).toEqual(["4 of 6 papers read"]);
});

test("a digest without papers shows no progress line", async () => {
	const site = siteOf([
		{ date: TODAY, entries: [newsEntry("a", "A"), newsEntry("b", "B")] },
	]);
	await owner(site);
	expect(document.querySelector(".progress")?.children).toHaveLength(0);
});

test("the header names the newest digest's day, and warns when it is 2 or more days old", async () => {
	await openPage(siteOf([{ date: "2026-09-25", entries: papers(1) }]));
	expect(texts("#freshness")[0]).toContain("Friday 25 September");
	expect(texts("#freshness .status")).toEqual(["No new digest for 2 days"]);
});

// ---- The month in view and the heatmap's days ----

test("a heatmap day in an older month clears the filters, selects that month, loads it and opens the day", async () => {
	const site = siteOf([
		{ date: TODAY, entries: papers(2) },
		{ date: "2026-08-20", entries: papers(2, "2608") },
	]);
	await owner(site, { tags: { "arxiv:2609.00001": { toRead: true } } });
	chip("To read").click();
	expect(shownTitles()).toEqual(["P1"]);
	square("2026-08-20").click();
	await vi.waitFor(() =>
		expect(
			document.querySelector<HTMLDetailsElement>(
				'details[data-date="2026-08-20"]',
			)?.open,
		).toBe(true),
	);
	expect(
		document.querySelectorAll('.tag-chip[aria-pressed="true"]'),
	).toHaveLength(0);
	expect(document.querySelector("#month-button")?.textContent).toBe(
		"August 2026",
	);
	expect(shownTitles()).toEqual(["P1-2608", "P2-2608"]);
});

test("choosing All months loads every month once and shows every day, and choosing a month narrows to it", async () => {
	const site = siteOf([
		{ date: TODAY, entries: papers(2) },
		{ date: "2026-08-20", entries: papers(2, "2608") },
	]);
	await owner(site);
	expect(document.querySelector("#month-button")?.textContent).toBe(
		"September 2026",
	);
	expect(
		document
			.querySelector('details[data-date="2026-08-20"]')
			?.classList.contains("month-hidden"),
	).toBe(true);
	document.querySelector<HTMLButtonElement>(".month-all")?.click();
	await vi.waitFor(() =>
		expect(
			document.querySelector('details[data-date="2026-08-20"] article'),
		).not.toBeNull(),
	);
	expect(
		document.querySelector(".month-all")?.getAttribute("aria-pressed"),
	).toBe("true");
	expect(document.querySelector("#month-button")?.textContent).toBe(
		"All months",
	);
	expect(
		document
			.querySelector('details[data-date="2026-08-20"]')
			?.classList.contains("month-hidden"),
	).toBe(false);
	expect(
		site.requested.filter((path) => path === "data/months/2026-08.json"),
	).toHaveLength(1);
	document.querySelector<HTMLElement>("#month-option-2026-09")?.click();
	await settle();
	expect(
		document
			.querySelector('details[data-date="2026-08-20"]')
			?.classList.contains("month-hidden"),
	).toBe(true);
	expect(
		document.querySelector("section.day")?.classList.contains("month-hidden"),
	).toBe(false);
});

test("choosing an older month in the selector loads it and opens its days", async () => {
	const site = siteOf([
		{ date: TODAY, entries: papers(2) },
		{ date: "2026-08-20", entries: papers(2, "2608") },
	]);
	await owner(site);
	document.querySelector<HTMLButtonElement>("#month-button")?.click();
	document.querySelector<HTMLElement>("#month-option-2026-08")?.click();
	await vi.waitFor(() =>
		expect(
			document.querySelector('details[data-date="2026-08-20"] article'),
		).not.toBeNull(),
	);
	expect(
		document
			.querySelector('details[data-date="2026-08-20"]')
			?.classList.contains("month-hidden"),
	).toBe(false);
	expect(
		document.querySelector("section.day")?.classList.contains("month-hidden"),
	).toBe(true);
	expect(
		document.querySelector(".month-all")?.getAttribute("aria-pressed"),
	).toBe("false");
	expect(document.querySelector("#month-button")?.textContent).toBe(
		"August 2026",
	);
});

// ---- Comments and links ----

const CREATED = "2026-09-27T16:20:00.000Z";

test("an address in the owner's comment is a link to that address, and the comment's text is unchanged", async () => {
	const entry = paperEntry("2609.00001", "P1", {
		abstract: "Some abstract words.",
	});
	const site = siteOf([{ date: TODAY, entries: [entry] }]);
	await owner(site, {
		comments: {
			"arxiv:2609.00001": [
				{
					id: "t1",
					field: "abstract",
					passage: "abstract words",
					occurrence: 1,
					comments: [
						{
							id: "c1",
							text: "compare https://example.com/other.",
							created: CREATED,
							edited: null,
						},
					],
				},
			],
		},
	});
	const text = document.querySelector(".comment__text");
	expect(text?.textContent).toBe("compare https://example.com/other.");
	expect(
		[...(text?.querySelectorAll("a") ?? [])].map((link) => [
			link.getAttribute("href"),
			link.textContent,
		]),
	).toEqual([["https://example.com/other", "https://example.com/other"]]);
});

test("a comment on part of a link keeps the link whole, and its highlight is drawn again after a reload", async () => {
	const entry = paperEntry("2609.00001", "P1", {
		abstract: "Code at https://github.com/example/repo now",
	});
	const site = siteOf([{ date: TODAY, entries: [entry] }]);
	const comments = {
		"arxiv:2609.00001": [
			{
				id: "t1",
				field: "abstract",
				passage: "at https://github",
				occurrence: 1,
				comments: [
					{ id: "c1", text: "which org?", created: CREATED, edited: null },
				],
			},
		],
	};
	await owner(site, { comments: comments });
	const abstract = () => document.querySelector(".entry__abstract");
	const highlighted = () =>
		[...(abstract()?.querySelectorAll("mark.comment-mark") ?? [])]
			.map((mark) => mark.textContent)
			.join("");
	expect(highlighted()).toBe("at https://github");
	expect(abstract()?.querySelectorAll("a[href]")).toHaveLength(1);
	expect(abstract()?.textContent).toBe(
		"Code at https://github.com/example/repo now",
	);
	releasePage();
	document.body.replaceChildren();
	await owner(site, { comments: comments });
	expect(highlighted()).toBe("at https://github");
});

// ---- The sidebar's controls ----

test("the Ad hoc chip counts ad hoc entries, has the same icon as the contents list, and combines with a read chip", async () => {
	const entries = [
		paperEntry("2609.00001", "P1", { ad_hoc: true }),
		paperEntry("2609.00002", "P2", { ad_hoc: true }),
		paperEntry("2609.00003", "P3"),
	];
	const site = siteOf([{ date: TODAY, entries: entries }]);
	await owner(site, {
		read: { "arxiv:2609.00002": { depth: "abstract", date: TODAY } },
	});
	const adHoc = chip("Ad hoc");
	expect(adHoc.getAttribute("aria-label")).toBe("Ad hoc (2)");
	expect(adHoc.querySelector("svg")?.getAttribute("data-icon")).toBe(
		document
			.querySelector(".contents__tag--icon svg")
			?.getAttribute("data-icon"),
	);
	adHoc.click();
	expect(shownTitles()).toEqual(["P1", "P2"]);
	chip("Unread").click();
	expect(shownTitles()).toEqual(["P1"]);
});

test("a chip says whether it is on, and a click with the mouse hides its label until the pointer leaves", async () => {
	const site = siteOf([{ date: TODAY, entries: papers(2) }]);
	await owner(site);
	const unread = chip("Unread");
	expect(unread.getAttribute("aria-pressed")).toBe("false");
	unread.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
	expect(unread.getAttribute("aria-pressed")).toBe("true");
	expect(unread.classList.contains("chip--clicked")).toBe(true);
	unread.dispatchEvent(new MouseEvent("mouseleave"));
	expect(unread.classList.contains("chip--clicked")).toBe(false);
	unread.click();
	expect(unread.classList.contains("chip--clicked")).toBe(false);
});

// ---- The heatmap's caption and the month a link names ----

test("a heatmap square's caption shows on hover and hides with Escape, and a focused square keeps focus when the heatmap redraws", async () => {
	const site = siteOf([{ date: TODAY, entries: papers(2) }]);
	await owner(site);
	const caption = () => document.querySelector<HTMLElement>("#heatmap-caption");
	square(TODAY).dispatchEvent(new MouseEvent("mouseenter"));
	expect(caption()?.hidden).toBe(false);
	expect(caption()?.textContent).toBe("Sun 27 Sep · 0 of 2 papers read");
	expect(square(TODAY).getAttribute("aria-describedby")).toBe(
		"heatmap-caption",
	);
	document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
	expect(caption()?.hidden).toBe(true);
	expect(square(TODAY).hasAttribute("aria-describedby")).toBe(false);
	square(TODAY).focus();
	control("arxiv:2609.00001", "Abstract").click();
	expect(document.activeElement?.getAttribute("data-date")).toBe(TODAY);
	expect(document.activeElement).toBe(square(TODAY));
});

test("a link to the newest day's entry selects the newest month again after another month was chosen", async () => {
	const site = siteOf([
		{ date: TODAY, entries: papers(2) },
		{ date: "2026-08-20", entries: papers(2, "2608") },
	]);
	await owner(site);
	square("2026-08-20").click();
	await vi.waitFor(() =>
		expect(document.querySelector("#month-button")?.textContent).toBe(
			"August 2026",
		),
	);
	await vi.waitFor(() => expect(shownTitles()).toEqual(["P1-2608", "P2-2608"]));
	location.hash = "#arxiv:2609.00001";
	await vi.waitFor(() =>
		expect(document.querySelector("#month-button")?.textContent).toBe(
			"September 2026",
		),
	);
	expect(shownTitles()).toContain("P1");
});

// ---- A crown under a week ----

// Every day from `from` to `to` of September 2026 has 2 papers, the first of them read "abstract", except `unread`.
async function weekOfReads(from: number, to: number, unread: number[] = []) {
	const lines = [];
	const read: Record<string, unknown> = {};
	for (let day = from; day <= to; day++) {
		const date = `2026-09-${String(day).padStart(2, "0")}`;
		const two = papers(2, `26${String(day).padStart(2, "0")}`);
		lines.push({ date: date, entries: two });
		const first = two[0];
		if (first !== undefined && !unread.includes(day))
			read[first.id] = { depth: "abstract", date: date };
	}
	await owner(siteOf(lines), { read: read });
}
const weekCrowns = () =>
	[...document.querySelectorAll<HTMLElement>(".heatmap__week-crown")].map(
		(crown) => crown.dataset.week,
	);

test("a week with a paper read on every one of its 7 days is crowned under its column", async () => {
	await weekOfReads(14, 27);
	expect(weekCrowns()).toEqual(["2026-09-14", "2026-09-21"]);
});

test("an entry with a malformed date is left out, and the page still shows the contents sidebar and the heatmap", async () => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
	const site = siteOf([
		{
			date: TODAY,
			entries: [
				...papers(3),
				newsEntry("bad", "Bad", { published: "2026-10-03T19:27:17Z" }),
			],
		},
	]);
	await owner(site);
	expect(
		document.getElementById("page")?.classList.contains("page--with-contents"),
	).toBe(true);
	expect(document.querySelector("#contents .contents__box")).not.toBeNull();
	expect(document.querySelectorAll("#heatmap .heatmap__day").length).toBe(84);
});

test("today's square is an outline until a digest for today exists, and each column is labelled with its Monday", async () => {
	const site = siteOf([{ date: "2026-09-26", entries: papers(2) }]);
	await owner(site);
	expect(level(TODAY)).toBe("no-digest");
	expect(square(TODAY).tagName).toBe("SPAN");
	const weeks = texts(".heatmap__week");
	expect(weeks).toHaveLength(12);
	expect(weeks[0]).toBe("6 Jul");
	expect(weeks[11]).toBe("21 Sep");
});
