// Links to an entry: opening the day that holds the entry named by the URL's #hash, in its month if it is an older one.
import { hashIds, hashTarget, openPermalink } from "./contents.ts";
import type { MonthLoader } from "./data.ts";
import type { OlderDay } from "./older-day.ts";
import { inMonth, type PageModel } from "./page-model.ts";

// What a link may need from the rest of the page: selecting a month, loading one, drawing it, and saying a day failed.
export type PermalinkDeps = {
	loadMonth: MonthLoader;
	selectMonth: (month: string | null) => Promise<void>;
	fillMonth: (month: string, monthLines: unknown[]) => void;
	showDayError: (pair: OlderDay) => void;
};

export function createPermalinks(model: PageModel, deps: PermalinkDeps) {
	// Follow #<entry id>: an entry already drawn opens at once; one the index places in an older month waits for that
	// month; an id in no digest is left alone.
	function followPermalink() {
		const target = hashTarget();
		if (target) {
			const pair = model.olderPairs.find((older) =>
				older.details.contains(target),
			);
			if (pair !== undefined && !inMonth(model, pair.day.date))
				void deps.selectMonth(pair.month);
			else if (
				model.newestSection.contains(target) &&
				!inMonth(model, model.newestDate)
			)
				void deps.selectMonth(model.newestDate.slice(0, 7));
			openPermalink();
			return;
		}
		const ids = hashIds();
		const pair = model.olderPairs.find(
			(older) => older.ids !== null && older.ids.some((id) => ids.includes(id)),
		);
		if (pair === undefined) return;
		if (!inMonth(model, pair.day.date)) void deps.selectMonth(pair.month);
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
				console.error(`${location.hash} not followed:`, error);
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
