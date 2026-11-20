// What the pieces of the drawn page share: the newest day, the older days, the month in view and the header's warning.
import { type OlderDay, olderDayEntries } from "./older-day.ts";
import type { Day, Skipped } from "./types.ts";

// `selectedMonth` is "YYYY-MM", or null for every month. `skipped` and `warning` are what the header says was left out.
export type PageModel = {
	newest: Day;
	newestSection: HTMLElement;
	newestDate: string;
	today: string;
	olderPairs: OlderDay[];
	selectedMonth: string | null;
	header: HTMLElement;
	skipped: Skipped[];
	warning: HTMLElement | null;
};

// Every entry the chips and the heatmap count: drawn entries, and the index's ids for months not loaded.
export function countedEntries(model: PageModel) {
	const counted: { id: string; type: string; ad_hoc?: unknown }[] = [];
	if (inMonth(model, model.newest.date)) counted.push(...model.newest.entries);
	for (const pair of model.olderPairs) {
		if (inMonth(model, pair.day.date)) counted.push(...pair.day.entries);
	}
	return counted;
}

// Every day's entries as the heatmap counts them.
export function heatmapData(model: PageModel) {
	const heatDays: {
		date: string;
		entries: { id: string; type: string }[];
	}[] = [{ date: model.newest.date, entries: model.newest.entries }];
	for (const pair of model.olderPairs) {
		heatDays.push({ date: pair.day.date, entries: olderDayEntries(pair) });
	}
	return heatDays;
}

// Whether a day falls in the month in view.
export function inMonth(model: PageModel, date: string): boolean {
	return (
		model.selectedMonth === null || date.slice(0, 7) === model.selectedMonth
	);
}
