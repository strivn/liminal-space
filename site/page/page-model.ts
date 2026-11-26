// What the pieces of the drawn page share: the newest day, the older days and the header's warning.
import { type OlderDay, olderDayEntries } from "./older-day.ts";
import type { Day, Skipped } from "./types.ts";

// `skipped` and `warning` are what the header says was left out.
export type PageModel = {
	newest: Day;
	newestSection: HTMLElement;
	newestDate: string;
	today: string;
	olderPairs: OlderDay[];
	header: HTMLElement;
	skipped: Skipped[];
	warning: HTMLElement | null;
};

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
