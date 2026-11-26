// Hides what the Search sentence doesn't show.
import { el } from "./dom.ts";
import { hrefId, type OlderDay, olderDayIds } from "./older-day.ts";
import type { Day } from "./types.ts";

// What the filter acts on.
export type FilterLayout = {
	main: HTMLElement;
	newest: Day;
	newestSection: HTMLElement;
	older: OlderDay[];
	contents: HTMLElement;
	onFilter: () => void;
};

// A narrowed sentence unfolds the days it shows.
export function createFeedFilter(layout: FilterLayout, reset: () => void) {
	let hidden: HTMLElement[] = [];
	let openBefore: boolean[] | null = null;
	let emptyNote: HTMLElement | null = null;
	let shownNow: ReadonlySet<string> = new Set();
	let narrowedNow = false;

	function restoreOpen() {
		const saved = openBefore;
		if (saved === null) return;
		layout.older.forEach((pair, i) => {
			pair.details.open = Boolean(saved[i]);
		});
		openBefore = null;
	}

	// Hide an element, remembered.
	function hide(element: Element | null | undefined) {
		if (!(element instanceof HTMLElement))
			throw new Error("The Feed filter can't hide a missing element");
		element.hidden = true;
		hidden.push(element);
	}

	function apply() {
		for (const element of hidden) element.hidden = false;
		hidden = [];
		if (emptyNote !== null) emptyNote.remove();
		emptyNote = null;
		if (narrowedNow && openBefore === null)
			openBefore = layout.older.map((pair) => pair.details.open);
		if (!narrowedNow) restoreOpen();

		// Entries and their contents titles.
		for (const article of layout.main.querySelectorAll("article.entry")) {
			if (!shownNow.has(article.id)) hide(article);
		}
		for (const link of layout.contents.querySelectorAll("li > a")) {
			if (!shownNow.has(hrefId(link))) hide(link.parentElement);
		}
		// Empty groups go.
		for (const list of layout.contents.querySelectorAll("ul")) {
			const titleShown = [...list.children].some(
				(item) => !(item instanceof HTMLElement) || !item.hidden,
			);
			if (!titleShown) {
				hide(list);
				hide(list.previousElementSibling);
			}
		}
		let anyShown = layout.newest.entries.some((entry) =>
			shownNow.has(entry.id),
		);
		if (!anyShown) {
			hide(layout.newestSection);
			hide(layout.contents.querySelector(".contents__date"));
		}
		// Older days, judged by ids.
		for (const pair of layout.older) {
			if (olderDayIds(pair).some((id) => shownNow.has(id))) {
				anyShown = true;
				if (narrowedNow || pair.ids !== null) pair.details.open = true;
			} else {
				if (narrowedNow) pair.details.open = false;
				hide(pair.details);
				hide(pair.row);
			}
		}
		if (!anyShown) {
			const button = el(
				"button",
				{ type: "button", class: "linklike" },
				"Reset",
			);
			button.addEventListener("click", reset);
			emptyNote = el(
				"p",
				{ class: "empty search__empty" },
				"Nothing matches. ",
				button,
			);
			layout.main.prepend(emptyNote);
		}
		layout.onFilter();
	}

	function show(shown: ReadonlySet<string>, narrowed: boolean) {
		shownNow = shown;
		narrowedNow = narrowed;
		apply();
	}

	// Apply again after a month draws.
	function refresh() {
		apply();
	}

	return { show, refresh };
}
