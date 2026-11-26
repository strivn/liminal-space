// Links to an entry: opening the day that holds the entry named by the URL's #hash, in its month if it is an older one.
import { hashIds, hashTarget, openPermalink } from "./contents.ts";
import type { MonthLoader } from "./data.ts";
import type { OlderDay } from "./older-day.ts";
import type { PageModel } from "./page-model.ts";

// What a link may need from the rest of the page: whether the Search sentence shows an entry, showing the sentence's
// month of a day, loading a month, drawing it, and saying a day failed.
export type PermalinkDeps = {
	loadMonth: MonthLoader;
	isShown: (id: string) => boolean;
	showDay: (date: string) => void;
	fillMonth: (month: string, monthLines: unknown[]) => void;
	showDayError: (pair: OlderDay) => void;
};

export function createPermalinks(model: PageModel, deps: PermalinkDeps) {
	// Follow #<entry id>: an entry already drawn opens at once; one the index places in an older month waits for that
	// month; an id in no digest is left alone. An entry the sentence doesn't show brings its day's month back.
	function followPermalink() {
		const target = hashTarget();
		if (target) {
			const date = target.closest<HTMLElement>("[data-date]")?.dataset.date;
			if (date !== undefined && !deps.isShown(target.id)) deps.showDay(date);
			openPermalink();
			return;
		}
		const ids = hashIds();
		const pair = model.olderPairs.find(
			(older) => older.ids !== null && older.ids.some((id) => ids.includes(id)),
		);
		if (pair === undefined) return;
		const id = pair.ids?.find((own) => ids.includes(own));
		if (id !== undefined && !deps.isShown(id)) deps.showDay(pair.day.date);
		deps
			.loadMonth(pair.month)
			.then(
				(monthLines) => {
					deps.fillMonth(pair.month, monthLines);
					openPermalink();
				},
				// Opening the day tries its month once more and, if that fails too, says so under its row.
				() => {
					pair.details.open = true;
				},
			)
			// The month loaded but couldn't be drawn: say so under the day's row, and open the day to show it.
			.catch((error) => {
				console.error("%s not followed:", location.hash, error);
				deps.showDayError(pair);
				pair.details.open = true;
			});
	}

	// Follow the link the page was opened with, then each link followed after it.
	function start() {
		followPermalink();
		window.addEventListener("hashchange", followPermalink);
	}

	return { followPermalink: followPermalink, start: start };
}
