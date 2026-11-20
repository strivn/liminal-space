// @vitest-environment jsdom
// Reading on a phone (site/page/pinning.ts): which post's title and buttons pin.
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	type PostBox,
	pinnedRow,
	pinnedTitleOffset,
	pinReading,
	postBeingRead,
	slidesIn,
} from "../../site/page/pinning.ts";

const BAR = 100;

// A post whose box starts at `top` and is `height` tall; its title is 40px high at the top, so its bottom is top + 40.
function post(key: string, top: number, height: number): PostBox {
	return {
		key: key,
		titleBottom: top + 40,
		top: top,
		bottom: top + height,
		rowTop: top + height - 60,
	};
}

describe("the post being read", () => {
	test("no post is being read before any title reaches the bar", () => {
		// The first title's bottom is at 160, still below the bar's bottom at 100.
		const posts = [post("a", 120, 500), post("b", 640, 500)];
		expect(postBeingRead(posts, BAR)).toBeNull();
	});

	test("the post whose title went under the bar is being read", () => {
		const posts = [post("a", 30, 500), post("b", 550, 500)];
		expect(postBeingRead(posts, BAR)).toBe(0);
	});

	test("a post whose end passed the bar is no longer being read", () => {
		// The post's title is far above the bar, and its end is at the bar's bottom edge or above it.
		expect(postBeingRead([post("a", -400, 500)], BAR)).toBeNull();
		expect(postBeingRead([post("a", -500, 500)], BAR)).toBeNull();
		expect(postBeingRead([post("a", -399, 500)], BAR)).toBe(0);
	});

	test("in the gap between two posts, no post is being read", () => {
		const posts = [post("a", -400, 480), post("b", 100, 500)];
		expect(postBeingRead(posts, BAR)).toBeNull();
	});

	test("the pinned title is pushed up by its post's end", () => {
		const height = 34;
		// The end is far below the bar: nothing pushes. The end 10px under the title's slot pushes it up by the rest.
		expect(pinnedTitleOffset(400, BAR, height)).toBe(0);
		expect(pinnedTitleOffset(BAR + height, BAR, height)).toBe(0);
		expect(pinnedTitleOffset(BAR + height - 10, BAR, height)).toBe(-10);
		expect(pinnedTitleOffset(BAR, BAR, height)).toBe(-height);
	});
});

describe("the pinned button row", () => {
	const SCREEN = 956;
	const ROW = 61;
	// The pinned row's top edge: the spot where a post's own row takes over.
	const SPOT = SCREEN - ROW;

	test("a long post's row pins while its own row is below the screen", () => {
		const long = post("a", 0, 3000);
		expect(pinnedRow(long, long.rowTop, SCREEN, ROW)).toBe(true);
		// Part of its own row is on screen but still below the pinned spot.
		expect(pinnedRow(long, SPOT + 1, SCREEN, ROW)).toBe(true);
	});

	test("the pinned row goes once the post's own row scrolls up to where the pinned row sits", () => {
		const long = post("a", 0, 3000);
		expect(pinnedRow(long, SPOT, SCREEN, ROW)).toBe(false);
		expect(pinnedRow(long, 300, SCREEN, ROW)).toBe(false);
	});

	test("a short post pins no row", () => {
		// The title has just gone under the bar, and the whole 480px post, its row too, is already on screen.
		const short = post("a", 30, 480);
		expect(pinnedRow(short, short.rowTop, SCREEN, ROW)).toBe(false);
		expect(pinnedRow(null, SCREEN + 500, SCREEN, ROW)).toBe(false);
	});

	test("a new post's row slides in", () => {
		expect(slidesIn(null, "b", SCREEN + 400, SCREEN)).toBe(true);
		expect(slidesIn("a", "b", SCREEN + 400, SCREEN)).toBe(true);
	});

	test("the pinned row appears without sliding when scrolling back up past the post's own row, or when the post stays the same", () => {
		// Scrolling up, the post's own row leaves the pinned spot and the pinned row takes its place.
		expect(slidesIn(null, "a", SPOT + 1, SCREEN)).toBe(false);
		// The same post staying pinned is no new post.
		expect(slidesIn("a", "a", SCREEN + 400, SCREEN)).toBe(false);
		expect(slidesIn("a", null, SCREEN + 400, SCREEN)).toBe(false);
	});
});

describe("the pinned title and row in the page", () => {
	let pinning: AbortController | null = null;
	afterEach(() => {
		pinning?.abort();
		pinning = null;
		vi.unstubAllGlobals();
		document.body.replaceChildren();
		document.head.replaceChildren();
	});

	// One long post, 3000px tall, whose title is under the bar and whose own row is below the screen; the observer's
	// callback is returned, as the browser calls it when a post crosses the bar.
	function longPost() {
		const watchers: (() => void)[] = [];
		// A reader who asked for less motion: the row appears without sliding in.
		vi.stubGlobal("matchMedia", () => ({ matches: true }));
		vi.stubGlobal(
			"IntersectionObserver",
			class {
				constructor(callback: () => void) {
					watchers.push(callback);
				}
				observe() {}
				disconnect() {}
			},
		);
		document.head.innerHTML = "<style>.pinned-row { height: 61px }</style>";
		const bar = document.createElement("div");
		bar.style.top = "0px";
		const main = document.createElement("main");
		main.innerHTML = `<article class="entry" id="long">
			<h3 class="entry__title">A long <em>post</em></h3>
			<div class="entry__rail">
				<button type="button" data-depth="abstract" aria-pressed="false">Abstract</button>
				<button type="button" data-depth="paper" aria-pressed="false">Paper</button>
			</div></article>`;
		document.body.append(bar, main);
		const article = main.querySelector("article") as HTMLElement;
		const box = (top: number, bottom: number) => () =>
			({ top, bottom }) as DOMRect;
		article.getBoundingClientRect = box(-100, 3000);
		(
			article.querySelector(".entry__title") as HTMLElement
		).getBoundingClientRect = box(-150, -50);
		(
			article.querySelector(".entry__rail") as HTMLElement
		).getBoundingClientRect = box(2900, 2961);
		pinning = new AbortController();
		const row = pinReading({ main, bar }, pinning.signal);
		const first = watchers[0];
		if (first === undefined) throw new Error("no observer was made");
		return { row, article, cross: first };
	}

	test("the title and buttons of the post being read pin, and Tab and screen readers skip the pinned copies", () => {
		const { row, cross } = longPost();
		cross();
		const title = document.querySelector<HTMLElement>(".pinned-title");
		expect(title?.hidden).toBe(false);
		expect(title?.textContent).toBe("A long post");
		expect(row.hidden).toBe(false);
		expect(
			Array.from(
				row.querySelectorAll("button"),
				(button) => button.textContent,
			),
		).toEqual(["Abstract", "Paper"]);
		for (const button of row.querySelectorAll("button"))
			expect(button.getAttribute("tabindex")).toBe("-1");
		expect(title?.getAttribute("aria-hidden")).toBe("true");
		expect(row.getAttribute("aria-hidden")).toBe("true");
	});

	test("a press on a pinned button is a press on the same button of the post", () => {
		const { row, article, cross } = longPost();
		cross();
		const pressed = vi.fn();
		article
			.querySelector('[data-depth="paper"]')
			?.addEventListener("click", pressed);
		(row.querySelectorAll("button")[1] as HTMLElement).click();
		expect(pressed).toHaveBeenCalledTimes(1);
	});

	test("a pinned button shows the same pressed state as the post's own button", async () => {
		const { row, article, cross } = longPost();
		cross();
		article
			.querySelector('[data-depth="abstract"]')
			?.setAttribute("aria-pressed", "true");
		await vi.waitFor(() =>
			expect(
				row
					.querySelector('[data-depth="abstract"]')
					?.getAttribute("aria-pressed"),
			).toBe("true"),
		);
	});

	test("nothing pins before a title has gone under the bar, and stopping the pinning removes the pinned title and row", () => {
		const { row, article, cross } = longPost();
		(
			article.querySelector(".entry__title") as HTMLElement
		).getBoundingClientRect = () => ({ top: 80, bottom: 120 }) as DOMRect;
		cross();
		expect(document.querySelector<HTMLElement>(".pinned-title")?.hidden).toBe(
			true,
		);
		expect(row.hidden).toBe(true);
		pinning?.abort();
		expect(document.querySelector(".pinned-title")).toBeNull();
		expect(document.querySelector(".pinned-row")).toBeNull();
	});
});
