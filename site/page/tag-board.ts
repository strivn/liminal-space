// The tag toggles, the tag and read chips, and the filter they apply to the page.
import type { TagName, TagsChange } from "../../shared/owner-protocol.ts";
import { el } from "./dom.ts";
import { iconSvg, type RailIcon, railToggles } from "./icons.ts";
import { hrefId, type OlderDay, olderDayIds } from "./older-day.ts";
import { type Sender, sendOrRollBack } from "./owner.ts";
import {
	clearTag,
	copyTags,
	entryTagsOf,
	matchesRead,
	matchesTags,
	noFilteredEntriesText,
	READ_CHIP_LABELS,
	READ_CHIPS,
	type ReadChip,
	readChipCounts,
	setTag,
	TAG_LABELS,
	TAG_NAMES,
	tagCounts,
	takeSiteState,
	toggleTag,
} from "./state.ts";
import type { Day, Entry, ReadState, Tags } from "./types.ts";

// The entries and contents the chips narrow inside the selected months.
type FilterLayout = {
	main: HTMLElement;
	newest: Day;
	newestSection: HTMLElement;
	older: OlderDay[];
	contents: HTMLElement;
	onFilter: () => void;
};

// What createTagBoard hands the rest of the page.
export type TagBoard = {
	toggles: (entry: Entry) => HTMLElement;
	clear: (id: string, name: TagName) => void;
	chips: HTMLElement[];
	showCounts: () => void;
	start: (layout: FilterLayout) => void;
	clearFilters: () => void;
	refresh: () => void;
	replace: (fresh: Tags) => void;
};

// The next-action tags on every entry, the two tag chips that show only tagged entries, and the three read chips
// under them that show only entries read that deep; tag and read chips together show entries that match both.
// `countedEntries` gives the loaded entries in the selected months;
// `readState` is the page's read state, which the read toggles change in place (showCounts redraws the counts after a
// press). `saved` is the site's tags; each press goes to the site through `sender`, and one the site refuses is
// undone and `notice` says so. Like the comment board: toggles(entry) while the entries are drawn, `chips` (the two
// rows) goes in the contents, and start(layout) runs once the days and the contents are in the page.
export function createTagBoard(
	countedEntries: () => { id: string; type: string; ad_hoc?: unknown }[],
	readState: ReadState,
	saved: Tags,
	sender: Sender,
	notice: (text: string) => void,
): TagBoard {
	// The page's tags, changed at once by a press, and the tags the site is known to hold, for undoing a refused one.
	// Both are replaced when the site's state is read again. The functions below read whichever is current, like a
	// `nonlocal` in Python.
	let tags = copyTags(saved);
	let siteTags = copyTags(saved);
	const views: (() => void)[] = []; // each entry's toggle redraw
	let presses = 0; // tag presses sent since the page opened
	const lastPress = new Map<string, number>(); // "<tag> <entry id>" -> the number of its last press

	// One chip per tag, in TAG_NAMES order, off on load: the filter isn't saved. showCounts writes their text.
	const tagChips = TAG_NAMES.map((name) => ({
		name: name,
		button: el("button", {
			type: "button",
			class: "tag-chip",
			"aria-pressed": "false",
		}),
	}));
	// The read chips, in READ_CHIPS order, off on load too. At most one is on.
	const readChips = READ_CHIPS.map((name) => ({
		name: name,
		button: el("button", {
			type: "button",
			class: "read-chip",
			"aria-pressed": "false",
		}),
	}));
	const originChip = el("button", {
		type: "button",
		class: "tag-chip",
		"aria-pressed": "false",
	});
	// Two rows of three: the two tag chips and the ad hoc chip, then the read chips. The first row is still called
	// tag-filter, though the ad hoc chip filters by origin, not by tag.
	const chips = [
		el(
			"div",
			{ class: "tag-filter" },
			...tagChips.map((chip) => chip.button),
			originChip,
		),
		el(
			"div",
			{ class: "read-filter" },
			...readChips.map((chip) => chip.button),
		),
	];
	// A chip clicked with the mouse keeps the mouse over it, and its name would stay up over the month selector: the
	// name goes until the mouse leaves. A press from the keyboard (detail 0) keeps it, since focus is what shows it.
	for (const button of [
		...tagChips.map((chip) => chip.button),
		originChip,
		...readChips.map((chip) => chip.button),
	]) {
		button.addEventListener("click", (event) => {
			if (event.detail > 0) button.classList.add("chip--clicked");
		});
		button.addEventListener("mouseleave", () =>
			button.classList.remove("chip--clicked"),
		);
	}
	// The chips that are on: the filter is these variables, and drawChips shows them as aria-pressed.
	const tagsOn = new Set<TagName>();
	let readOn: ReadChip | null = null;
	let adHocOn = false;
	let filtered: HTMLElement[] = []; // every element the filter hid, shown again when the filter changes
	let openBefore: boolean[] | null = null; // each older day's open state from before the first chip went on, while any chip is on
	let emptyNote: HTMLElement | null = null; // "No entries are tagged ..." while nothing matches
	let shown = new Set<string>(); // the ids the chips matched at the last press: what shows while a chip is on
	let filterLayout: FilterLayout | null = null; // the active layout, for scope changes and clearing chips

	// "To read (5)" and "Learn first (3)": the entries carrying each tag; "Unread (12)", "Abstract (3)" and
	// "Paper (1)": the entries read that deep, within the selected months.
	function showCounts() {
		const entries = countedEntries();
		showFilter(
			originChip,
			"Ad hoc",
			"adhoc",
			entries.filter((entry) => entry.ad_hoc === true).length,
		);
		const counts = tagCounts(entries, tags);
		for (const chip of tagChips)
			showFilter(
				chip.button,
				TAG_LABELS[chip.name],
				chip.name,
				counts[chip.name],
			);
		const readCounts = readChipCounts(entries, readState);
		for (const chip of readChips)
			showFilter(
				chip.button,
				READ_CHIP_LABELS[chip.name],
				chip.name,
				readCounts[chip.name],
			);
	}

	// A filter shows the entry rail's icon and its count. Its name, "Unread (12)", is what screen readers read, and
	// shows in a label above the button on hover or focus (style.css). Both spans are hidden from screen readers,
	// which read aria-label instead.
	function showFilter(
		button: HTMLButtonElement,
		label: string,
		icon: RailIcon,
		count: number,
	) {
		const name = `${label} (${count})`;
		button.replaceChildren(
			iconSvg(icon),
			el(
				"span",
				{ class: "filter-count", "aria-hidden": "true" },
				String(count),
			),
			el("span", { class: "filter-label", "aria-hidden": "true" }, name),
		);
		button.setAttribute("aria-label", name);
	}

	// Every tag toggle and both chip counts show the tags as they are now.
	function redraw() {
		for (const showPressed of views) showPressed();
		showCounts();
	}

	// Send one tag of an entry as it now is; the site leaves the entry's other tag as it holds it. When the site doesn't
	// save it, and this was the last press of that tag on that entry, the tag goes back to what the site holds, and
	// the page says why.
	function send(id: string, name: TagName) {
		const change: TagsChange = {
			id: id,
			tag: name,
			on: matchesTags(tags, id, [name]),
		};
		presses += 1;
		const press = presses;
		const pressKey = `${name} ${id}`;
		lastPress.set(pressKey, press);
		sendOrRollBack(
			sender,
			"tags",
			id,
			change,
			{
				// The site now holds what this press sent.
				stored: () => setTag(siteTags, id, name, change.on),
				superseded: () => lastPress.get(pressKey) !== press,
				rollBack: () => {
					setTag(tags, id, name, matchesTags(siteTags, id, [name]));
					redraw();
				},
			},
			notice,
			"A tag change not drawn:",
		);
	}

	// Take the site's tags as the page's own; an entry with a press still on its way keeps what the page shows.
	function replace(fresh: Tags) {
		tags = takeSiteState(
			fresh,
			tags,
			(id) => sender.pending("tags", id),
			entryTagsOf,
		);
		siteTags = copyTags(fresh);
		redraw();
	}

	// To read and Learn first, the icon rail's last group, after the read toggles. A press shows at once, goes to the
	// site, and redraws.
	function toggles(entry: Entry) {
		const tagToggles = TAG_NAMES.map((name) => ({
			icon: name,
			name: TAG_LABELS[name],
			// A toggle is pressed when the entry carries its tag.
			pressed: () => matchesTags(tags, entry.id, [name]),
			press: () => {
				toggleTag(tags, entry.id, name);
				send(entry.id, name);
				redraw();
			},
		}));
		return railToggles(tagToggles, views);
	}

	// Turn one tag off an entry, sent at once. Nothing is sent when it was already off.
	function clear(id: string, name: TagName) {
		if (!matchesTags(tags, id, [name])) return;
		clearTag(tags, id, name);
		send(id, name);
		redraw();
	}

	// Every chip shows whether it is on.
	function drawChips() {
		for (const chip of tagChips)
			chip.button.setAttribute("aria-pressed", String(tagsOn.has(chip.name)));
		for (const chip of readChips)
			chip.button.setAttribute("aria-pressed", String(readOn === chip.name));
		originChip.setAttribute("aria-pressed", String(adHocOn));
	}

	// The tags whose chips are on, in TAG_NAMES order.
	function chipsOn() {
		return TAG_NAMES.filter((name) => tagsOn.has(name));
	}

	// Whether an entry id shows under the chips that are on now: it carries every tag on and is read as the read chip.
	function filterMatch() {
		const on = chipsOn();
		const origins = new Set(
			countedEntries()
				.filter((entry) => entry.ad_hoc === true)
				.map((entry) => entry.id),
		);
		// A read chip is about papers, so an id no counted entry has matches none.
		const entryOf = new Map(countedEntries().map((entry) => [entry.id, entry]));
		const readMatches = (id: string) => {
			if (readOn === null) return true;
			const entry = entryOf.get(id);
			return entry !== undefined && matchesRead(readState, entry, readOn);
		};
		return (id: string) =>
			(!adHocOn || origins.has(id)) &&
			matchesTags(tags, id, on) &&
			readMatches(id);
	}

	// Snapshot the chip matches until the next filter or month change.
	function filterEntries(layout: FilterLayout) {
		const noChipOn = tagsOn.size === 0 && readOn === null && !adHocOn;
		const showsId = filterMatch();
		// What shows is decided from the selected months, then kept until a scope or chip change.
		shown = new Set<string>();
		for (const entry of countedEntries()) {
			if (showsId(entry.id)) shown.add(entry.id);
		}
		// Month selection alone loads data; a filter never reaches outside the selected months.
		if (noChipOn) shown.clear();
		applyFilter(layout);
	}

	// Each older day open or folded as it was before the first chip went on.
	function restoreOpen(older: OlderDay[]) {
		const saved = openBefore;
		if (saved === null) return;
		older.forEach((pair, i) => {
			// Boolean() as the open setter does; every older day has a saved state.
			pair.details.open = Boolean(saved[i]);
		});
		openBefore = null;
	}

	// Show only the entries the last chip press matched (`shown`: carrying every tag whose chip is on and read as deep
	// as the read chip that is on), inside the selected months, and only their titles in the contents; unfold the older days
	// that hold one. With no chip on, the page is as it was before the filter. A tag or read toggle pressed while
	// filtering changes the counts, not what shows: only a chip press changes `shown`.
	function applyFilter(layout: FilterLayout) {
		// Start again from the page as it is without the filter.
		for (const element of filtered) element.hidden = false;
		filtered = [];
		if (emptyNote) emptyNote.remove();
		emptyNote = null;
		const on = chipsOn();
		if (on.length === 0 && readOn === null && !adHocOn) {
			restoreOpen(layout.older);
			layout.onFilter();
			return;
		}
		if (openBefore === null)
			openBefore = layout.older.map((pair) => pair.details.open);

		// Every element hidden here is an HTML element of the page.
		function hide(element: Element | null | undefined) {
			if (!(element instanceof HTMLElement))
				throw new Error("The tag filter can't hide a missing element");
			element.hidden = true;
			filtered.push(element);
		}
		const showsId = (id: string) => shown.has(id);
		function shows(entry: Entry) {
			return showsId(entry.id);
		}
		// Entries, by their element id, which is the entry's id; their titles in the contents, by the link's "#<id>".
		for (const article of layout.main.querySelectorAll("article.entry")) {
			if (!showsId(article.id)) hide(article);
		}
		for (const link of layout.contents.querySelectorAll("li > a")) {
			if (!showsId(hrefId(link))) hide(link.parentElement);
		}
		// A group's list with no title left goes, with the group's label just before it.
		for (const list of layout.contents.querySelectorAll("ul")) {
			let titleShown = false;
			for (const item of list.children) {
				// Only an HTML element has .hidden; anything else counts as shown.
				if (!(item instanceof HTMLElement) || !item.hidden) titleShown = true;
			}
			if (!titleShown) {
				hide(list);
				hide(list.previousElementSibling);
			}
		}
		// Days: the newest one, with its date in the contents, goes when nothing in it shows; an older one unfolds
		// when something in it shows, and goes with its contents row when nothing does.
		let entryShown = layout.newest.entries.some(shows);
		if (!entryShown) {
			hide(layout.newestSection);
			hide(layout.contents.querySelector(".contents__date"));
		}
		// An older day is judged by its ids, which for a month that couldn't be loaded are the index's.
		for (const pair of layout.older) {
			if (pair.details.classList.contains("month-hidden")) continue;
			// A failed selected month has unknown matches: keep its error and retry control visible.
			if (pair.ids !== null) {
				pair.details.open = true;
				continue;
			}
			if (olderDayIds(pair).some(showsId)) {
				pair.details.open = true;
				entryShown = true;
			} else {
				// Fold it too, so "Collapse all" and its contents titles don't stay out for a day that isn't shown;
				// restoreOpen puts it back as it was when the last chip turns off.
				pair.details.open = false;
				hide(pair.details);
				hide(pair.row);
			}
		}
		if (!entryShown) {
			emptyNote = el(
				"p",
				{ class: "empty tag-filter__empty" },
				adHocOn
					? on.length === 0 && readOn === null
						? "No ad hoc entries"
						: "No entries match the filters"
					: noFilteredEntriesText(on, readOn),
			);
			layout.main.prepend(emptyNote);
		}
		layout.onFilter();
	}

	// Scope changes rebuild matches and counts without changing which chips are pressed.
	function refresh() {
		showCounts();
		if (filterLayout !== null) filterEntries(filterLayout);
	}
	function clearFilters() {
		tagsOn.clear();
		readOn = null;
		adHocOn = false;
		drawChips();
		refresh();
	}

	// `layout`: { main, newest: the newest day, newestSection: its <section>, older: the older days' pairs of day,
	// <details> and contents row, contents: the contents' <details> box, onFilter: called after each filter change }.
	function start(layout: FilterLayout) {
		filterLayout = layout;
		originChip.addEventListener("click", () => {
			adHocOn = !adHocOn;
			drawChips();
			filterEntries(layout);
		});
		for (const chip of tagChips) {
			chip.button.addEventListener("click", () => {
				if (tagsOn.has(chip.name)) tagsOn.delete(chip.name);
				else tagsOn.add(chip.name);
				drawChips();
				filterEntries(layout);
			});
		}
		// A read chip turns the other read chips off as it goes on.
		for (const chip of readChips) {
			chip.button.addEventListener("click", () => {
				if (readOn === chip.name) readOn = null;
				else readOn = chip.name;
				drawChips();
				filterEntries(layout);
			});
		}
	}

	showCounts();
	return {
		toggles: toggles,
		clear: clear,
		chips: chips,
		showCounts: showCounts,
		start: start,
		clearFilters: clearFilters,
		refresh: refresh,
		replace: replace,
	};
}
