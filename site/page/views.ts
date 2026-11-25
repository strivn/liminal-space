// The Selected, Feed and Logs views: the menu under the date and which one shows.
import { el } from "./dom.ts";
import { openingView, VIEW_NAMES, type View } from "./selected.ts";

// Each view's box in index.html.
const BOXES: Record<View, string> = {
	selected: "selected-view",
	feed: "digests",
	logs: "logs-view",
};

// Draw the menu and follow the address as it changes (a click on the menu, Back, a link to #selected), before the
// Feed's own listeners, so an entry's link finds the Feed showing. `showOpening` shows the view the address opens.
// Only the view shown has its box in the page; `onShow` draws it. The Feed's scroll position is kept while another
// view shows.
export function createViews(
	owner: boolean,
	onShow: (view: View) => void,
): { showOpening: () => void } {
	const views: View[] = owner
		? ["selected", "feed", "logs"]
		: ["selected", "feed"];
	const page = document.getElementById("page");
	const menu = document.getElementById("views");
	if (page === null || menu === null)
		throw new Error("index.html has no #page or #views");
	const boxes = new Map<View, HTMLElement>();
	for (const view of views) {
		const box = document.getElementById(BOXES[view]);
		if (box === null) throw new Error(`index.html has no #${BOXES[view]}`);
		boxes.set(view, box);
	}
	const links = new Map<View, HTMLAnchorElement>();
	for (const view of views) {
		const link = el("a", { href: `#${view}` }, VIEW_NAMES[view]);
		links.set(view, link);
		menu.append(el("li", null, link));
	}
	let showing: View | null = null;
	let feedScroll = 0;
	// The skip link names the Feed; while another view shows it moves focus to that view instead, since its address
	// would open the Feed.
	document
		.querySelector<HTMLAnchorElement>(".skip-link")
		?.addEventListener("click", (event) => {
			if (showing === null || showing === "feed") return;
			event.preventDefault();
			boxes.get(showing)?.focus();
		});

	function show(view: View) {
		if (view === showing) return;
		if (showing === "feed") feedScroll = document.documentElement.scrollTop;
		const first = showing === null;
		showing = view;
		for (const [name, box] of boxes)
			box.toggleAttribute("hidden", name !== view);
		page?.classList.toggle("page--selected", view === "selected");
		page?.classList.toggle("page--logs", view === "logs");
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
