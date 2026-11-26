// The contents sidebar: its titles and day rows, the entry being read, permalinks and the arrow keys.
import { readingLine } from "./comments.ts";
import { dayLabel, itemCount, shortDayLabel } from "./days.ts";
import { el, targetElement } from "./dom.ts";
import { iconSvg, menuIcon, withIcon } from "./icons.ts";
import { hrefId, type OlderDay, olderDayIds } from "./older-day.ts";
import { contentsGroups } from "./text.ts";
import type { Day, Entry } from "./types.ts";
import { typeset } from "./typeset.ts";

// One title in the contents: a link to the entry, a grey tag on the day's surprise paper and an icon on one added ad
// hoc. Its tooltip is the whole title, which a wide window's one-line list may cut with "…".
function contentsItem(entry: Entry) {
	const link = el(
		"a",
		{ href: `#${entry.id}`, title: entry.title },
		entry.title,
	);
	if (entry.type === "paper") typeset(link);
	const item = el("li", null, link);
	if (entry.pick === "surprise")
		item.append(" ", el("span", { class: "contents__tag" }, "Surprise"));
	if (entry.ad_hoc === true)
		item.append(
			" ",
			el(
				"span",
				{
					class: "contents__tag contents__tag--icon",
					role: "img",
					"aria-label": "Ad hoc",
					title: "Ad hoc",
				},
				iconSvg("adhoc"),
			),
		);
	return item;
}

// A day's titles: one box per group, holding the group's label and its list of links. The label sticks while its own
// group is in view (style.css), so each group is the label's containing block.
export function contentsTitles(entries: Entry[]) {
	return contentsGroups(entries).map((group) =>
		el(
			"div",
			{ class: "contents__section" },
			el("p", { class: "contents__group" }, group.label),
			el("ul", null, ...group.entries.map(contentsItem)),
		),
	);
}

// An older day in the contents: a row that folds and unfolds the day's <details> in the page,
// followed by that day's titles while it is open. `count` is its number of items, from the index for a day whose
// month isn't loaded (its titles are added when it loads).
function contentsDay(
	day: Day,
	details: HTMLDetailsElement,
	count: number,
): [HTMLButtonElement, HTMLDivElement] {
	const row = el(
		"button",
		{ type: "button", class: "contents__day", "aria-expanded": "false" },
		`${shortDayLabel(day.date)} · ${itemCount(count)}`,
	);
	const titles = el(
		"div",
		{ class: "contents__day-titles", hidden: "" },
		...contentsTitles(day.entries),
	);

	row.addEventListener("click", () => {
		details.open = !details.open;
		if (details.open) details.scrollIntoView({ block: "start" });
	});
	// The <details> decides. Its "toggle" event fires however it opened: this row, its own summary,
	// a permalink or the browser's find, so the row and its titles always agree with the page.
	details.addEventListener("toggle", () => {
		row.setAttribute("aria-expanded", String(details.open));
		titles.hidden = !details.open;
	});
	return [row, titles];
}

// Build the contents; each older pair gets its `row`.
export function renderContents(
	newest: Day,
	older: OlderDay[],
): HTMLDetailsElement {
	// Folds every older day in the page. Shown only while one is open, however it opened.
	const collapse = withIcon(
		el("button", { type: "button", class: "contents__collapse", hidden: "" }),
		"Collapse all",
	);
	collapse.addEventListener("click", () => {
		for (const pair of older) pair.details.open = false;
	});
	for (const pair of older) {
		pair.details.addEventListener("toggle", () => {
			collapse.hidden = !older.some((other) => other.details.open);
		});
	}

	// The button sits in a full-width box of its own, so the box can stay at the top of the list, opaque to its edges.
	const list = el(
		"div",
		{ class: "contents__list" },
		el("div", { class: "contents__top" }, collapse),
	);
	const box = el(
		"details",
		{ class: "contents__box" },
		el(
			"summary",
			{ class: "contents__summary" },
			// On a phone the bar shows the icon and keeps the name for screen readers (style.css).
			menuIcon("contents__icon"),
			el("span", { class: "contents__name" }, "Contents"),
			// The count is its own span, so a phone's bar can leave it out (style.css).
			el(
				"span",
				{ class: "contents__count" },
				` · ${itemCount(newest.entries.length)}`,
			),
		),
		list,
	);
	list.append(
		el(
			"div",
			{ class: "contents__newest" },
			el("p", { class: "contents__date" }, dayLabel(newest.date)),
			...contentsTitles(newest.entries),
		),
	);
	for (const pair of older) {
		const rowAndTitles = contentsDay(
			pair.day,
			pair.details,
			olderDayIds(pair).length,
		);
		pair.row = rowAndTitles[0]; // the Feed filter hides the row of a day with nothing to show
		pair.titles = rowAndTitles[1]; // filled when the day's month loads
		// The row and its titles share one box, so the row sticks while its own day is in view (style.css).
		list.append(
			el("div", { class: "contents__older" }, rowAndTitles[0], rowAndTitles[1]),
		);
	}

	// Wide windows show the contents as an open sidebar (Salience Document layout, its summary hidden);
	// narrow ones as one folded row. Follows window resizes.
	const WIDE = window.matchMedia("(min-width: 1080px)");
	function fitWidth() {
		box.open = WIDE.matches;
	}
	fitWidth();
	WIDE.addEventListener("change", fitWidth);

	// On a narrow window, a tapped title folds the list first, so the page then scrolls to where the entry ends up.
	box.addEventListener("click", (event) => {
		if (!WIDE.matches && targetElement(event).closest("a")) box.open = false;
	});

	// index.html has it.
	const contents = document.getElementById("contents");
	if (contents === null) throw new Error("index.html has no #contents");
	contents.append(box);
	return box;
}

// How far down from the top of the day list the headings that stay there reach for `link`: its group's label, which
// sits under its day's heading and "Collapse all" (style.css). Zero where nothing sticks, as in a narrow window.
function stuckHeadingsBottom(link: Element, list: Element) {
	const label = link
		.closest(".contents__section")
		?.querySelector(".contents__group");
	if (!label) return 0;
	const style = getComputedStyle(label);
	if (style.position !== "sticky") return 0;
	const inset = parseFloat(getComputedStyle(list).paddingTop);
	return inset + parseFloat(style.top) + label.getBoundingClientRect().height;
}

// Mark the contents link of the entry being read: the last visible entry whose title has passed the reading
// line, else the first visible entry. Entries in folded days, and entries the Feed filter hides, never count. The
// page lists each day in the contents' order, so the mark walks the contents top to bottom.
// An entry you jump to (a contents title or a permalink) stays marked until the page scrolls away from where
// the jump left it: near the end of a day the page can't scroll it up to the reading line.
// Returns `update`, which marks the entry being read now, for a change that moves entries without a scroll, and
// `collect`, which finds the entries and contents links again after a day's month has loaded.
export function trackCurrent(box: HTMLElement) {
	const list = box.querySelector(".contents__list"); // the day list, which scrolls on its own under the controls
	let linkById = new Map<string, HTMLAnchorElement>();
	let entries: HTMLElement[] = [];
	// The contents links by entry id, and the page's entries in order.
	function collect() {
		linkById = new Map<string, HTMLAnchorElement>();
		for (const link of box.querySelectorAll("a"))
			linkById.set(hrefId(link), link);
		entries = Array.from(
			document.querySelectorAll<HTMLElement>("main article.entry"),
		);
	}
	collect();
	let current: HTMLAnchorElement | null = null;
	// The entry jumped to, and its top once the jump's scroll is done.
	let jumpedTo: { entry: HTMLElement; landedTop: number | null } | null = null;

	function jump(entry: HTMLElement | null) {
		if (!entry || !linkById.has(entry.id)) return;
		const held: { entry: HTMLElement; landedTop: number | null } = {
			entry: entry,
			landedTop: null,
		};
		jumpedTo = held;
		update();
		// The browser scrolls to the entry after this runs, and a web font still loading moves the page again when it
		// arrives (measured: 80px when Manrope came after the first frame). Once the fonts loading now are in, a frame
		// later, note where the entry ended up. (A font that starts loading after this isn't waited for.)
		document.fonts.ready.then(() => {
			requestAnimationFrame(() => {
				held.landedTop = entry.getBoundingClientRect().top;
			});
		});
	}

	// The jumped-to entry until the page scrolls away from where the jump left it, else null.
	// Its top is compared rather than the scroll position: Chrome's scroll anchoring may shift the scroll
	// position when something above reflows, but it keeps the entry where it was.
	function heldEntry() {
		if (jumpedTo === null) return null;
		// An entry the Feed filter has since hidden isn't held: a hidden element's box reads 0, which can pass for "not moved".
		if (jumpedTo.entry.closest("[hidden]")) {
			jumpedTo = null;
			return null;
		}
		if (jumpedTo.landedTop === null) return jumpedTo.entry; // not landed yet: its scroll, or the fonts, are still on the way
		const moved = Math.abs(
			jumpedTo.entry.getBoundingClientRect().top - jumpedTo.landedTop,
		);
		if (moved > 1) {
			jumpedTo = null; // the reader has scrolled on
			return null;
		}
		return jumpedTo.entry;
	}

	// The top of an entry's title, in px from the top of the window.
	function titleTop(entry: Element) {
		// Every entry has a title.
		const title = entry.querySelector(".entry__title");
		if (title === null) throw new Error(`Entry ${entry.id} has no title`);
		return title.getBoundingClientRect().top;
	}

	// The entries of today and of unfolded days, less those the Feed filter hides, and all of them while Selected shows.
	// Chrome still lays out the entries of a closed <details> (measured in Chrome 153 and 154), so their boxes can't
	// tell a folded entry from a visible one.
	function unfoldedEntries() {
		return entries.filter(
			(entry) => !entry.closest("[hidden], details:not([open])"),
		);
	}

	function update() {
		const visible = unfoldedEntries();
		const first = visible[0];
		const last = visible[visible.length - 1];
		// Both are missing only when no entry is visible.
		if (first === undefined || last === undefined) return;
		let found = heldEntry();
		if (found === null) {
			const scrollRange =
				document.documentElement.scrollHeight - window.innerHeight;
			const line = readingLine(
				window.innerHeight,
				scrollRange,
				window.scrollY,
				titleTop(last),
			);
			found = first;
			// 1px of slack: at the very bottom the last title's top equals the line, give or take sub-pixel rounding.
			for (const entry of visible) {
				if (titleTop(entry) <= line + 1) found = entry;
			}
		}
		const link = linkById.get(found.id) || null;
		if (link === current) return;
		if (current) current.removeAttribute("aria-current");
		if (link) {
			link.setAttribute("aria-current", "true");
			keepInSidebarView(link);
		}
		current = link;
	}

	// When the day list is taller than its room under the controls it scrolls on its own; move only the list so the
	// marked link shows. (link.scrollIntoView would scroll the window as well.)
	function keepInSidebarView(link: Element) {
		// renderContents always draws the day list.
		if (list === null) throw new Error("The contents have no day list");
		if (list.scrollHeight <= list.clientHeight) return;
		if (link.getClientRects().length === 0) return; // inside a folded day: no position yet
		const listBox = list.getBoundingClientRect();
		const linkBox = link.getBoundingClientRect();
		const top = listBox.top + stuckHeadingsBottom(link, list);
		if (linkBox.top < top) list.scrollTop -= top - linkBox.top;
		if (linkBox.bottom > listBox.bottom)
			list.scrollTop += linkBox.bottom - listBox.bottom;
	}

	// A clicked title counts even when the hash doesn't change (the same title clicked twice).
	box.addEventListener("click", (event) => {
		const link = targetElement(event).closest("a");
		if (link) jump(document.getElementById(hrefId(link)));
	});
	window.addEventListener("hashchange", () => jump(hashTarget()));
	// Browsers fire "scroll" at most once per frame, just before painting, so update can run straight from it.
	window.addEventListener("scroll", update, { passive: true });
	// The left and right arrow keys go to the previous and next entry, in the page's order, which is the contents'
	// order, the way clicking its title does: the hash changes and the page jumps. Folded days are skipped. An arrow
	// with a modifier is left to the browser (Cmd+left arrow is Back on macOS).
	document.addEventListener("keydown", (event) => {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
		if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
			return;
		// In a comment box the arrows move the cursor; behind the open side panel the page stays where it is.
		if (
			targetElement(event).closest("textarea, input, select, [contenteditable]")
		)
			return;
		if (document.querySelector("dialog[open]")) return;
		update(); // the mark as of now: a scroll's own event, which updates it, may not have fired yet
		const visible = unfoldedEntries();
		const index = visible.findIndex(
			(entry) => linkById.get(entry.id) === current,
		);
		if (index === -1) return;
		let next = visible[index + 1];
		if (event.key === "ArrowLeft") next = visible[index - 1];
		if (!next) return; // already at the first or the last entry
		event.preventDefault();
		// Setting the hash to the value it already has does nothing, so an arrow back to the entry the hash names
		// goes there directly, the way a click on its title does.
		if (hashTarget() === next) {
			jump(next);
			next.scrollIntoView({ block: "start" });
			return;
		}
		location.hash = next.id;
	});
	// A day folding or unfolding moves everything below it without a scroll event. A link marked while its day
	// was folded (a permalink into that day) had no position then, so bring it into the sidebar's view now.
	for (const details of document.querySelectorAll("main details")) {
		details.addEventListener("toggle", () => {
			update();
			if (current) keepInSidebarView(current);
		});
	}
	jump(hashTarget());
	update();
	return { update: update, collect: collect };
}

// The ids the URL's #hash may name: as written, then decoded, since ids from web URLs may hold "%". A malformed
// escape ("#url:50%off") is kept as written only. None when there is no hash.
export function hashIds(): string[] {
	const raw = location.hash.slice(1);
	if (!raw) return [];
	let decoded = raw;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		/* malformed escape: keep the raw hash */
	}
	return [raw, decoded];
}

// The element named by the URL's #hash, or null.
export function hashTarget() {
	for (const id of hashIds()) {
		const found = document.getElementById(id);
		if (found) return found;
	}
	return null;
}

// A reload starts again from the top, as if the page were opened fresh: the browser doesn't restore the old scroll
// position, and the # that the arrow keys or a click left in the URL is dropped. Opening a permalink still jumps to it.
// How the page was opened comes from navigation.activation (Chrome 123, Safari 26.2, Firefox 147, per MDN); a browser
// without it keeps the old behaviour. (performance.getEntriesByType would tell too, but the tests' fake clock hides it.)
export function startReloadAtTop() {
	if (!window.navigation || !navigation.activation) return;
	if (navigation.activation.navigationType !== "reload") return;
	history.scrollRestoration = "manual"; // else Chrome restores the old position again after the scroll below
	// The setting stays with this history entry: hand it back on leaving, so Back to the page still restores the place.
	window.addEventListener("pagehide", () => {
		history.scrollRestoration = "auto";
	});
	if (location.hash)
		history.replaceState(null, "", location.pathname + location.search);
	// Chrome restores the old position after this script runs and before DOMContentLoaded (measured), so go to the
	// top once that has happened.
	document.addEventListener("DOMContentLoaded", () => window.scrollTo(0, 0), {
		once: true,
	});
}

// Open the folded day that holds #<entry id> and scroll to it.
export function openPermalink() {
	const target = hashTarget();
	if (!target) return;
	const day = target.closest("details");
	if (day) day.open = true;
	target.scrollIntoView({ block: "start" });
}
