// The Feed narrowed to the entries the Search sentence shows: the rest are hidden in the page and in the contents.
import { el } from "./dom.ts";
import { hrefId, type OlderDay, olderDayIds } from "./older-day.ts";
import type { Day } from "./types.ts";

// The entries and contents the sentence narrows.
export type FilterLayout = {
	main: HTMLElement;
	newest: Day;
	newestSection: HTMLElement;
	older: OlderDay[];
	contents: HTMLElement;
	onFilter: () => void;
};

// What createFeedFilter hands the page: `show` narrows the Feed to `shown`, and again whenever a month has drawn more
// entries. A narrowed sentence unfolds the days that hold what it shows; the days are folded as they were once it
// isn't narrowed any more. `reset` is what the "Nothing matches" note's button does.
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

	// Every element hidden here is an HTML element of the page.
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

		// Entries, by their element id, which is the entry's id; their titles in the contents, by the link's "#<id>".
		for (const article of layout.main.querySelectorAll("article.entry")) {
			if (!shownNow.has(article.id)) hide(article);
		}
		for (const link of layout.contents.querySelectorAll("li > a")) {
			if (!shownNow.has(hrefId(link))) hide(link.parentElement);
		}
		// A group's list with no title left goes, with the group's label just before it.
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
		// An older day is judged by its ids, which for a month not drawn yet are the index's. A day shown opens when the
		// sentence is narrowed, or when its month isn't drawn yet, which opening draws.
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

	// Again, as the last sentence says: a month has drawn entries the filter hasn't seen.
	function refresh() {
		apply();
	}

	return { show, refresh };
}
