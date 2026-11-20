// Older months: loading a month and drawing its days when one is opened, selected, or named by a link.
import type { IndexDay } from "../../shared/site-data-shape.ts";
import { checkDigests } from "./check.ts";
import { contentsTitles } from "./contents.ts";
import type { MonthLoader } from "./data.ts";
import { dayLabel, itemCount, mergeDays, shortDayLabel } from "./days.ts";
import { el, status } from "./dom.ts";
import { type Typesetting, typesetFolded } from "./entry.ts";
import type { OlderDay } from "./older-day.ts";
import { inMonth, type PageModel } from "./page-model.ts";
import type { Day, Entry, Skipped } from "./types.ts";

// The header's warning for what checkDigests left out: "2 entries couldn't be shown", which unfolds to each entry or
// line and why. It links nowhere: an id is whatever the data holds. The console gets one
// line per item too. The count adds up what each item stands for, so it agrees with the list it unfolds to.
export function skippedWarning(skipped: Skipped[]) {
	const list = el("ul");
	let count = 0;
	for (const item of skipped) {
		count += item.count;
		list.append(el("li", null, `${item.id}: ${item.reason}`));
		console.warn(`Not shown: ${item.id}: ${item.reason}`);
	}
	let text = `${count} entries couldn't be shown`;
	if (count === 1) text = "1 entry couldn't be shown";
	// The fold arrow is an element of its own, not the browser's marker, so it can line up with the warning sign.
	const arrow = el("span", { class: "skipped__arrow", "aria-hidden": "true" });
	return el(
		"details",
		{ class: "skipped" },
		el("summary", null, arrow, status("warning", text)),
		list,
	);
}

// An older day's folded row: its date as a heading at the newest day's level, so a screen reader lists every day,
// then its item count. Its text reads as before, "Saturday 26 September · 3 items".
function dayRow(date: string, count: number) {
	return el(
		"summary",
		null,
		el("h2", { class: "day__date" }, dayLabel(date)),
		` · ${itemCount(count)}`,
	);
}

// What the months need from the rest of the page: the loader, how a day's entries are drawn, and what to redraw after
// a month has been drawn.
export type MonthsDeps = {
	loadMonth: MonthLoader;
	dayEntries: (day: Day, typesetting: Typesetting) => HTMLElement[];
	drawComments: (details: HTMLElement) => void;
	collectContents: () => void;
	redraw: () => void;
	refreshTags: () => void;
};

export type Months = {
	drawDays: (
		main: HTMLElement,
		days: Day[],
		olderMonthDays: IndexDay[],
	) => void;
	fillMonth: (month: string, monthLines: unknown[]) => void;
	showDayError: (pair: OlderDay) => void;
	openOlderDay: (pair: OlderDay) => void;
	loadSelectedMonths: () => Promise<void>;
};

export function createMonths(model: PageModel, deps: MonthsDeps): Months {
	// The newest day is open; every other day of its month is folded but stays in the DOM, so Cmd+F still finds it. A
	// folded day's math is typeset when it first unfolds, and its highlights are found again in the typeset text.
	// An older month's day is a folded row with its date and item count from the index. Its entries are drawn when its
	// month loads, the first time one of its days is needed.
	function drawDays(
		main: HTMLElement,
		days: Day[],
		olderMonthDays: IndexDay[],
	) {
		model.newestSection.append(...deps.dayEntries(model.newest, "now"));
		main.append(model.newestSection);
		for (const day of days.slice(1)) {
			const details = el(
				"details",
				{ class: "day", "data-date": day.date },
				dayRow(day.date, day.entries.length),
				...deps.dayEntries(day, "on unfold"),
			);
			details.addEventListener("toggle", () => {
				if (!details.open) return;
				typesetFolded(details);
				deps.drawComments(details);
			});
			main.append(details);
			model.olderPairs.push({
				day: day,
				details: details,
				month: day.date.slice(0, 7),
				ids: null,
				indexEntries: [],
				error: null,
			});
		}
		for (const indexDay of olderMonthDays) {
			const ids = indexDay.entries.map((entry) => entry.id);
			const details = el(
				"details",
				{ class: "day", "data-date": indexDay.date },
				dayRow(indexDay.date, ids.length),
			);
			main.append(details);
			const pair: OlderDay = {
				day: { date: indexDay.date, entries: [] },
				details: details,
				month: indexDay.month,
				ids: ids,
				indexEntries: indexDay.entries,
				error: null,
			};
			model.olderPairs.push(pair);
			details.addEventListener("toggle", () => {
				if (details.open) openOlderDay(pair);
			});
		}
	}

	// Draw an older day's entries once its month has loaded: the row and the contents take the loaded count, which
	// leaves out entries the page can't draw. A day left with none goes from the page and the contents. The entries
	// are drawn before the day changes, so a day whose entries can't be drawn stays as it was, still waiting.
	function fillDay(pair: OlderDay, loaded: Day | undefined) {
		let entries: Entry[] = [];
		if (loaded !== undefined) entries = loaded.entries;
		const day: Day = { date: pair.day.date, entries: entries };
		const nodes = deps.dayEntries(day, "now");
		pair.ids = null;
		if (pair.error !== null) {
			pair.error.remove();
			pair.error = null;
		}
		pair.day = day;
		if (entries.length === 0) {
			pair.details.remove();
			if (pair.row) pair.row.remove();
			if (pair.titles) pair.titles.remove();
			return;
		}
		const summary = pair.details.querySelector("summary");
		if (summary) summary.replaceWith(dayRow(pair.day.date, entries.length));
		if (pair.row) {
			pair.row.textContent = `${shortDayLabel(pair.day.date)} · ${itemCount(entries.length)}`;
		}
		if (pair.titles) pair.titles.replaceChildren(...contentsTitles(entries));
		pair.details.append(...nodes);
		deps.drawComments(pair.details);
	}

	// Draw every day of a month that just loaded, then filter them as the chips that are on say. A month loads once;
	// this runs again only for a day that couldn't be drawn, when it is opened again.
	function fillMonth(month: string, monthLines: unknown[]) {
		const waiting = model.olderPairs.filter(
			(pair) => pair.month === month && pair.ids !== null,
		);
		if (waiting.length === 0) return;
		const checkedMonth = checkDigests(monthLines);
		const byDate = new Map<string, Day>();
		for (const day of mergeDays(checkedMonth.lines)) byDate.set(day.date, day);
		// A day that can't be drawn says so under its row; the month's other days are still drawn.
		for (const pair of waiting) {
			try {
				fillDay(pair, byDate.get(pair.day.date));
			} catch (error) {
				console.error(`${pair.day.date} not drawn:`, error);
				showDayError(pair);
			}
		}
		// What this month left out joins the header's warning.
		if (checkedMonth.skipped.length > 0) {
			for (const item of checkedMonth.skipped) model.skipped.push(item);
			const updated = skippedWarning(model.skipped);
			if (model.warning) model.warning.replaceWith(updated);
			else model.header.append(updated);
			model.warning = updated;
		}
		deps.collectContents();
		deps.redraw();
		deps.refreshTags();
	}

	// "Couldn't load this day" under the day's row, until it is opened again.
	function showDayError(pair: OlderDay) {
		if (pair.ids === null || pair.error !== null) return;
		const error = status("danger", "Couldn't load this day");
		error.classList.add("day__error");
		const summary = pair.details.querySelector("summary");
		if (summary) summary.after(error);
		pair.error = error;
	}

	// An older day was opened: load its month, or try again after a failure. A month that can't be loaded or drawn
	// says so under the day's row.
	function openOlderDay(pair: OlderDay) {
		if (pair.ids === null) return;
		if (pair.error !== null) {
			pair.error.remove();
			pair.error = null;
		}
		deps
			.loadMonth(pair.month)
			.then((monthLines) => fillMonth(pair.month, monthLines))
			.catch((error) => {
				console.error(`${pair.day.date} not loaded:`, error);
				showDayError(pair);
			});
	}

	// Explicit month navigation loads each selected month once, in parallel.
	function loadSelectedMonths() {
		const months = new Set<string>();
		for (const pair of model.olderPairs) {
			if (pair.ids !== null && inMonth(model, pair.day.date))
				months.add(pair.month);
		}
		// A month that fails to load is left to its days, which say so when opened; one that fails to draw is logged.
		const loads = Array.from(months).map((month) =>
			deps
				.loadMonth(month)
				.then(
					(monthLines) => fillMonth(month, monthLines),
					() => undefined,
				)
				.catch((error) => console.error(`${month} not drawn:`, error)),
		);
		return Promise.all(loads).then(() => undefined);
	}

	return {
		drawDays: drawDays,
		fillMonth: fillMonth,
		showDayError: showDayError,
		openOlderDay: openOlderDay,
		loadSelectedMonths: loadSelectedMonths,
	};
}
