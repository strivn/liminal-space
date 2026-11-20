// @vitest-environment jsdom
// The phone's bar (site/page/entry.ts, site/page/progress.ts): the strip's crowned days and the progress line.
import { describe, expect, test } from "vitest";
import { drawHeatmap, drawHeatStrip } from "../../site/page/entry.ts";
import {
	drawBarProgress,
	drawProgress,
	progressShare,
} from "../../site/page/progress.ts";
import type { Entry, ReadState } from "../../site/page/types.ts";

const TODAY = "2026-09-27";
const SATURDAY = "2026-09-26";

// The strip drawn for today and Saturday, each with two papers: `read` says which marks each has.
function stripWith(state: ReadState) {
	const strip = document.createElement("aside");
	const days = [
		{
			date: TODAY,
			entries: [
				{ id: "arxiv:1", type: "paper" },
				{ id: "arxiv:2", type: "paper" },
			],
		},
		{
			date: SATURDAY,
			entries: [
				{ id: "arxiv:3", type: "paper" },
				{ id: "arxiv:4", type: "paper" },
			],
		},
	];
	drawHeatStrip(strip, days, state, TODAY, async () => undefined);
	return strip;
}

const square = (strip: HTMLElement, date: string) => {
	const found = strip.querySelector<HTMLElement>(`[data-date="${date}"]`);
	if (found === null) throw new Error(`no square for ${date}`);
	return found;
};

const read = (depth: "abstract" | "paper") => ({ depth: depth, date: TODAY });

describe("the strip", () => {
	test("a day in the strip with a paper read in depth shows a crown and no number", () => {
		const strip = stripWith({ "arxiv:1": read("paper") });
		const today = square(strip, TODAY);
		expect(today.querySelector('svg[data-icon="crown"]')).not.toBeNull();
		expect(today.textContent).toBe("");
	});

	test("a day in the strip with no paper read in depth shows its date", () => {
		// Saturday's paper is read only as an abstract, so it earns no crown.
		const strip = stripWith({
			"arxiv:1": read("paper"),
			"arxiv:3": read("abstract"),
		});
		const saturday = square(strip, SATURDAY);
		expect(saturday.textContent).toBe("26");
		expect(saturday.querySelector("svg")).toBeNull();
	});

	test("a day's label says a paper was read in depth only when one was", () => {
		const strip = stripWith({ "arxiv:1": read("paper") });
		expect(square(strip, TODAY).getAttribute("aria-label")).toBe(
			"Sun 27 Sep · 1 of 2 papers read · 1 paper · a paper read in depth",
		);
		expect(square(strip, SATURDAY).getAttribute("aria-label")).not.toContain(
			"in depth",
		);
	});

	test("the strip holds the last 7 days in one row, oldest first, ending today", () => {
		const strip = stripWith({});
		expect(
			Array.from(strip.children, (day) => (day as HTMLElement).dataset.date),
		).toEqual([
			"2026-09-21",
			"2026-09-22",
			"2026-09-23",
			"2026-09-24",
			"2026-09-25",
			"2026-09-26",
			"2026-09-27",
		]);
	});

	test("a strip square has the shade and label of the same day's heatmap square", () => {
		const state: ReadState = { "arxiv:1": read("abstract") };
		const strip = stripWith(state);
		const heatmap = document.createElement("div");
		const days = [
			{
				date: TODAY,
				entries: [
					{ id: "arxiv:1", type: "paper" },
					{ id: "arxiv:2", type: "paper" },
				],
			},
		];
		drawHeatmap(heatmap, days, state, TODAY, async () => undefined);
		const same = square(heatmap, TODAY);
		const mine = square(strip, TODAY);
		expect(mine.className).toBe(same.className);
		expect(mine.getAttribute("aria-label")).toBe(
			same.getAttribute("aria-label"),
		);
	});

	test("tapping a day with a digest opens it, and a day without one is an image, not a button", () => {
		const opened: string[] = [];
		const strip = document.createElement("aside");
		drawHeatStrip(
			strip,
			[{ date: TODAY, entries: [{ id: "arxiv:1", type: "paper" }] }],
			{},
			TODAY,
			async (date) => {
				opened.push(date);
			},
		);
		square(strip, TODAY).click();
		expect(opened).toEqual([TODAY]);
		const empty = square(strip, SATURDAY);
		expect(empty.tagName).toBe("SPAN");
		expect(empty.getAttribute("role")).toBe("img");
		empty.click();
		expect(opened).toEqual([TODAY]);
	});

	test("the ring on the day being read stays when the strip is drawn again", () => {
		const strip = document.createElement("aside");
		strip.dataset.current = SATURDAY;
		const days = [
			{ date: SATURDAY, entries: [{ id: "arxiv:3", type: "paper" }] },
		];
		drawHeatStrip(strip, days, {}, TODAY, async () => undefined);
		drawHeatStrip(
			strip,
			days,
			{ "arxiv:3": read("abstract") },
			TODAY,
			async () => undefined,
		);
		expect(
			Array.from(
				strip.querySelectorAll("[aria-current]"),
				(day) => (day as HTMLElement).dataset.date,
			),
		).toEqual([SATURDAY]);
	});
});

const entryOf = (id: string, type: string): Entry => ({
	id: id,
	type: type,
	title: id,
});

describe("the progress line", () => {
	test("the progress lines in the phone bar and the header fill to the share of papers read, and news does not count", () => {
		// Three of six papers read, and a news item that counts nowhere.
		const entries = [1, 2, 3, 4, 5, 6].map((n) =>
			entryOf(`arxiv:${n}`, "paper"),
		);
		entries.push(entryOf("url:news", "news"));
		const state: ReadState = {
			"arxiv:1": read("paper"),
			"arxiv:2": read("abstract"),
			"arxiv:3": read("abstract"),
			"url:news": { depth: "read", date: TODAY },
		};
		expect(progressShare(entries, state)).toBe(0.5);
		const line = document.createElement("div");
		drawBarProgress(line, entries, state);
		expect(line.querySelector("i")?.style.width).toBe("50%");
		// The header's bar is filled to the same share.
		const header = document.createElement("div");
		drawProgress(header, entries, state);
		expect(header.querySelector("i")?.style.width).toBe("50%");
	});

	test("a day without papers draws no line", () => {
		const entries = [entryOf("url:news", "news")];
		expect(progressShare(entries, {})).toBeNull();
		const line = document.createElement("div");
		// A line drawn for an earlier day is cleared.
		drawBarProgress(line, [entryOf("arxiv:1", "paper")], {});
		drawBarProgress(line, entries, {});
		expect(line.childElementCount).toBe(0);
	});
});
