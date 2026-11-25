// The Feed and Selected views: the menu under the date and which of the two shows.
import { el } from "./dom.ts";
import { openingView, VIEW_NAMES, type View } from "./selected.ts";

const VIEWS: View[] = ["feed", "selected"];

// Draw the menu and follow the address as it changes (a click on the menu, Back, a link to #selected), before the
// Feed's own listeners, so an entry's link finds the Feed showing. `showOpening` shows the view the address opens.
// Only the view shown has its box in the page; `onShow` draws it. The Feed's scroll position is kept while Selected
// shows.
export function createViews(
	owner: boolean,
	onShow: (view: View) => void,
): { showOpening: () => void } {
	const page = document.getElementById("page");
	const feed = document.getElementById("digests");
	const selected = document.getElementById("selected-view");
	const menu = document.getElementById("views");
	if (page === null || feed === null || selected === null || menu === null)
		throw new Error(
			"index.html has no #page, #digests, #selected-view or #views",
		);
	const links = new Map<View, HTMLAnchorElement>();
	for (const view of VIEWS) {
		const link = el("a", { href: `#${view}` }, VIEW_NAMES[view]);
		links.set(view, link);
		menu.append(el("li", null, link));
	}
	let showing: View | null = null;
	let feedScroll = 0;

	function show(view: View) {
		if (view === showing) return;
		if (showing === "feed") feedScroll = document.documentElement.scrollTop;
		const first = showing === null;
		showing = view;
		feed?.toggleAttribute("hidden", view !== "feed");
		selected?.toggleAttribute("hidden", view !== "selected");
		page?.classList.toggle("page--selected", view === "selected");
		for (const [name, link] of links) {
			if (name === view) link.setAttribute("aria-current", "page");
			else link.removeAttribute("aria-current");
		}
		onShow(view);
		if (!first)
			document.documentElement.scrollTop = view === "feed" ? feedScroll : 0;
	}

	window.addEventListener("hashchange", () =>
		show(openingView(location.hash, owner)),
	);
	return { showOpening: () => show(openingView(location.hash, owner)) };
}
