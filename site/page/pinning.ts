// Which post a phone reader is on, so its title and buttons pin. Values are screen pixels.
import { el, targetElement } from "./dom.ts";

export type PostBox = {
	key: string;
	titleBottom: number;
	top: number;
	bottom: number;
	rowTop: number;
};

// The last post whose title is under the bar and whose end is below it, or null.
export function postBeingRead(
	posts: PostBox[],
	barBottom: number,
): number | null {
	let reading: number | null = null;
	for (const [index, post] of posts.entries()) {
		if (post.titleBottom <= barBottom && post.bottom > barBottom)
			reading = index;
	}
	return reading;
}

// How far the post's end pushes the pinned title up (0 or less).
export function pinnedTitleOffset(
	postBottom: number,
	barBottom: number,
	height: number,
): number {
	return Math.min(0, postBottom - (barBottom + height));
}

// Whether the post's own row is still below the pinned spot.
export function pinnedRow(
	post: PostBox | null,
	rowTop: number,
	viewportHeight: number,
	rowHeight: number,
): boolean {
	return post !== null && rowTop > viewportHeight - rowHeight;
}

// Whether a new post's pinned row slides up from below the screen.
export function slidesIn(
	previous: string | null,
	next: string | null,
	rowTop: number,
	viewportHeight: number,
): boolean {
	return next !== null && next !== previous && rowTop > viewportHeight;
}

// How far above the screen the observed band reaches, in px.
const BAND_ABOVE = 10_000_000;
// How long a new post's row takes to slide up, in ms.
const SLIDE_MS = 150;

// What pinning acts on: the page's entries in `main`, and the phone bar they scroll under.
export type PinParts = { main: HTMLElement; bar: HTMLElement };

// The box of a post on screen: the article, its title and, when it has one, its row of buttons.
function measure(article: HTMLElement): PostBox {
	const box = article.getBoundingClientRect();
	const title = article.querySelector(".entry__title");
	const rail = article.querySelector(".entry__rail");
	return {
		key: article.id,
		titleBottom:
			title === null ? box.top : title.getBoundingClientRect().bottom,
		top: box.top,
		bottom: box.bottom,
		rowTop: rail === null ? box.bottom : rail.getBoundingClientRect().top,
	};
}

// Pin the title and the button row of the post being read, found as ringDayInView finds the day; returns the row.
export function pinReading(parts: PinParts, signal: AbortSignal): HTMLElement {
	const title = el("div", {
		class: "pinned-title",
		"aria-hidden": "true",
		hidden: "",
	});
	title.inert = true;
	const text = el("span", { class: "pinned-title__text" });
	title.append(text);
	const row = el("div", {
		class: "pinned-row",
		"aria-hidden": "true",
		hidden: "",
	});
	document.body.append(title, row);

	const tracked = new Set<Element>();
	let line = 0; // the bar's bottom edge on screen
	let titleHeight = 0;
	let rowHeight = 0; // the pinned row's height, from style.css
	let reading: HTMLElement | null = null;
	let offset = Number.NaN; // where the pinned title was last put, NaN before it is put
	let shown: string | null = null; // the post whose buttons the row shows, or null while it is hidden
	let following: MutationObserver | null = null; // keeps the row like the shown post's own

	const articles = () =>
		Array.from(parts.main.querySelectorAll<HTMLElement>("article.entry"));

	// Show a copy of the post's rail in the row, out of the keyboard's way.
	const copyRail = (rail: Element) => {
		const copy = rail.cloneNode(true);
		if (!(copy instanceof HTMLElement)) return;
		for (const control of copy.querySelectorAll("button, a"))
			control.setAttribute("tabindex", "-1");
		const scrolled = row.firstElementChild?.scrollLeft ?? 0;
		row.replaceChildren(copy);
		copy.scrollLeft = scrolled;
	};

	const hideRow = () => {
		following?.disconnect();
		following = null;
		row.hidden = true;
		shown = null;
	};

	// Pin the post's row, sliding up when a new post takes over from below the screen.
	const pinRow = (post: PostBox, rail: Element) => {
		if (shown === post.key) return;
		const slides = slidesIn(shown, post.key, post.rowTop, window.innerHeight);
		following?.disconnect();
		copyRail(rail);
		following = new MutationObserver(() => copyRail(rail));
		following.observe(rail, {
			subtree: true,
			childList: true,
			attributes: true,
			characterData: true,
		});
		row.hidden = false;
		shown = post.key;
		if (slides && !matchMedia("(prefers-reduced-motion: reduce)").matches)
			row.animate([{ translate: "0 100%" }, { translate: "0 0" }], {
				duration: SLIDE_MS,
				easing: "cubic-bezier(0.2, 0, 0.2, 1)",
			});
	};

	// Put the pinned title where the reader's post leaves it, and the row where the post's own has not yet come.
	const follow = () => {
		if (reading === null) return;
		const post = measure(reading);
		const pushed = pinnedTitleOffset(post.bottom, line, titleHeight);
		if (pushed !== offset) {
			offset = pushed;
			title.style.transform = `translateY(${line + pushed}px)`;
		}
		const rail = reading.querySelector(".entry__rail");
		if (
			rail !== null &&
			pinnedRow(post, post.rowTop, window.innerHeight, rowHeight)
		)
			pinRow(post, rail);
		else if (shown !== null) hideRow();
	};

	// Find the post being read and show its title.
	const choose = () => {
		const found = articles();
		const index = postBeingRead(found.map(measure), line);
		const next = index === null ? null : (found[index] ?? null);
		if (next !== reading) {
			reading = next;
			offset = Number.NaN;
			showTitle();
			if (reading === null) hideRow();
		}
		follow();
	};

	const showTitle = () => {
		title.hidden = reading === null;
		if (reading === null) return;
		const source = reading.querySelector(".entry__title");
		if (source === null) return;
		text.replaceChildren(
			...Array.from(source.childNodes, (node) => node.cloneNode(true)),
		);
		titleHeight = title.offsetHeight;
	};

	const watch = () => {
		line =
			Number.parseFloat(getComputedStyle(parts.bar).top) +
			parts.bar.offsetHeight;
		rowHeight = Number.parseFloat(getComputedStyle(row).height);
		const observer = new IntersectionObserver(choose, {
			rootMargin: `${BAND_ABOVE}px 0px ${line - window.innerHeight}px 0px`,
			threshold: [0, 1],
		});
		for (const target of tracked) observer.observe(target);
		return observer;
	};
	const track = (article: HTMLElement) => {
		tracked.add(article);
		const heading = article.querySelector(".entry__title");
		if (heading !== null) tracked.add(heading);
	};
	for (const article of articles()) track(article);
	let observer = watch();

	// An older day drawn later brings posts the observer has not seen.
	const arrivals = new MutationObserver((records) => {
		let added = false;
		for (const record of records) {
			for (const node of record.addedNodes) {
				if (!(node instanceof Element)) continue;
				const found = node.matches("article.entry")
					? [node]
					: Array.from(node.querySelectorAll("article.entry"));
				for (const article of found) {
					if (!(article instanceof HTMLElement)) continue;
					track(article);
					added = true;
				}
			}
		}
		if (!added) return;
		observer.disconnect();
		observer = watch();
	});
	arrivals.observe(parts.main, { childList: true, subtree: true });

	// A press on a button of the row is a press on the same button of the post.
	row.addEventListener(
		"click",
		(event) => {
			const pressed = targetElement(event).closest("button");
			if (pressed === null || reading === null) return;
			const index = Array.from(row.querySelectorAll("button")).indexOf(pressed);
			reading
				.querySelectorAll<HTMLElement>(".entry__rail button")
				[index]?.click();
		},
		{ signal: signal },
	);

	window.addEventListener("scroll", follow, { passive: true, signal: signal });
	window.addEventListener(
		"resize",
		() => {
			observer.disconnect();
			observer = watch();
			choose();
		},
		{ signal: signal },
	);
	signal.addEventListener("abort", () => {
		observer.disconnect();
		arrivals.disconnect();
		following?.disconnect();
		title.remove();
		row.remove();
	});
	return row;
}
