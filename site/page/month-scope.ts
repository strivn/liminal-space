// The month in view: the month menu and its All button, which days they show, and opening a day from the heatmap.
import { el } from "./dom.ts";
import { monthMenu } from "./month-menu.ts";
import type { OlderDay } from "./older-day.ts";
import { inMonth, type PageModel } from "./page-model.ts";

// What the month scope needs from the rest of the page. `contents` is read when the scope is shown, since the contents
// are drawn after the month menu they hold.
export type MonthScopeDeps = {
	contents: () => HTMLElement;
	updateTracker: () => void;
	placeComments: () => void;
	refreshTags: () => void;
	clearTagFilters: () => void;
	loadSelectedMonths: () => Promise<void>;
	showDayError: (pair: OlderDay) => void;
};

export function createMonthScope(model: PageModel, deps: MonthScopeDeps) {
	// Month selection owns data loading and visibility; every chip narrows this scope.
	const months = [
		...new Set([
			model.newestDate.slice(0, 7),
			...model.olderPairs.map((pair) => pair.month),
		]),
	]
		.sort()
		.reverse();
	const monthFormat = new Intl.DateTimeFormat("en-GB", {
		month: "long",
		year: "numeric",
		timeZone: "UTC",
	});
	const monthSelect = monthMenu(
		months.map((month) => ({
			value: month,
			label: monthFormat.format(new Date(`${month}-01T00:00:00Z`)),
		})),
		model.selectedMonth,
		(month) => {
			void selectMonth(month);
		},
	);
	const allMonths = el(
		"button",
		{ type: "button", "aria-pressed": "false", class: "month-all" },
		"All",
	);
	const monthControl = el(
		"div",
		{ class: "month-control" },
		monthSelect.root,
		allMonths,
	);

	function showMonthScope() {
		model.newestSection.classList.toggle(
			"month-hidden",
			!inMonth(model, model.newestDate),
		);
		deps
			.contents()
			.querySelector(".contents__newest")
			?.classList.toggle("month-hidden", !inMonth(model, model.newestDate));
		for (const pair of model.olderPairs) {
			for (const node of [pair.details, pair.row, pair.titles])
				node?.classList.toggle("month-hidden", !inMonth(model, pair.day.date));
		}
		deps.updateTracker();
		deps.placeComments();
	}
	async function selectMonth(month: string | null) {
		model.selectedMonth = month;
		allMonths.setAttribute("aria-pressed", String(month === null));
		monthSelect.setValue(month);
		showMonthScope();
		deps.refreshTags();
		await deps.loadSelectedMonths();
		// A failed month stays open with its existing retry control and error notice.
		for (const pair of model.olderPairs) {
			if (inMonth(model, pair.day.date) && pair.ids !== null) {
				pair.details.open = true;
				deps.showDayError(pair);
			}
		}
		deps.refreshTags();
		showMonthScope();
	}
	allMonths.addEventListener("click", () => {
		void selectMonth(null);
	});

	async function openHeatmapDay(date: string) {
		deps.clearTagFilters();
		if (!inMonth(model, date)) await selectMonth(date.slice(0, 7));
		const pair = model.olderPairs.find((older) => older.day.date === date);
		if (pair !== undefined) {
			pair.details.open = true;
			pair.details.scrollIntoView({ block: "start" });
		} else if (date === model.newestDate)
			model.newestSection.scrollIntoView({ block: "start" });
	}

	return {
		monthControl: monthControl,
		showMonthScope: showMonthScope,
		selectMonth: selectMonth,
		openHeatmapDay: openHeatmapDay,
	};
}
