// An older day in the page, and the ids its entries and its contents links carry.
import type { Day } from "./types.ts";

// An older day in the page: the day, its folded <details>, and its row and titles in the contents once
// renderContents adds them. A day of a month the page hasn't loaded has no entries yet: `ids` holds the index's ids
// of its entries until its month loads, and is null from then on. `indexEntries` holds those entries' ids and types
// for the heatmap, which counts papers only; it is empty for a day of the month loaded first. `error` is "Couldn't
// load this day" while shown.
export type OlderDay = {
	day: Day;
	details: HTMLDetailsElement;
	row?: HTMLElement;
	titles?: HTMLElement;
	month: string;
	ids: string[] | null;
	indexEntries: { id: string; type: string }[];
	error: HTMLElement | null;
};

// The ids and types of an older day's entries: the index's while its month isn't loaded, else those of the entries
// drawn.
export function olderDayEntries(
	pair: OlderDay,
): { id: string; type: string }[] {
	if (pair.ids !== null) {
		return pair.indexEntries;
	}
	return pair.day.entries;
}

// The ids of an older day's entries: the index's while its month isn't loaded, else those of the entries drawn.
export function olderDayIds(pair: OlderDay): string[] {
	if (pair.ids !== null) {
		return pair.ids;
	}
	return pair.day.entries.map((entry) => entry.id);
}

// The entry id a contents link points to: its href without the "#". Every contents link has an href.
export function hrefId(link: Element) {
	const href = link.getAttribute("href");
	if (href === null) throw new Error("A contents link has no href");
	return href.slice(1);
}
