// Unit tests for the pure functions in site/page/.
// Run the process in a zone far from Jakarta so date logic that leans on the machine's zone fails.
process.env.TZ = "America/Los_Angeles";

import assert from "node:assert/strict";
import { test } from "vitest";
import type { JsonObject } from "../../shared/narrow.ts";
import type { Depth } from "../../shared/owner-protocol.ts";
import { checkDigests } from "../../site/page/check.ts";
import {
	commentTime,
	deleteQuestion,
	findPassage,
	occurrenceOf,
	readingLine,
	removeComment,
	stackTops,
	usableThreads,
} from "../../site/page/comments.ts";
import {
	dayCrowned,
	dayLabel,
	headerDay,
	heatLevel,
	heatmapDays,
	heatTitle,
	jakartaToday,
	mergeDays,
	paperProgress,
	shortDayLabel,
	weekCrowned,
} from "../../site/page/days.ts";
import { unreadToday } from "../../site/page/notifications.ts";
import {
	clearTag,
	matchesRead,
	matchesTags,
	readChipCounts,
	readCounts,
	tagCounts,
	takeawaysOf,
	toggleRead,
	toggleTag,
} from "../../site/page/state.ts";
import {
	contentsGroups,
	discussLink,
	discussText,
	entryGroup,
	escapePercent,
	linkPieces,
	proseNodes,
	referenceText,
	shownId,
	type TextPiece,
	texLinkPieces,
} from "../../site/page/text.ts";
import type {
	ContentsGroup,
	Day,
	Entry,
	ReadState,
	Skipped,
	Tags,
	Thread,
} from "../../site/page/types.ts";

// [entry id, depth, date]: one read mark, as readState() takes it.
type ReadTriple = [string, Depth, string];

const TODAY = "2026-09-27";

// Minimal entries: only the fields the pure functions read.
const paper = (n: number): Entry => ({
	id: `arxiv:2601.${String(n).padStart(5, "0")}`,
	type: "paper",
	title: `Paper ${n}`,
});
const news = (n: number): Entry => ({
	id: `news:fixture-${n}`,
	type: "news",
	title: `News ${n}`,
});
const article = (n: number): Entry => ({
	id: `url:https://example.com/articles/${n}`,
	type: "article",
	title: `Article ${n}`,
});
const report = (n: number): Entry => ({
	id: `url:https://example.com/reports/${n}`,
	type: "report",
	title: `Report ${n}`,
});
const papers = (from: number, count: number) =>
	Array.from({ length: count }, (_, i) => paper(from + i));
const ids = (entries: Entry[]) => entries.map((entry) => entry.id);

// A value with every object in it rebuilt as a plain object from its own keys, in order. The page builds its read
// state and tags maps without a prototype (Object.create(null)), and node:assert/strict's deepEqual tells those
// apart from object literals; compared through this, only the keys and values count.
function plain(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(plain);
	}
	if (typeof value !== "object" || value === null) {
		return value;
	}
	const copy: Record<string, unknown> = {};
	for (const [key, inner] of Object.entries(value)) {
		copy[key] = plain(inner);
	}
	return copy;
}

// The item at `index`; the test fails here when the list is shorter.
function itemAt<T>(list: T[], index: number): T {
	const item = list[index];
	assert.ok(item !== undefined, `an item at index ${index}`);
	return item;
}

test('Today is the date in Jakarta, days come newest first, and a day reads like "Sunday 27 September"', () => {
	// "Today" is the date in Asia/Jakarta (UTC+7), whatever the machine's zone.
	assert.equal(jakartaToday(new Date("2026-09-26T17:30:00Z")), "2026-09-27");
	assert.equal(jakartaToday(new Date("2026-09-27T16:59:59Z")), "2026-09-27");
	assert.equal(jakartaToday(new Date("2026-09-27T17:00:00Z")), "2026-09-28");

	// Days come back newest first, whatever order the lines were appended in.
	const days = mergeDays([
		{ date: "2026-09-24", entries: papers(20, 2) },
		{ date: TODAY, entries: papers(1, 2) },
		{ date: "2026-09-26", entries: papers(10, 3) },
	]);
	assert.deepEqual(
		days.map((d) => d.date),
		[TODAY, "2026-09-26", "2026-09-24"],
	);
	assert.deepEqual(
		days.map((d) => d.entries.length),
		[2, 3, 2],
	);

	// Each day's label is "<weekday> <day> <month>".
	assert.equal(dayLabel(TODAY), "Sunday 27 September");
	assert.equal(dayLabel("2026-09-26"), "Saturday 26 September");
	assert.equal(dayLabel("2026-09-24"), "Thursday 24 September");
});

test("Several lines with one date show as one day", () => {
	const fivePapers = papers(1, 5);
	const oneNews = [news(1)];

	const days = mergeDays([
		{ date: "2026-09-26", entries: papers(50, 2) },
		{ date: TODAY, entries: fivePapers },
		{ date: TODAY, entries: oneNews },
	]);

	assert.deepEqual(
		days.map((d) => d.date),
		[TODAY, "2026-09-26"],
	);
	assert.deepEqual(
		itemAt(days, 0).entries.map((e) => e.id),
		[...fivePapers, ...oneNews].map((e) => e.id),
	);
});

test("With no digests there are no days and the header names no day", () => {
	const days = mergeDays([]);
	assert.deepEqual(days, []);
	assert.equal(headerDay(days, TODAY), null);
});

test("The header names the newest digest's day", () => {
	const newestToday = mergeDays([
		{ date: "2026-09-25", entries: papers(30, 2) },
		{ date: TODAY, entries: papers(1, 7) },
	]);
	assert.deepEqual(headerDay(newestToday, TODAY), {
		day: "Sunday 27 September",
		warning: null,
	});

	// A digest from yesterday is named by its own day, without a warning.
	const newestYesterday = mergeDays([
		{ date: "2026-09-26", entries: papers(1, 3) },
	]);
	assert.deepEqual(headerDay(newestYesterday, TODAY), {
		day: "Saturday 26 September",
		warning: null,
	});
});

test('When the newest digest is 2 or more days old, the header says "No new digest for N days"', () => {
	const twoDaysOld = mergeDays([{ date: "2026-09-25", entries: papers(1, 4) }]);
	assert.deepEqual(headerDay(twoDaysOld, TODAY), {
		day: "Friday 25 September",
		warning: "No new digest for 2 days",
	});

	// Whole days are counted across a month boundary.
	const acrossMonths = mergeDays([
		{ date: "2026-08-30", entries: papers(1, 1) },
	]);
	assert.deepEqual(headerDay(acrossMonths, "2026-09-02"), {
		day: "Sunday 30 August",
		warning: "No new digest for 3 days",
	});
});

test("The progress line counts the papers read at depth abstract or paper", () => {
	// The scenario: 6 papers and 2 news items, the 1st and 3rd papers read "abstract", the 2nd "paper".
	const day = [...papers(1, 6), news(1), news(2)];
	const state = readState([
		[paper(1).id, "abstract", TODAY],
		[paper(2).id, "paper", TODAY],
		[paper(3).id, "abstract", TODAY],
	]);
	assert.deepEqual(paperProgress(day, state), {
		read: 3,
		total: 6,
		text: "3 of 6 papers read",
	});

	// A read mark on a news item, an article or a report counts nowhere.
	const marked = readState([
		[paper(1).id, "paper", TODAY],
		[news(1).id, "read", TODAY],
		[article(1).id, "read", TODAY],
	]);
	assert.deepEqual(
		paperProgress([paper(1), paper(2), news(1), article(1)], marked),
		{
			read: 1,
			total: 2,
			text: "1 of 2 papers read",
		},
	);

	// One paper reads in the singular; a day with no paper has none to count.
	assert.equal(paperProgress([paper(1)], {}).text, "0 of 1 paper read");
	assert.deepEqual(paperProgress([news(1)], {}), {
		read: 0,
		total: 0,
		text: "0 of 0 papers read",
	});
});

test("An entry reference holds its title, its ID or DOI and its URL, separated by semicolons", () => {
	const entry = {
		id: "arxiv:2507.11473",
		type: "paper",
		title:
			"Chain of Thought Monitorability: A New and Fragile Opportunity for AI Safety",
		url: "https://arxiv.org/abs/2507.11473",
	};
	assert.equal(
		referenceText(entry),
		"Chain of Thought Monitorability: A New and Fragile Opportunity for AI Safety; " +
			"ID/DOI: arxiv:2507.11473; URL: https://arxiv.org/abs/2507.11473",
	);
});

test("A news item's meta line shows its site, not its whole address", () => {
	assert.equal(
		shownId("url:https://openai.com/index/building-scientific-understanding"),
		"openai.com",
	);
	// The site without its "www.", the way it is read out.
	assert.equal(
		shownId("url:https://www.anthropic.com/news/claude"),
		"anthropic.com",
	);
	// An address that doesn't parse shows whole, as before.
	assert.equal(shownId("url:not an address"), "url:not an address");
});

test("The meta line shows an arXiv id or a DOI whole", () => {
	assert.equal(shownId("arxiv:2507.11473"), "arxiv:2507.11473");
	assert.equal(
		shownId("doi:10.56553/popets-2026-0001"),
		"doi:10.56553/popets-2026-0001",
	);
});

// An entry of the given kind, from a page at `host`.
const from = (entry: Entry, host: string): Entry => ({
	...entry,
	url: `https://${host}/${entry.id}`,
});

test('The contents group entries under Papers, From the labs, LessWrong and News, and label older days like "Sat 26 Sep"', () => {
	// Entries in the order they were appended, types mixed: papers, then the labs' pages, then the rest, each in the
	// order added.
	const groups = contentsGroups([
		paper(2),
		from(news(1), "techcrunch.com"),
		from(article(1), "www.anthropic.com"),
		paper(1),
		from(article(2), "www.lesswrong.com"),
	]);
	assert.deepEqual(
		groups.map((group) => group.label),
		["Papers", "From the labs", "LessWrong", "News"],
	);
	assert.deepEqual(ids(itemAt(groups, 0).entries), ids([paper(2), paper(1)]));
	assert.deepEqual(ids(itemAt(groups, 1).entries), ids([article(1)]));
	assert.deepEqual(ids(itemAt(groups, 2).entries), ids([article(2)]));
	assert.deepEqual(ids(itemAt(groups, 3).entries), ids([news(1)]));

	// Older days' rows: three-letter weekday and month ("Sep", not "Sept"), in Jakarta's calendar
	// whatever the machine's zone (this file runs in Los Angeles).
	assert.equal(shortDayLabel("2026-09-26"), "Sat 26 Sep");
	assert.equal(shortDayLabel("2026-09-24"), "Thu 24 Sep");
});

test('The contents leave out a group with no entries, such as "Papers" on a day without papers', () => {
	const onlyPapers = contentsGroups(papers(1, 3));
	assert.deepEqual(
		onlyPapers.map((group) => group.label),
		["Papers"],
	);
	assert.deepEqual(ids(itemAt(onlyPapers, 0).entries), ids(papers(1, 3)));

	// The same rule the other way round: a day without papers has no "Papers" group.
	const noPapers = contentsGroups([news(1), article(1)]);
	assert.deepEqual(
		noPapers.map((group) => group.label),
		["News"],
	);
	assert.deepEqual(
		ids(itemAt(noPapers, 0).entries),
		ids([news(1), article(1)]),
	);
});

// The page lists a day's entries group by group, as the contents do: the groups' entries one after the other.
const contentsOrder = (groups: ContentsGroup[]) =>
	groups.flatMap((group) => group.entries);

test("The page lists papers first, then the other entries, each in the order added", () => {
	// Added as an article, a paper, a news item and a paper: papers first in the order added, then the rest in the order added.
	const groups = contentsGroups([article(1), paper(1), news(1), paper(2)]);
	assert.deepEqual(
		ids(contentsOrder(groups)),
		ids([paper(1), paper(2), article(1), news(1)]),
	);
});

test("A news item added before two papers is listed after them", () => {
	const groups = contentsGroups([news(1), paper(1), paper(2)]);
	assert.deepEqual(
		ids(contentsOrder(groups)),
		ids([paper(1), paper(2), news(1)]),
	);
});

// readingLine(windowHeight, scrollRange, scrollY, lastTitleTop) gives the reading line in px from the top of the
// window. Equal to within a millionth of a pixel: the same formula written in another order can round differently.
function assertPx(actual: number, expected: number) {
	assert.ok(
		Math.abs(actual - expected) < 1e-6,
		`${actual} px, expected ${expected} px`,
	);
}

test("The mark moves when the next title passes 35% of the window height", () => {
	// Far from the bottom of the page, the line is at 35% of the window height.
	assertPx(readingLine(800, 3000, 0, 3500), 280);
	assertPx(readingLine(900, 3000, 0, 3500), 315);

	// A last title that can scroll up past the line leaves it at 35%, all the way to the bottom of the page.
	assertPx(readingLine(800, 3000, 2900, 300), 280);
	assertPx(readingLine(800, 3000, 3000, 200), 280);

	// A page that doesn't scroll keeps the line at 35%.
	assertPx(readingLine(800, 0, 0, 600), 280);
});

test("Every entry gets marked current on the way to the end of the page", () => {
	// A page with 3000 px to scroll in an 800 px window, whose last title ends up 500 px from the top: 220 px below the
	// 280 px line. The line slides down over the last 220 px of scrolling and meets the last title at the bottom.
	assertPx(readingLine(800, 3000, 2780, 720), 280); // where the slide starts
	assertPx(readingLine(800, 3000, 2890, 610), 390); // halfway through it: halfway to the last title
	assertPx(readingLine(800, 3000, 3000, 500), 500); // at the bottom: at the last title

	// A page with only 100 px to scroll, less than the same 220 px shortfall, slides over all of its scrolling.
	assertPx(readingLine(800, 100, 0, 600), 280);
	assertPx(readingLine(800, 100, 50, 550), 390);
	assertPx(readingLine(800, 100, 100, 500), 500);
});

// ---- read state ----

// Read state as the page stores it, { id: { depth, date } }, from [id, depth, date] triples.
function readState(triples: ReadTriple[]) {
	const state: ReadState = {};
	for (const triple of triples)
		state[triple[0]] = { depth: triple[1], date: triple[2] };
	return state;
}

// Check each date is the day after the one before it, counted in UTC so no zone's clock changes can hide a gap.
function assertConsecutive(days: string[]) {
	for (let i = 1; i < days.length; i++) {
		const gap =
			Date.parse(`${days[i]}T00:00:00Z`) -
			Date.parse(`${days[i - 1]}T00:00:00Z`);
		assert.equal(
			gap,
			24 * 60 * 60 * 1000,
			`${days[i - 1]} is followed by ${days[i]}`,
		);
	}
}

test("Pressing Paper saves the read depth under the entry's id with today's date", () => {
	const state: ReadState = {};
	assert.equal(
		toggleRead(state, "arxiv:2601.00001", "paper", TODAY),
		undefined,
	);
	assert.deepEqual(state, readState([["arxiv:2601.00001", "paper", TODAY]]));
});

test("Abstract and Paper exclude each other", () => {
	const state = readState([
		["arxiv:2601.00001", "abstract", "2026-09-20"],
		["arxiv:2601.00002", "paper", "2026-09-20"],
	]);

	// Switching from Abstract to Paper replaces the depth and the date; the other entry is untouched.
	toggleRead(state, "arxiv:2601.00001", "paper", TODAY);
	assert.deepEqual(
		state,
		readState([
			["arxiv:2601.00001", "paper", TODAY],
			["arxiv:2601.00002", "paper", "2026-09-20"],
		]),
	);

	// And back again.
	toggleRead(state, "arxiv:2601.00001", "abstract", TODAY);
	assert.deepEqual(state["arxiv:2601.00001"], {
		depth: "abstract",
		date: TODAY,
	});
});

test("Pressing Abstract or Paper again clears the read state, even on a later day", () => {
	const other: ReadTriple = [
		"url:https://example.com/articles/1",
		"read",
		"2026-09-20",
	];
	const depths: Depth[] = ["abstract", "paper"];

	// Each depth, pressed twice, leaves no read state for the paper and the other entry as it was.
	for (const depth of depths) {
		const state = readState([other]);
		toggleRead(state, paper(1).id, depth, TODAY);
		toggleRead(state, paper(1).id, depth, TODAY);
		assert.deepEqual(state, readState([other]), depth);
	}

	// A press on a different day clears it too: only the depth decides.
	const state = readState([["arxiv:2601.00001", "abstract", "2026-09-20"]]);
	toggleRead(state, "arxiv:2601.00001", "abstract", TODAY);
	assert.deepEqual(state, {});
});

test("Read state for an entry no longer in the digests is kept", () => {
	const gone: ReadTriple = ["arxiv:2601.99999", "abstract", "2026-08-01"];

	const state = readState([gone]);

	// A press on today's paper leaves it as it was.
	toggleRead(state, paper(1).id, "abstract", TODAY);
	assert.deepEqual(
		plain(state),
		readState([gone, [paper(1).id, "abstract", TODAY]]),
	);

	// It counts for no day that doesn't list it.
	assert.deepEqual(readCounts([paper(1)], state), {
		items: 1,
		total: 1,
		read: 1,
		abstracts: 1,
		papers: 0,
	});
});

test("A day's read counts include only the papers it lists, so news, articles, reports and other days' papers count nowhere", () => {
	// The scenario: 2 papers and 2 news items, the 1st paper read as "paper".
	const scenarioDay = [paper(1), paper(2), news(1), news(2)];
	const scenarioState = readState([[paper(1).id, "paper", TODAY]]);
	const counts = readCounts(scenarioDay, scenarioState);
	assert.deepEqual(counts, {
		items: 4,
		total: 2,
		read: 1,
		abstracts: 0,
		papers: 1,
	});
	assert.equal(heatLevel(counts.read, counts.total), "some");

	// Read marks on news, articles and reports (depth "read") count nowhere, and so does state for an id the day
	// doesn't list.
	const day = [paper(1), paper(2), paper(3), news(1), article(1), report(1)];
	const state = readState([
		[paper(1).id, "abstract", TODAY],
		[paper(2).id, "paper", TODAY],
		[news(1).id, "read", TODAY],
		[article(1).id, "read", TODAY],
		[report(1).id, "read", TODAY],
		["arxiv:2601.99999", "abstract", TODAY],
	]);
	assert.deepEqual(readCounts(day, state), {
		items: 6,
		total: 3,
		read: 2,
		abstracts: 1,
		papers: 1,
	});

	// A day of news alone has no papers to read.
	assert.deepEqual(readCounts([news(1)], state), {
		items: 1,
		total: 0,
		read: 0,
		abstracts: 0,
		papers: 0,
	});
});

test('A heatmap square is shaded by the share of papers read, and half or less counts as "some"', () => {
	// The scenario's rows.
	assert.equal(heatLevel(0, 4), "none");
	assert.equal(heatLevel(1, 4), "some");
	assert.equal(heatLevel(2, 4), "some");
	assert.equal(heatLevel(3, 4), "most");
	assert.equal(heatLevel(4, 4), "all");

	// The edges: half or less is "some", more than half but not all is "most".
	assert.equal(heatLevel(0, 10), "none");
	assert.equal(heatLevel(1, 10), "some");
	assert.equal(heatLevel(5, 10), "some");
	assert.equal(heatLevel(6, 10), "most");
	assert.equal(heatLevel(9, 10), "most");
	assert.equal(heatLevel(10, 10), "all");
	assert.equal(heatLevel(1, 2), "some");
	assert.equal(heatLevel(2, 3), "most");
});

test('A day without a digest gets the "no-digest" shade on the heatmap', () => {
	const state = readState([[paper(1).id, "paper", TODAY]]);
	const counts = readCounts([], state);
	assert.deepEqual(counts, {
		items: 0,
		total: 0,
		read: 0,
		abstracts: 0,
		papers: 0,
	});
	assert.equal(heatLevel(counts.read, counts.total), "no-digest");
});

test("On a Thursday the heatmap starts on a Friday, 12 weeks back", () => {
	const days = heatmapDays("2026-10-01");
	assert.equal(days.length, 84);
	assert.equal(days[0], "2026-07-10");
	assert.equal(days[83], "2026-10-01");
	assertConsecutive(days);
});

test("On a Sunday the heatmap is 12 full weeks, also across a year end and a daylight saving change", () => {
	const days = heatmapDays(TODAY);
	assert.equal(days.length, 84);
	assert.equal(days[0], "2026-07-06");
	assert.equal(days[83], TODAY);
	assertConsecutive(days);

	// Another Sunday, across a year end and the end of daylight saving time in Los Angeles (1 November 2026).
	const acrossYearEnd = heatmapDays("2027-01-03");
	assert.equal(acrossYearEnd.length, 84);
	assert.equal(acrossYearEnd[0], "2026-10-12");
	assert.equal(acrossYearEnd[83], "2027-01-03");
	assertConsecutive(acrossYearEnd);
});

test("A heatmap square's tooltip says the date and how many papers were read at each depth", () => {
	// The scenario: 3 papers and 2 news items today, 2 papers read; Saturday has only news items.
	const today = [paper(1), paper(2), paper(3), news(1), news(2)];
	const state = readState([
		[paper(1).id, "abstract", TODAY],
		[paper(2).id, "paper", TODAY],
		[news(1).id, "read", TODAY],
	]);
	assert.equal(
		heatTitle(TODAY, readCounts(today, state)),
		"Sun 27 Sep · 2 of 3 papers read · 1 abstract, 1 paper",
	);
	assert.equal(
		heatTitle("2026-09-26", readCounts([news(3), news(4)], state)),
		"Sat 26 Sep · no papers",
	);
	assert.equal(
		heatTitle("2026-09-25", readCounts([], state)),
		"Fri 25 Sep · no digest",
	);
	assert.equal(
		heatTitle("2026-09-24", readCounts([paper(5)], state)),
		"Thu 24 Sep · 0 of 1 paper read",
	);

	// Plurals, and parts with a count of 0 left out, the rest kept in order.
	assert.equal(
		heatTitle(TODAY, {
			items: 12,
			total: 9,
			read: 4,
			abstracts: 2,
			papers: 2,
		}),
		"Sun 27 Sep · 4 of 9 papers read · 2 abstracts, 2 papers",
	);
	assert.equal(
		heatTitle(TODAY, { items: 5, total: 5, read: 3, abstracts: 3, papers: 0 }),
		"Sun 27 Sep · 3 of 5 papers read · 3 abstracts",
	);
	assert.equal(
		heatTitle(TODAY, { items: 4, total: 4, read: 2, abstracts: 0, papers: 2 }),
		"Sun 27 Sep · 2 of 4 papers read · 2 papers",
	);
});

test("The heatmap ends on Jakarta's date wherever the computer is", () => {
	// 03:00 on 1 October in Jakarta is 30 September in Los Angeles, where this file runs.
	const today = jakartaToday(new Date("2026-10-01T03:00:00+07:00"));
	const days = heatmapDays(today);
	assert.equal(days[83], "2026-10-01");
	assert.equal(
		heatTitle(days[83], readCounts([], {})),
		"Thu 1 Oct · no digest",
	);
});

// ---- Discuss ----

const DISCUSS_PREFIX = "https://claude.ai/new?q=";

test("Discuss links to a new claude.ai chat holding the entry reference", () => {
	const entry = {
		id: "arxiv:2507.11473",
		type: "paper",
		title:
			"Chain of Thought Monitorability: A New and Fragile Opportunity for AI Safety",
		url: "https://arxiv.org/abs/2507.11473",
	};
	assert.ok(
		discussLink(entry).startsWith(
			"https://claude.ai/new?q=Chain%20of%20Thought%20Monitorability%3A%20A%20New%20and%20Fragile%20Opportunity%20for%20AI%20Safety" +
				"%3B%20ID%2FDOI%3A%20arxiv%3A2507.11473%3B%20URL%3A%20https%3A%2F%2Farxiv.org%2Fabs%2F2507.11473%0A%0A",
		),
		discussLink(entry),
	);
	// The query decodes back to Discuss's text, whole: the Copy text, a blank line, the prompt.
	assert.equal(
		decodeURIComponent(discussLink(entry).slice(DISCUSS_PREFIX.length)),
		discussText(entry),
	);
	assert.ok(discussText(entry).startsWith(`${referenceText(entry)}\n\n`));
});

test('"&", "#", "%" and "?" in a title or address survive the Discuss link', () => {
	const url = "https://example.com/a?b=1&c=2#x";
	const entry = {
		id: `url:${url}`,
		type: "news",
		title: "Q&A #3: 50% off?",
		url: url,
	};
	assert.ok(
		discussLink(entry).startsWith(
			"https://claude.ai/new?q=Q%26A%20%233%3A%2050%25%20off%3F%3B%20ID%2FDOI%3A%20url%3Ahttps%3A%2F%2Fexample.com%2Fa%3Fb%3D1%26c%3D2%23x" +
				"%3B%20URL%3A%20https%3A%2F%2Fexample.com%2Fa%3Fb%3D1%26c%3D2%23x%0A%0A",
		),
		discussLink(entry),
	);
	assert.equal(
		decodeURIComponent(discussLink(entry).slice(DISCUSS_PREFIX.length)),
		discussText(entry),
	);
});

// ---- comments ----

// The feature's "now": 23:20 on Sunday 27 September 2026 in Jakarta.
const COMMENTS_NOW = new Date("2026-09-27T23:20:00+07:00");

// A thread as the page stores it, with comments made from [id, text] pairs.
function thread(
	id: string,
	field: "title" | "abstract" | null,
	passage: string | null,
	occurrence: number | null,
	pairs: [string, string][],
): Thread {
	const comments = pairs.map((pair) => ({
		id: pair[0],
		text: pair[1],
		created: "2026-09-27T16:20:00.000Z",
		edited: null,
	}));
	// The callers pass a field with its passage and occurrence, or null with nulls: one of Thread's two shapes each
	// time, a pairing tsc can't follow through separate parameters.
	return {
		id: id,
		field: field,
		passage: passage,
		occurrence: occurrence,
		comments: comments,
	} as Thread;
}

test("A comment's time is shown in the computer's time zone, as day, short month and 24-hour time", () => {
	const created = "2026-09-27T16:20:00.000Z";

	assert.equal(
		commentTime(created, COMMENTS_NOW, "Asia/Jakarta"),
		"27 Sep, 23:20",
	);
	// Hours are zero-padded.
	assert.equal(
		commentTime(created, COMMENTS_NOW, "America/Los_Angeles"),
		"27 Sep, 09:20",
	);
	// Without a zone, the computer's own: this file runs in Los Angeles.
	assert.equal(commentTime(created, COMMENTS_NOW), "27 Sep, 09:20");

	// The day is not padded, the month is three letters ("Sep", not "Sept"), and just after midnight is 00, not 24.
	assert.equal(
		commentTime("2026-09-05T02:00:00.000Z", COMMENTS_NOW, "Asia/Jakarta"),
		"5 Sep, 09:00",
	);
	assert.equal(
		commentTime("2026-09-27T17:05:00.000Z", COMMENTS_NOW, "Asia/Jakarta"),
		"28 Sep, 00:05",
	);
	assert.equal(
		commentTime("2026-06-01T03:00:00.000Z", COMMENTS_NOW, "Asia/Jakarta"),
		"1 Jun, 10:00",
	);
});

test("A comment from another year shows its year", () => {
	assert.equal(
		commentTime("2025-12-31T15:00:00.000Z", COMMENTS_NOW, "Asia/Jakarta"),
		"31 Dec 2025, 22:00",
	);

	// The year is the one in the zone shown: 17:30 UTC on 31 December 2025 is already 2026 in Jakarta, not in Los Angeles.
	assert.equal(
		commentTime("2025-12-31T17:30:00.000Z", COMMENTS_NOW, "Asia/Jakarta"),
		"1 Jan, 00:30",
	);
	assert.equal(
		commentTime(
			"2025-12-31T17:30:00.000Z",
			COMMENTS_NOW,
			"America/Los_Angeles",
		),
		"31 Dec 2025, 09:30",
	);

	// And "this year" is now's year in that zone: at 03:00 on 1 January 2027 in Jakarta, a comment from 31 December 2026
	// shows its year.
	const newYear = new Date("2027-01-01T03:00:00+07:00");
	assert.equal(
		commentTime("2026-12-31T10:00:00.000Z", newYear, "Asia/Jakarta"),
		"31 Dec 2026, 17:00",
	);
	assert.equal(
		commentTime("2026-12-31T10:00:00.000Z", newYear, "America/Los_Angeles"),
		"31 Dec, 02:00",
	);
});

test("A comment on words that appear twice stays on the occurrence that was selected", () => {
	const abstract = "We probe the model. Then the model fails.";

	assert.equal(findPassage(abstract, "the model", 1), 9);
	assert.equal(findPassage(abstract, "the model", 2), 25);
	assert.equal(occurrenceOf(abstract, "the model", 9), 1);
	assert.equal(occurrenceOf(abstract, "the model", 25), 2);

	// Appearances may overlap: the search goes on one character after each match's start.
	assert.equal(findPassage("aaaa", "aa", 1), 0);
	assert.equal(findPassage("aaaa", "aa", 2), 1);
	assert.equal(findPassage("aaaa", "aa", 3), 2);
	assert.equal(occurrenceOf("aaaa", "aa", 2), 3);

	// The two agree for every appearance.
	const searches: [string, string][] = [
		[abstract, "the model"],
		["aaaa", "aa"],
		[abstract, "e"],
	];
	for (const [text, passage] of searches) {
		let at = text.indexOf(passage);
		while (at !== -1) {
			assert.equal(
				findPassage(text, passage, occurrenceOf(text, passage, at)),
				at,
				`${passage} at ${at}`,
			);
			at = text.indexOf(passage, at + 1);
		}
	}
});

test("A passage that is gone, or appears fewer times than its saved occurrence, is not found", () => {
	const abstract = "We probe the model. Then the model fails.";
	assert.equal(findPassage(abstract, "words that are gone", 1), -1);
	// Fewer appearances than the occurrence saved.
	assert.equal(findPassage(abstract, "the model", 3), -1);
	assert.equal(findPassage("aaaa", "aa", 4), -1);
});

test('Before a delete the page asks "Delete this comment and its 2 replies?" or "Delete this reply?"', () => {
	const oneComment = thread("t1", "abstract", "steering vectors fail", 1, [
		["c1", "A"],
	]);
	const oneReply = thread("t1", "abstract", "steering vectors fail", 1, [
		["c1", "A"],
		["c2", "B"],
	]);
	const twoReplies = thread("t1", "abstract", "steering vectors fail", 1, [
		["c1", "A"],
		["c2", "B"],
		["c3", "C"],
	]);

	assert.equal(deleteQuestion(oneComment, 0), "Delete this comment?");
	assert.equal(
		deleteQuestion(twoReplies, 0),
		"Delete this comment and its 2 replies?",
	);
	assert.equal(
		deleteQuestion(oneReply, 0),
		"Delete this comment and its 1 reply?",
	);
	assert.equal(deleteQuestion(twoReplies, 2), "Delete this reply?");
	assert.equal(deleteQuestion(twoReplies, 1), "Delete this reply?");
});

test("Deleting a reply keeps the rest of the thread", () => {
	const threads = [
		thread("t1", null, null, null, [
			["c1", "A"],
			["c2", "B"],
			["c3", "C"],
		]),
		thread("t2", "abstract", "steering vectors fail", 1, [["c4", "D"]]),
	];
	const before = JSON.parse(JSON.stringify(threads));

	const after = removeComment(threads, "t1", "c2");
	assert.deepEqual(after, [
		thread("t1", null, null, null, [
			["c1", "A"],
			["c3", "C"],
		]),
		thread("t2", "abstract", "steering vectors fail", 1, [["c4", "D"]]),
	]);
	// The list it was given is unchanged.
	assert.deepEqual(threads, before);
});

test("Deleting the first comment deletes its thread and highlight", () => {
	const threads = [
		thread("t1", "abstract", "steering vectors fail", 1, [
			["c1", "A"],
			["c2", "B"],
		]),
		thread("t2", null, null, null, [["c3", "C"]]),
	];
	const before = JSON.parse(JSON.stringify(threads));

	assert.deepEqual(removeComment(threads, "t1", "c1"), [
		thread("t2", null, null, null, [["c3", "C"]]),
	]);
	assert.deepEqual(threads, before);

	// The last thread gone leaves an empty list.
	assert.deepEqual(
		removeComment([thread("t1", null, null, null, [["c1", "A"]])], "t1", "c1"),
		[],
	);
});

test("Cards sit level with what they comment on", () => {
	// Cards that don't overlap keep the tops they want.
	assert.deepEqual(stackTops([0, 200], [50, 50], 8), [0, 200]);
	assert.deepEqual(stackTops([0, 58], [50, 50], 8), [0, 58]);
	assert.deepEqual(stackTops([], [], 8), []);
});

test("Cards that would overlap stack, in the order of their passages", () => {
	// Two cards wanting one line: the second starts 8 px below the first.
	assert.deepEqual(stackTops([100, 100], [60, 40], 8), [100, 168]);
	// A push carries on down, and stops where a card already sits low enough.
	assert.deepEqual(stackTops([10, 20, 300], [100, 100, 10], 8), [10, 118, 300]);
	assert.deepEqual(stackTops([10, 20, 200], [100, 100, 10], 8), [10, 118, 226]);
	// The gap is the one given.
	assert.deepEqual(stackTops([0, 0], [30, 30], 12), [0, 42]);
});

test("Six cards on one line stack one below the other, 8 px apart", () => {
	// Six cards on the title's line: each 70 px tall, 8 px apart.
	assert.deepEqual(
		stackTops([40, 40, 40, 40, 40, 40], [70, 70, 70, 70, 70, 70], 8),
		[40, 118, 196, 274, 352, 430],
	);
});

test("A malformed saved thread is dropped and the well-formed threads around it are kept in order", () => {
	const whole = thread("t1", null, null, null, [
		["c1", "Worth a reading group slot"],
	]);
	const onTitle = thread("t2", "title", "open weights", 1, [
		["c2", "A"],
		["c3", "B"],
	]);
	const onAbstract = thread("t3", "abstract", "the model", 2, [
		["c4", "Which model?"],
	]);
	// A thread with no field at all counts as one on the whole entry.
	const noField = {
		id: "t4",
		comments: [
			{
				id: "c5",
				text: "Kept",
				created: "2026-09-27T16:20:00.000Z",
				edited: null,
			},
		],
	};
	const good = [whole, onTitle, onAbstract, noField];

	// Good threads come back in their stored order, as the same objects.
	const usable = usableThreads(good);
	assert.deepEqual(usable, good);
	for (let i = 0; i < good.length; i++)
		assert.equal(usable[i], good[i], `thread ${i} is the stored object`);

	// Not a list of threads: nothing to draw. The scenario's "an object where the list of threads goes".
	for (const value of [
		{ id: "t1", comments: [] },
		null,
		undefined,
		"text",
		5,
	]) {
		assert.deepEqual(usableThreads(value), [], JSON.stringify(value));
	}

	// Each bad thread is dropped and the good ones around it are kept.
	const comment = {
		id: "c9",
		text: "Fine",
		created: "2026-09-27T16:20:00.000Z",
		edited: null,
	};
	const bad = {
		null: null,
		"a number": 5,
		"no id": {
			field: null,
			passage: null,
			occurrence: null,
			comments: [comment],
		},
		"a number id": {
			id: 7,
			field: null,
			passage: null,
			occurrence: null,
			comments: [comment],
		},
		// The scenario's "a thread without comments".
		"no comments": {
			id: "b1",
			field: null,
			passage: null,
			occurrence: null,
			comments: [],
		},
		"comments missing": {
			id: "b1",
			field: null,
			passage: null,
			occurrence: null,
		},
		"comments not a list": {
			id: "b1",
			field: null,
			passage: null,
			occurrence: null,
			comments: comment,
		},
		"a comment without an id": {
			id: "b1",
			field: null,
			passage: null,
			occurrence: null,
			comments: [{ text: "x", created: comment.created }],
		},
		"a comment without text": {
			id: "b1",
			field: null,
			passage: null,
			occurrence: null,
			comments: [{ id: "c", created: comment.created }],
		},
		// The scenario's "a comment without a created time".
		"a comment without a created time": {
			id: "b1",
			field: null,
			passage: null,
			occurrence: null,
			comments: [{ id: "c", text: "x" }],
		},
		"a created time that is not a time": {
			id: "b1",
			field: null,
			passage: null,
			occurrence: null,
			comments: [{ id: "c", text: "x", created: "yesterday-ish" }],
		},
		"a null comment": {
			id: "b1",
			field: null,
			passage: null,
			occurrence: null,
			comments: [null],
		},
		"a bad reply after a good comment": {
			id: "b1",
			field: null,
			passage: null,
			occurrence: null,
			comments: [comment, { id: "c", text: "x" }],
		},
		"an unknown field": {
			id: "b1",
			field: "byline",
			passage: "Ada",
			occurrence: 1,
			comments: [comment],
		},
		// The scenario's "a thread on an empty passage".
		"an empty passage": {
			id: "b1",
			field: "abstract",
			passage: "",
			occurrence: 1,
			comments: [comment],
		},
		"no passage": {
			id: "b1",
			field: "title",
			occurrence: 1,
			comments: [comment],
		},
		"occurrence 0": {
			id: "b1",
			field: "abstract",
			passage: "the model",
			occurrence: 0,
			comments: [comment],
		},
		"occurrence 1.5": {
			id: "b1",
			field: "abstract",
			passage: "the model",
			occurrence: 1.5,
			comments: [comment],
		},
		"occurrence as text": {
			id: "b1",
			field: "abstract",
			passage: "the model",
			occurrence: "1",
			comments: [comment],
		},
		"no occurrence": {
			id: "b1",
			field: "abstract",
			passage: "the model",
			comments: [comment],
		},
	};
	for (const [name, badThread] of Object.entries(bad)) {
		assert.deepEqual(
			usableThreads([whole, badThread, onAbstract]),
			[whole, onAbstract],
			name,
		);
	}
});

// ---- Entries the page can't draw (#92): checkDigests(lines) returns { lines, skipped } ----

// Each skipped item as the page's warning lists it: "<id or line dated ...>: <reason>".
const skippedLines = (skipped: Skipped[]) =>
	skipped.map((item) => `${item.id}: ${item.reason}`);

// A news item shaped like the scout's, as in the scenarios: id and url "https://example.com/news/9".
const newsNine = () => ({
	id: "url:https://example.com/news/9",
	type: "news",
	title: "News 9",
	authors: ["Cy Writer"],
	published: "2026-09-27",
	source: "Fixture Times",
	url: "https://example.com/news/9",
	links: [],
});

test("An entry the page can't draw is left out and named", () => {
	// The scenario's Examples rows first, then the contract's other limits on the same fields. Each case sets one field
	// of the news item to `value`, or removes the field when `value` is undefined.
	const cases = {
		"published as a date and time": {
			field: "published",
			value: "2026-10-03T19:27:17Z",
			reason: "published isn't YYYY-MM-DD",
		},
		"published as Google News writes it": {
			field: "published",
			value: "Sat, 03 Oct 2026 19:27:17 GMT",
			reason: "published isn't YYYY-MM-DD",
		},
		"authors as a string": {
			field: "authors",
			value: "Cy Writer",
			reason: "authors isn't a list",
		},
		"links as an object": {
			field: "links",
			value: { label: "PDF", url: "https://example.com/a" },
			reason: "links isn't a list",
		},
		"no title": { field: "title", value: undefined, reason: "it has no title" },
		"published on a day that does not exist": {
			field: "published",
			value: "2026-02-30",
			reason: "published isn't YYYY-MM-DD",
		},
		"published without zero padding": {
			field: "published",
			value: "2026-10-3",
			reason: "published isn't YYYY-MM-DD",
		},
		"authors holding a number": {
			field: "authors",
			value: ["Cy Writer", 7],
			reason: "authors isn't a list",
		},
		"a blank title": {
			field: "title",
			value: "   ",
			reason: "it has no title",
		},
		"a title that is not text": {
			field: "title",
			value: 42,
			reason: "it has no title",
		},
		"no type": { field: "type", value: undefined, reason: "it has no type" },
		"an empty type": { field: "type", value: "", reason: "it has no type" },
	};
	for (const [name, change] of Object.entries(cases)) {
		const item: JsonObject = newsNine();
		const fixtures: unknown[] = papers(1, 3);
		if (change.value === undefined) {
			delete item[change.field];
		} else {
			item[change.field] = change.value;
		}
		const result = checkDigests([
			{ date: TODAY, entries: fixtures.concat([item]) },
		]);
		assert.deepEqual(
			result.lines,
			[{ date: TODAY, entries: papers(1, 3) }],
			name,
		);
		assert.deepEqual(
			skippedLines(result.skipped),
			[`url:https://example.com/news/9: ${change.reason}`],
			name,
		);
	}
});

// An entry that is not an object at all has no id to name, so only its reason is checked.
test("An entry that is not an object is left out and the warning gives that reason", () => {
	for (const entry of [null, "arxiv:2601.00009", 7]) {
		const fixtures: unknown[] = papers(1, 3);
		const result = checkDigests([
			{ date: TODAY, entries: fixtures.concat([entry]) },
		]);
		assert.deepEqual(
			result.lines,
			[{ date: TODAY, entries: papers(1, 3) }],
			String(entry),
		);
		assert.deepEqual(
			result.skipped.map((item) => item.reason),
			["it isn't an object"],
			String(entry),
		);
	}
});

// Missing, blank or not text; such an entry has no id to name, so only its reason is checked.
test("An entry without an id is left out", () => {
	const ids = { missing: undefined, empty: "", blank: "   ", "a number": 9 };
	for (const [name, id] of Object.entries(ids)) {
		const item: JsonObject = newsNine();
		const fixtures: unknown[] = papers(1, 3);
		if (id === undefined) {
			delete item.id;
		} else {
			item.id = id;
		}
		const result = checkDigests([
			{ date: TODAY, entries: fixtures.concat([item]) },
		]);
		assert.deepEqual(
			result.lines,
			[{ date: TODAY, entries: papers(1, 3) }],
			name,
		);
		assert.deepEqual(
			result.skipped.map((skipped) => skipped.reason),
			["it has no id"],
			name,
		);
	}
});

test("A line with a date the page can't read is left out and named", () => {
	const result = checkDigests([
		{ date: TODAY, entries: papers(1, 3) },
		{ date: "2026-10-4", entries: papers(10, 2) },
		{ date: "2026-09-24", entries: [paper(20)] },
	]);
	assert.deepEqual(result.lines, [
		{ date: TODAY, entries: papers(1, 3) },
		{ date: "2026-09-24", entries: [paper(20)] },
	]);
	assert.deepEqual(skippedLines(result.skipped), [
		"line dated 2026-10-4: its date isn't YYYY-MM-DD",
	]);

	// Other dates the page can't read, and entries that aren't a list.
	const lines = {
		"a day that does not exist": {
			line: { date: "2026-02-30", entries: [paper(30)] },
			named: "line dated 2026-02-30: its date isn't YYYY-MM-DD",
		},
		"a date and time": {
			line: { date: "2026-09-26T00:00:00Z", entries: [paper(30)] },
			named: "line dated 2026-09-26T00:00:00Z: its date isn't YYYY-MM-DD",
		},
		"entries as an object": {
			line: { date: "2026-09-26", entries: { id: "arxiv:2601.00030" } },
			named: "line dated 2026-09-26: its entries aren't a list",
		},
		"no entries": {
			line: { date: "2026-09-26" },
			named: "line dated 2026-09-26: its entries aren't a list",
		},
	};
	for (const [name, row] of Object.entries(lines)) {
		const checked = checkDigests([
			{ date: TODAY, entries: papers(1, 3) },
			row.line,
		]);
		assert.deepEqual(
			checked.lines,
			[{ date: TODAY, entries: papers(1, 3) }],
			name,
		);
		assert.deepEqual(skippedLines(checked.skipped), [row.named], name);
	}

	// A line with no date has none to name, so only its reason is checked.
	const undated = checkDigests([
		{ date: TODAY, entries: papers(1, 3) },
		{ entries: [paper(30)] },
	]);
	assert.deepEqual(undated.lines, [{ date: TODAY, entries: papers(1, 3) }]);
	assert.deepEqual(
		undated.skipped.map((item) => item.reason),
		["its date isn't YYYY-MM-DD"],
	);
});

test("A bad entry in an older day is left out and that day's other entries stay", () => {
	const bad = Object.assign(paper(11), { published: "yesterday" });
	const result = checkDigests([
		{ date: TODAY, entries: papers(1, 3) },
		{ date: "2026-09-25", entries: [paper(10), bad] },
	]);
	assert.deepEqual(result.lines, [
		{ date: TODAY, entries: papers(1, 3) },
		{ date: "2026-09-25", entries: [paper(10)] },
	]);
	assert.deepEqual(skippedLines(result.skipped), [
		"arxiv:2601.00011: published isn't YYYY-MM-DD",
	]);
});

// The older line keeps no entry after the check, so it is dropped (no "· 0 items" row); its entry is still named.
test("A day whose entries were all left out shows no row", () => {
	const bad = Object.assign(newsNine(), { published: "yesterday" });
	const result = checkDigests([
		{ date: TODAY, entries: papers(1, 3) },
		{ date: "2026-09-25", entries: [bad] },
	]);
	assert.deepEqual(result.lines, [{ date: TODAY, entries: papers(1, 3) }]);
	assert.deepEqual(skippedLines(result.skipped), [
		"url:https://example.com/news/9: published isn't YYYY-MM-DD",
	]);
});

// Well-formed entries as the scripts write them, minimal ones without the optional fields, empty lists, and fields the
// page doesn't read (figure, venue) all pass unchanged.
test("Well-formed entries pass unchanged, including minimal ones and unknown fields, and none is left out", () => {
	const fullPaper = {
		id: "arxiv:2601.00001",
		type: "paper",
		title: "Paper 1",
		authors: ["Ada Example", "Bo Sample"],
		published: "2026-01-02",
		source: "arXiv Machine Learning",
		url: "https://arxiv.org/abs/2601.00001",
		links: [{ label: "PDF", url: "https://arxiv.org/pdf/2601.00001" }],
		abstract: "An abstract.",
		venue: "AIES 2026",
		venue_source: "https://www.aies-conference.com/2026/paper-sessions/",
		figure: {
			src: "https://arxiv.org/html/2601.00001v1/x1.png",
			caption: "Figure 1: Overview.",
			from: "https://arxiv.org/html/2601.00001v1",
			width: 1200,
			height: 600,
		},
	};
	const emptyLists = Object.assign(newsNine(), { authors: [], links: [] });
	const lines = [
		{ date: TODAY, entries: [fullPaper, paper(2), newsNine()] },
		{ date: "2026-09-25", entries: [paper(10), emptyLists] },
	];
	const result = checkDigests(lines);
	assert.deepEqual(result.lines, lines);
	assert.deepEqual(result.skipped, []);
});

// ---- tags ----

// Tags as the page stores them: an object from entry id to the tags that are on, each true; a tag that is off is
// left out, and an entry with no tag has no key.

test('"To read" and "Learn first" can both be on for one entry, whichever is pressed first', () => {
	const tags: Tags = {};
	toggleTag(tags, "arxiv:2601.00001", "toRead");
	toggleTag(tags, "arxiv:2601.00001", "learnFirst");
	assert.deepEqual(tags, {
		"arxiv:2601.00001": { toRead: true, learnFirst: true },
	});

	// In the other order, the same.
	const reversed = {};
	toggleTag(reversed, "arxiv:2601.00001", "learnFirst");
	toggleTag(reversed, "arxiv:2601.00001", "toRead");
	assert.deepEqual(reversed, {
		"arxiv:2601.00001": { toRead: true, learnFirst: true },
	});
});

test("Pressing a pressed tag clears only that tag", () => {
	const tags: Tags = {
		"arxiv:2601.00001": { toRead: true, learnFirst: true },
		"arxiv:2601.00002": { toRead: true },
	};

	// Only that tag of only that entry goes.
	toggleTag(tags, "arxiv:2601.00001", "toRead");
	assert.deepEqual(tags, {
		"arxiv:2601.00001": { learnFirst: true },
		"arxiv:2601.00002": { toRead: true },
	});

	// Pressed again, it comes back beside the other tag.
	toggleTag(tags, "arxiv:2601.00001", "toRead");
	assert.deepEqual(tags, {
		"arxiv:2601.00001": { toRead: true, learnFirst: true },
		"arxiv:2601.00002": { toRead: true },
	});
});

test("A tag is saved under the entry's id", () => {
	// Written out as the page saves it: no "toRead": false beside the tag that is on.
	const tags: Tags = {};
	toggleTag(tags, "arxiv:2601.00001", "learnFirst");
	assert.equal(
		JSON.stringify(tags),
		'{"arxiv:2601.00001":{"learnFirst":true}}',
	);

	// Every type can be tagged, whatever its id looks like.
	const others: Tags = {};
	toggleTag(others, "news:fixture-1", "toRead");
	toggleTag(others, "url:https://example.com/articles/1", "learnFirst");
	toggleTag(others, "url:https://example.com/a?b=50%25#c", "toRead");
	assert.deepEqual(others, {
		"news:fixture-1": { toRead: true },
		"url:https://example.com/articles/1": { learnFirst: true },
		"url:https://example.com/a?b=50%25#c": { toRead: true },
	});
});

test("Clearing an entry's last tag removes the entry from the saved tags", () => {
	const tags: Tags = {
		"arxiv:2601.00001": { toRead: true },
		"news:fixture-1": { learnFirst: true },
	};

	toggleTag(tags, "arxiv:2601.00001", "toRead");
	assert.deepEqual(tags, { "news:fixture-1": { learnFirst: true } });

	toggleTag(tags, "news:fixture-1", "learnFirst");
	assert.deepEqual(tags, {});
});

test('Clearing "To read", as pressing "Paper" does, keeps "Learn first" and the other entries\' tags', () => {
	// "Learn first" stays.
	const both: Tags = { "arxiv:2601.00001": { toRead: true, learnFirst: true } };
	clearTag(both, "arxiv:2601.00001", "toRead");
	assert.deepEqual(both, { "arxiv:2601.00001": { learnFirst: true } });

	// "To read" alone: the key goes with it. Other entries keep theirs.
	const alone: Tags = {
		"arxiv:2601.00001": { toRead: true },
		"arxiv:2601.00002": { toRead: true },
	};
	clearTag(alone, "arxiv:2601.00001", "toRead");
	assert.deepEqual(alone, { "arxiv:2601.00002": { toRead: true } });
});

test('Clearing "To read" when it is off changes nothing and never turns it on', () => {
	// Clearing a tag that is off changes nothing; it never turns the tag on.
	const learnFirst: Tags = { "arxiv:2601.00001": { learnFirst: true } };
	clearTag(learnFirst, "arxiv:2601.00001", "toRead");
	assert.deepEqual(learnFirst, { "arxiv:2601.00001": { learnFirst: true } });

	const none = {};
	clearTag(none, "arxiv:2601.00001", "toRead");
	clearTag(none, "arxiv:2601.00001", "toRead");
	assert.deepEqual(none, {});
});

test("The chips count tagged entries across all days", () => {
	// Today: papers 1 to 3, two of them "To read". Three days ago: papers 30 and 31, one of them both tags. An entry
	// with both tags counts once for each chip; an id no digest has counts for neither.
	const entries = papers(1, 3).concat(papers(30, 2));
	const tags: Tags = {
		"arxiv:2601.00001": { toRead: true },
		"arxiv:2601.00002": { toRead: true },
		"arxiv:2601.00030": { toRead: true, learnFirst: true },
		"arxiv:2601.99999": { toRead: true, learnFirst: true },
	};
	assert.deepEqual(tagCounts(entries, tags), { toRead: 3, learnFirst: 1 });
});

test("With nothing tagged, both tag chips count 0", () => {
	assert.deepEqual(tagCounts(papers(1, 2), {}), { toRead: 0, learnFirst: 0 });
	assert.deepEqual(tagCounts([], {}), { toRead: 0, learnFirst: 0 });
});

test("A chip shows only entries with its tag, across all days", () => {
	const tags: Tags = {
		"arxiv:2601.00001": { toRead: true },
		"arxiv:2601.00002": { toRead: true },
		"arxiv:2601.00030": { toRead: true },
		"arxiv:2601.00040": { learnFirst: true },
	};

	assert.equal(matchesTags(tags, "arxiv:2601.00001", ["toRead"]), true);
	assert.equal(matchesTags(tags, "arxiv:2601.00002", ["toRead"]), true);
	assert.equal(matchesTags(tags, "arxiv:2601.00030", ["toRead"]), true);
	// Untagged, or tagged only with the other tag.
	assert.equal(matchesTags(tags, "arxiv:2601.00003", ["toRead"]), false);
	assert.equal(matchesTags(tags, "arxiv:2601.00040", ["toRead"]), false);
	assert.equal(matchesTags(tags, "arxiv:2601.00040", ["learnFirst"]), true);
});

test("Both chips on show only entries with both tags", () => {
	const tags: Tags = {
		"arxiv:2601.00001": { toRead: true },
		"arxiv:2601.00002": { learnFirst: true },
		"arxiv:2601.00003": { toRead: true, learnFirst: true },
	};

	assert.equal(
		matchesTags(tags, "arxiv:2601.00001", ["toRead", "learnFirst"]),
		false,
	);
	assert.equal(
		matchesTags(tags, "arxiv:2601.00002", ["toRead", "learnFirst"]),
		false,
	);
	assert.equal(
		matchesTags(tags, "arxiv:2601.00003", ["toRead", "learnFirst"]),
		true,
	);
	assert.equal(
		matchesTags(tags, "arxiv:2601.00004", ["toRead", "learnFirst"]),
		false,
	);
	// The order the chips went on doesn't matter.
	assert.equal(
		matchesTags(tags, "arxiv:2601.00003", ["learnFirst", "toRead"]),
		true,
	);
});

test("With no tag chip on, every entry is shown, tagged or not", () => {
	// With no chip on, every entry matches, tagged or not.
	const tags: Tags = { "arxiv:2601.00001": { toRead: true } };
	assert.equal(matchesTags(tags, "arxiv:2601.00001", []), true);
	assert.equal(matchesTags(tags, "arxiv:2601.00002", []), true);
	assert.equal(matchesTags({}, "arxiv:2601.00030", []), true);
});

test("Untagging an entry while filtering lowers the chip count at once, and the next filter leaves the entry out", () => {
	const entries = papers(1, 2);
	const tags: Tags = {
		"arxiv:2601.00001": { toRead: true },
		"arxiv:2601.00002": { toRead: true },
	};
	assert.deepEqual(tagCounts(entries, tags), { toRead: 2, learnFirst: 0 });

	// "To read" pressed on the first paper: the count drops at once.
	toggleTag(tags, "arxiv:2601.00001", "toRead");
	assert.deepEqual(tagCounts(entries, tags), { toRead: 1, learnFirst: 0 });

	// Once the filter is applied again, only the second paper matches.
	assert.equal(matchesTags(tags, "arxiv:2601.00001", ["toRead"]), false);
	assert.equal(matchesTags(tags, "arxiv:2601.00002", ["toRead"]), true);
});

// ---- read state: the read filter chips ----

test("The read chips count papers across all days", () => {
	// Today: papers 1 to 3 and news 1 and 2; paper 1 read "abstract", paper 2 "paper", news 1 "read". Three days ago:
	// papers 30 and 31, paper 30 read "abstract". No news item is in any count, read or not; an id no digest has
	// counts for nothing.
	const entries = papers(1, 3).concat([news(1), news(2)], papers(30, 2));
	const state = readState([
		["arxiv:2601.00001", "abstract", TODAY],
		["arxiv:2601.00002", "paper", TODAY],
		["news:fixture-1", "read", TODAY],
		["arxiv:2601.00030", "abstract", "2026-09-24"],
		["arxiv:2601.99999", "paper", TODAY],
	]);
	assert.deepEqual(readChipCounts(entries, state), {
		unread: 2,
		abstract: 2,
		paper: 1,
	});
});

test("With nothing read, the Unread chip counts every paper and the depth chips count 0", () => {
	assert.deepEqual(readChipCounts(papers(1, 2), {}), {
		unread: 2,
		abstract: 0,
		paper: 0,
	});
	assert.deepEqual(readChipCounts([], {}), {
		unread: 0,
		abstract: 0,
		paper: 0,
	});
});

test("A read chip shows only entries read that deep, across all days", () => {
	const state = readState([
		["arxiv:2601.00001", "abstract", TODAY],
		["arxiv:2601.00030", "abstract", "2026-09-24"],
		["arxiv:2601.00002", "paper", TODAY],
		["news:fixture-1", "read", TODAY],
	]);

	assert.equal(matchesRead(state, paper(1), "abstract"), true);
	assert.equal(matchesRead(state, paper(30), "abstract"), true);
	assert.equal(matchesRead(state, paper(2), "abstract"), false);
	assert.equal(matchesRead(state, paper(3), "abstract"), false);
	assert.equal(matchesRead(state, news(1), "abstract"), false);

	assert.equal(matchesRead(state, paper(2), "paper"), true);
	assert.equal(matchesRead(state, paper(1), "paper"), false);
	assert.equal(matchesRead(state, paper(3), "paper"), false);
	assert.equal(matchesRead(state, news(1), "paper"), false);
});

test("Unread shows papers with no read state, and no news", () => {
	const state = readState([
		[paper(1).id, "paper", TODAY],
		[news(1).id, "read", TODAY],
	]);

	assert.equal(matchesRead(state, paper(2), "unread"), true);
	// Read at any depth is not unread, and a news item, an article or a report is never listed as unread.
	assert.equal(matchesRead(state, paper(1), "unread"), false);
	assert.equal(matchesRead(state, news(1), "unread"), false);
	assert.equal(matchesRead(state, news(2), "unread"), false);
	assert.equal(matchesRead(state, article(1), "unread"), false);
	assert.equal(matchesRead(state, report(1), "unread"), false);
});

test("With no read chip on, every entry is shown, read or not", () => {
	// With no read chip on, every entry matches, read or not.
	const state = readState([
		[paper(1).id, "paper", TODAY],
		[news(1).id, "read", TODAY],
	]);
	assert.equal(matchesRead(state, paper(1), null), true);
	assert.equal(matchesRead(state, news(1), null), true);
	assert.equal(matchesRead(state, paper(2), null), true);
	assert.equal(matchesRead({}, paper(30), null), true);
});

test("Marking a paper read while filtering changes the read chip counts at once, and the next filter leaves it out of Unread", () => {
	const entries = papers(1, 2);
	const state: ReadState = {};
	assert.deepEqual(readChipCounts(entries, state), {
		unread: 2,
		abstract: 0,
		paper: 0,
	});

	// "Abstract" pressed on the first paper: the counts change at once.
	toggleRead(state, "arxiv:2601.00001", "abstract", TODAY);
	assert.deepEqual(readChipCounts(entries, state), {
		unread: 1,
		abstract: 1,
		paper: 0,
	});

	// Once the filter is applied again, only the second paper is unread.
	assert.equal(matchesRead(state, paper(1), "unread"), false);
	assert.equal(matchesRead(state, paper(2), "unread"), true);
});

// ---- links in text ----

// The text of every piece, joined: linkPieces must give its input back.
function joined(pieces: TextPiece[]): string {
	return pieces.map((piece) => piece.text).join("");
}

// The link pieces, as [text, href] pairs, in order.
function linksOf(pieces: TextPiece[]): [string, string][] {
	const found: [string, string][] = [];
	for (const piece of pieces) {
		if (piece.href !== undefined) found.push([piece.text, piece.href]);
	}
	return found;
}

// The links linkPieces finds in `text`, checking on the way that its pieces join back into `text`.
function linksIn(text: string): [string, string][] {
	const pieces = linkPieces(text);
	assert.equal(joined(pieces), text, "the pieces join back into the text");
	return linksOf(pieces);
}

// Pieces with adjacent plain text merged and empty plain pieces dropped, so a test doesn't depend on where the
// function cuts plain text.
function merged(pieces: TextPiece[]): TextPiece[] {
	const result: TextPiece[] = [];
	for (const piece of pieces) {
		const last = result[result.length - 1];
		if (piece.href !== undefined) {
			result.push({ text: piece.text, href: piece.href });
		} else if (piece.text === "") {
			// An empty plain piece adds nothing.
		} else if (last !== undefined && last.href === undefined) {
			last.text += piece.text;
		} else {
			result.push({ text: piece.text });
		}
	}
	return result;
}

test("A web address in the text becomes a link, and the words around it stay plain", () => {
	const text = "Code at https://github.com/example/repo now";
	const pieces = linkPieces(text);
	assert.deepEqual(merged(pieces), [
		{ text: "Code at " },
		{
			text: "https://github.com/example/repo",
			href: "https://github.com/example/repo",
		},
		{ text: " now" },
	]);
});

test("Text without an address is one plain piece", () => {
	const text = "Researchers report measurements across several benchmarks.";
	assert.deepEqual(merged(linkPieces(text)), [{ text: text }]);
	assert.deepEqual(linksIn(""), []);
});

test("Punctuation after an address is left out of the link, but a closing bracket that belongs to it stays", () => {
	// [written, link].
	const examples: [string, string][] = [
		[
			"Code: https://github.com/xzhou98/SARA.",
			"https://github.com/xzhou98/SARA",
		],
		["at https://regularized-rsi.com/.", "https://regularized-rsi.com/"],
		["(see https://example.com/x), then", "https://example.com/x"],
		["see https://example.com/x; also", "https://example.com/x"],
		[
			"at https://en.wikipedia.org/wiki/Foo_(bar).",
			"https://en.wikipedia.org/wiki/Foo_(bar)",
		],
		[
			"at https://example.com/a?b=1&c=2#d, end",
			"https://example.com/a?b=1&c=2#d",
		],
	];
	for (const example of examples) {
		assert.deepEqual(
			linksIn(example[0]),
			[[example[1], example[1]]],
			example[0],
		);
	}
});

test("Every punctuation mark after an address stays outside the link, also an unmatched bracket and several marks in a row", () => {
	const url = "https://example.com/a";
	for (const mark of [".", ",", ";", ":", "!", "?", '"', "'", ">"]) {
		assert.deepEqual(linksIn(`see ${url}${mark} next`), [[url, url]], mark);
	}
	// An unmatched ")" or "]" stays outside; so do several marks in a row.
	assert.deepEqual(linksIn(`[see ${url}]`), [[url, url]]);
	assert.deepEqual(linksIn(`(see ${url}).`), [[url, url]]);
	assert.deepEqual(linksIn(`see ${url}?!`), [[url, url]]);
});

test("An address runs to the next space, and http:// counts too", () => {
	assert.deepEqual(linksIn("http://example.com/plain"), [
		["http://example.com/plain", "http://example.com/plain"],
	]);
	assert.deepEqual(linksIn("https://a.example/one and https://b.example/two"), [
		["https://a.example/one", "https://a.example/one"],
		["https://b.example/two", "https://b.example/two"],
	]);
	// A mark inside the address, not at its end, stays in it.
	assert.deepEqual(linksIn("see https://example.com/a.b,c;d now"), [
		["https://example.com/a.b,c;d", "https://example.com/a.b,c;d"],
	]);
});

test("A DOI becomes a doi.org link", () => {
	// [written, link text, target].
	const examples: [string, string, string][] = [
		[
			"Data (DOI: 10.5281/zenodo.23068698)",
			"10.5281/zenodo.23068698",
			"https://doi.org/10.5281/zenodo.23068698",
		],
		["doi:10.1000/xyz123.", "10.1000/xyz123", "https://doi.org/10.1000/xyz123"],
	];
	for (const example of examples) {
		assert.deepEqual(
			linksIn(example[0]),
			[[example[1], example[2]]],
			example[0],
		);
	}
	// The "DOI: " before the number stays plain text.
	assert.deepEqual(merged(linkPieces("Data (DOI: 10.5281/zenodo.1)")), [
		{ text: "Data (DOI: " },
		{ text: "10.5281/zenodo.1", href: "https://doi.org/10.5281/zenodo.1" },
		{ text: ")" },
	]);
});

test("Text that isn't a web address stays text", () => {
	const examples = [
		"javascript:alert(1)",
		"ftp://example.com/file",
		"www.example.com without scheme",
		"github.com/example/repo",
		"cs.AI and cs.LG",
	];
	for (const written of examples) {
		assert.deepEqual(linksIn(written), [], written);
	}
});

test("An address next to typeset math is still a link", () => {
	assert.deepEqual(
		linksIn("We bound $\\alpha$ at https://example.com/proof."),
		[["https://example.com/proof", "https://example.com/proof"]],
	);
});

test("Quotes and angle brackets around an address stay outside the link", () => {
	const text =
		"See \"https://example.com/x\". Or 'https://example.com/y', or <https://example.com/z>.";
	assert.deepEqual(linksIn(text), [
		["https://example.com/x", "https://example.com/x"],
		["https://example.com/y", "https://example.com/y"],
		["https://example.com/z", "https://example.com/z"],
	]);
});

// "A link the authors wrote in TeX shows as a link with their words".
test("A link written in TeX becomes a link with the words the authors gave it, also inside math", () => {
	// The feature's examples and a \url: [written, pieces].
	const examples: [string, TextPiece[]][] = [
		[
			"data ($\\href{https://huggingface.co/datasets/a/b}{MultiTalkPT}$)",
			[
				{ text: "data (" },
				{
					text: "MultiTalkPT",
					href: "https://huggingface.co/datasets/a/b",
				},
				{ text: ")" },
			],
		],
		[
			"see $$\\href{https://a.org/x}{Data}$$ now",
			[
				{ text: "see " },
				{ text: "Data", href: "https://a.org/x" },
				{ text: " now" },
			],
		],
		[
			"in the \\href{https://github.com/a/b}{Molt library}.",
			[
				{ text: "in the " },
				{ text: "Molt library", href: "https://github.com/a/b" },
				{ text: "." },
			],
		],
		[
			"code: \\url{https://github.com/a/b}.",
			[
				{ text: "code: " },
				{ text: "https://github.com/a/b", href: "https://github.com/a/b" },
				{ text: "." },
			],
		],
	];
	for (const example of examples) {
		assert.deepEqual(merged(texLinkPieces(example[0])), example[1], example[0]);
	}
});

test("A TeX \\url shows its address as the link's words", () => {
	// An address with TeX's escapes, which KaTeX also reads as the characters they stand for.
	assert.deepEqual(
		merged(texLinkPieces("\\url{https://example.com/a\\_b\\%20c\\#d}")),
		[
			{
				text: "https://example.com/a_b%20c#d",
				href: "https://example.com/a_b%20c#d",
			},
		],
	);
});

test("security: A TeX link to anything but a web address shows only its words", () => {
	assert.deepEqual(
		merged(texLinkPieces("\\href{javascript:alert(1)}{click here} now")),
		[{ text: "click here now" }],
	);
	assert.deepEqual(
		merged(texLinkPieces("\\href{mailto:a@example.com}{write}")),
		[{ text: "write" }],
	);
	// \url has no words of its own, so a non-web address shows as it was written.
	assert.deepEqual(merged(texLinkPieces("\\url{ftp://example.com/file}")), [
		{ text: "ftp://example.com/file" },
	]);
});

test("A TeX link without both closing braces stays as written", () => {
	for (const written of [
		"see \\href{https://example.com/a}{words and more",
		"see \\href{https://example.com/a} words",
		"see \\href{https://example.com/a",
		"see \\url{https://example.com/a",
	]) {
		assert.deepEqual(
			merged(texLinkPieces(written)),
			[{ text: written }],
			written,
		);
	}
});

// "Prose rendering preserves unsupported input as text" and "Math written for the authors' own
// TeX still renders": the parsing.
test("security: An unknown TeX command stays as written with its contents, and HTML inside a known command stays text", () => {
	assert.deepEqual(proseNodes("a \\foo{bar \\emph{baz}} b", 0), [
		"a \\foo{bar \\emph{baz}} b",
	]);
	// A known command inside an unknown one isn't formatted, and markup in a known one stays text.
	assert.deepEqual(proseNodes("\\textit{<img src=x onerror=alert(1)>}", 0), [
		{ tag: "i", children: ["<img src=x onerror=alert(1)>"] },
	]);
});

test("A TeX command without its closing brace stays as written", () => {
	assert.deepEqual(proseNodes("an \\emph{unfinished group", 0), [
		"an \\emph{unfinished group",
	]);
	assert.deepEqual(proseNodes("\\textbf{one \\emph{two}", 0), [
		"\\textbf{one \\emph{two}",
	]);
});

test("A bare percent in math is escaped, so it reads as a percent sign", () => {
	assert.equal(escapePercent("50%"), "50\\%");
	assert.equal(escapePercent("a % b % c"), "a \\% b \\% c");
});

test("A percent already escaped in math isn't escaped twice", () => {
	assert.equal(escapePercent("50\\%"), "50\\%");
});

// Engagement changes.
test('an entry goes under "From the labs" when its URL\'s host is a lab host or a subdomain of one, and under "News" otherwise', () => {
	const groupOf = (host: string) => entryGroup(from(news(1), host));
	// A lab host itself, and a subdomain of one, whatever the entry's type.
	assert.equal(groupOf("openai.com"), "From the labs");
	assert.equal(groupOf("deepmind.google"), "From the labs");
	assert.equal(groupOf("blog.redwoodresearch.org"), "From the labs");
	assert.equal(
		entryGroup(from(article(1), "WWW.Anthropic.COM")),
		"From the labs",
	);
	assert.equal(entryGroup(from(report(1), "openai.com")), "From the labs");
	// Other hosts, including ones that only end or begin like a lab host.
	assert.equal(groupOf("www.nytimes.com"), "News");
	assert.equal(groupOf("blog.google"), "News");
	assert.equal(groupOf("notopenai.com"), "News");
	assert.equal(groupOf("openai.com.example.org"), "News");
	// A paper is a paper, whatever its host.
	assert.equal(entryGroup(from(paper(1), "openai.com")), "Papers");
});
test("a lesswrong.com post groups under LessWrong", () => {
	assert.equal(entryGroup(from(article(1), "lesswrong.com")), "LessWrong");
});
test("an alignmentforum.org post groups under LessWrong", () => {
	assert.equal(entryGroup(from(article(1), "alignmentforum.org")), "LessWrong");
});
test("a subdomain of lesswrong.com groups under LessWrong", () => {
	assert.equal(entryGroup(from(article(1), "www.lesswrong.com")), "LessWrong");
	assert.equal(
		entryGroup(from(article(1), "www.alignmentforum.org")),
		"LessWrong",
	);
	// A host that only ends like lesswrong.com is not one.
	assert.equal(entryGroup(from(article(1), "notlesswrong.com")), "News");
});
test("groups come in the order Papers, From the labs, LessWrong, News", () => {
	const groups = contentsGroups([
		from(news(1), "techcrunch.com"),
		from(article(1), "www.lesswrong.com"),
		from(article(2), "www.anthropic.com"),
		paper(1),
	]);
	assert.deepEqual(
		groups.map((group) => group.label),
		["Papers", "From the labs", "LessWrong", "News"],
	);
});
test("Papers added ad hoc come first among the day's papers, each in the order added", () => {
	const adHoc = (n: number): Entry => ({ ...paper(n), ad_hoc: true });
	const groups = contentsGroups([
		paper(1),
		paper(2),
		adHoc(3),
		paper(4),
		adHoc(5),
	]);
	assert.deepEqual(
		itemAt(groups, 0).entries.map((entry) => entry.id),
		[adHoc(3), adHoc(5), paper(1), paper(2), paper(4)].map((entry) => entry.id),
	);
});
test('an entry without a URL, or with one that is not http(s), goes under "News"', () => {
	const withUrl = (url: unknown): Entry => ({ ...news(1), url });
	assert.equal(entryGroup(news(1)), "News");
	assert.equal(entryGroup(withUrl(undefined)), "News");
	assert.equal(entryGroup(withUrl("not a url")), "News");
	assert.equal(entryGroup(withUrl("ftp://openai.com/x")), "News");
	assert.equal(
		entryGroup(withUrl("javascript://openai.com/%0Aalert(1)")),
		"News",
	);
	assert.equal(entryGroup(withUrl(42)), "News");
});
test("a week is crowned only when each of its 7 days has a paper read, also days before the heatmap's first square", () => {
	// On Thursday 1 October the heatmap starts on Friday 10 July, so Monday 6 July's week begins 4 days left of it.
	const first = heatmapDays("2026-10-01")[0];
	assert.equal(first, "2026-07-10");
	const monday = "2026-07-06";
	const week = [
		"2026-07-06",
		"2026-07-07",
		"2026-07-08",
		"2026-07-09",
		"2026-07-10",
		"2026-07-11",
		"2026-07-12",
	];
	const byDate = new Map<string, Entry[]>();
	const state: ReadState = {};
	for (const [i, date] of week.entries()) {
		byDate.set(date, [paper(100 + i), paper(200 + i)]);
		state[paper(100 + i).id] = { depth: "abstract", date: date };
	}
	assert.equal(weekCrowned(monday, byDate, state), true);

	// A day left of the heatmap with nothing read leaves the week uncrowned, as one inside it does.
	const unread = { ...state };
	delete unread[paper(101).id];
	assert.equal(weekCrowned(monday, byDate, unread), false);
	const unreadInside = { ...state };
	delete unreadInside[paper(103).id];
	assert.equal(weekCrowned(monday, byDate, unreadInside), false);

	// A day the page knows nothing about has no paper read, and neither does a news item read.
	const missing = new Map(byDate);
	missing.delete("2026-07-12");
	assert.equal(weekCrowned(monday, missing, state), false);
	byDate.set("2026-07-09", [news(1)]);
	assert.equal(
		weekCrowned(monday, byDate, {
			...state,
			[news(1).id]: { depth: "read", date: "2026-07-09" },
		}),
		false,
	);

	// Depth "paper" counts as read as well as "abstract".
	const deep = {
		...state,
		[paper(100).id]: { depth: "paper" as const, date: "2026-07-06" },
	};
	byDate.set("2026-07-09", [paper(103)]);
	assert.equal(weekCrowned(monday, byDate, deep), true);
});

test("A day is crowned when one of its papers is read in depth", () => {
	const day = [paper(1), paper(2), news(1)];
	assert.equal(dayCrowned(day, {}), false);
	// "abstract" is not in depth, and a read mark on a news item counts nowhere.
	assert.equal(
		dayCrowned(
			day,
			readState([
				[paper(1).id, "abstract", TODAY],
				[news(1).id, "read", TODAY],
			]),
		),
		false,
	);
	assert.equal(
		dayCrowned(day, readState([[paper(2).id, "paper", TODAY]])),
		true,
	);
	assert.equal(
		dayCrowned([news(1)], readState([[news(1).id, "paper", TODAY]])),
		false,
	);
});
test("a read mark on a news item, an article or a report counts in no square, chip, progress line or badge", () => {
	const entries = [paper(1), paper(2), news(1), article(1), report(1)];
	const unread: ReadState = {};
	const marked = readState([
		[news(1).id, "paper", TODAY],
		[article(1).id, "abstract", TODAY],
		[report(1).id, "read", TODAY],
	]);
	// The square: the day's tally, and so its shade, is what it is with no mark at all.
	assert.deepEqual(readCounts(entries, marked), readCounts(entries, unread));
	const counts = readCounts(entries, marked);
	assert.equal(counts.read, 0);
	assert.equal(counts.total, 2);
	assert.equal(heatLevel(counts.read, counts.total), "none");
	// The chips.
	assert.deepEqual(
		readChipCounts(entries, marked),
		readChipCounts(entries, unread),
	);
	assert.deepEqual(readChipCounts(entries, marked), {
		unread: 2,
		abstract: 0,
		paper: 0,
	});
	// The progress line.
	assert.deepEqual(
		paperProgress(entries, marked),
		paperProgress(entries, unread),
	);
	assert.equal(paperProgress(entries, marked).read, 0);
	// The badge.
	const days: Day[] = [{ date: TODAY, entries: entries }];
	assert.equal(unreadToday(days, marked, TODAY), 2);
});
test("the badge counts today's unread papers by Jakarta's date, and is 0 when today has no digest", () => {
	const days: Day[] = [
		{ date: TODAY, entries: [paper(1), paper(2), paper(3), news(1)] },
		{ date: "2026-09-26", entries: [paper(10), paper(11)] },
	];
	const state = readState([
		[paper(1).id, "abstract", TODAY],
		// Yesterday's papers are read or not, they are not today's.
		[paper(10).id, "paper", "2026-09-26"],
	]);
	assert.equal(unreadToday(days, state, TODAY), 2);
	assert.equal(
		unreadToday(days, readState([[paper(2).id, "paper", TODAY]]), TODAY),
		2,
	);
	assert.equal(
		unreadToday(
			days,
			readState([
				[paper(1).id, "abstract", TODAY],
				[paper(2).id, "abstract", TODAY],
				[paper(3).id, "paper", TODAY],
			]),
			TODAY,
		),
		0,
	);
	// The newest digest is yesterday's: no digest today, so nothing is unread today.
	assert.equal(unreadToday(days.slice(1), {}, TODAY), 0);
	assert.equal(unreadToday([], {}, TODAY), 0);
	// The date is Jakarta's: at 23:30 in Los Angeles (the test process's zone) on 26 September it is 27 September in
	// Jakarta, where the digest of that day is today's.
	const lateEvening = new Date("2026-09-27T06:30:00Z");
	assert.equal(jakartaToday(lateEvening), TODAY);
	assert.equal(unreadToday(days, {}, jakartaToday(lateEvening)), 3);
});

test("well-formed saved takeaways are kept, newest first, and malformed ones are dropped", () => {
	const take = (id: string, created: string) => ({
		id,
		text: `text ${id}`,
		question: null,
		created,
		edited: null,
		source: "page",
	});
	const warn = console.warn;
	console.warn = () => {};
	try {
		const kept = takeawaysOf({
			"arxiv:1": [
				take("old", "2026-09-01T10:00:00Z"),
				{ id: "no-text", created: "2026-09-02T10:00:00Z" },
				take("new", "2026-09-03T10:00:00Z"),
				{ ...take("bad-source", "2026-09-04T10:00:00Z"), source: "email" },
			],
			"arxiv:2": [{ id: "no-text" }],
			"arxiv:3": "not a list",
		});
		assert.deepEqual(
			kept["arxiv:1"]?.map((item) => item.id),
			["new", "old"],
		);
		assert.deepEqual(Object.keys(kept), ["arxiv:1"]);
	} finally {
		console.warn = warn;
	}
});

test.todo("stackTops starts the first card no higher than the floor");
test.todo("counts every comment after the first as a reply, Claude's included");
test.todo('names one reply "1 reply" and more "n replies"');
test.todo(
	"shows a thread with replies folded unless it was opened or commented in during this visit",
);
