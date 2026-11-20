// @vitest-environment jsdom
// Reading on a phone (site/page/phone.ts): the touch gestures, the strip's ring and the measures they rest on.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	isReadSwipe,
	keyboardInset,
	PHONE_QUERY,
	startPhoneGestures,
} from "../../site/page/phone.ts";

describe("the measures", () => {
	test.each([
		["a keyboard up", 956, 616, 0, 340],
		["a keyboard up and the viewport scrolled down", 956, 616, 120, 220],
		["a viewport taller than the window", 956, 1000, 0, 0],
	])(
		"how far the keyboard covers the page with %s",
		(_name, inner, height, offset, inset) => {
			expect(keyboardInset(inner, height, offset)).toBe(inset);
		},
	);

	test.each([
		["a clear left", -80, 10, false, true],
		["too short", -40, 0, false, false],
		["half as far up as across", -80, 40, false, false],
		["a clear left while text is selected", -80, 10, true, false],
	])(
		"a swipe marks an entry only when it goes clearly left with no text selected: %s",
		(_name, dx, dy, selected, counts) => {
			expect(isReadSwipe(dx, dy, selected)).toBe(counts);
		},
	);
});

// A page of one paper, one news item and the parts the gestures act on.
function phonePage() {
	const main = document.createElement("main");
	main.innerHTML = `
		<article class="entry" id="paper">
			<div class="entry__body">text</div>
			<div class="entry__rail">
				<button type="button" data-depth="abstract" aria-pressed="false" aria-label="Abstract"></button>
				<button type="button" data-depth="paper" aria-pressed="false" aria-label="Paper"></button>
				<button type="button" class="rail-button" id="learn">Learn first</button>
			</div>
		</article>
		<article class="entry" id="news">
			<div class="entry__body">text</div>
			<div class="entry__rail"><button type="button" class="rail-button">Copy</button></div>
		</article>`;
	const bar = document.createElement("div");
	const contents = document.createElement("details");
	const sheet = document.createElement("dialog");
	const sheetHandle = document.createElement("div");
	sheet.append(sheetHandle);
	document.body.append(bar, main, contents, sheet);
	const dismissSheet = vi.fn();
	return { main, bar, contents, sheet, sheetHandle, dismissSheet };
}
type PhonePage = ReturnType<typeof phonePage>;

// A touch pointer event on `target`; the page's gestures read its type, id and position.
function touch(target: Element, type: string, x: number, y: number) {
	const event = new PointerEvent(type, {
		pointerType: "touch",
		pointerId: 1,
		clientX: x,
		clientY: y,
		bubbles: true,
		cancelable: true,
	});
	target.dispatchEvent(event);
	return event;
}

let isPhone = true;
const phoneListeners: (() => void)[] = [];
function becomePhone(next: boolean) {
	isPhone = next;
	for (const listener of phoneListeners) listener();
}

beforeEach(() => {
	isPhone = true;
	phoneListeners.length = 0;
	vi.stubGlobal("matchMedia", (query: string) => ({
		get matches() {
			return isPhone && query === PHONE_QUERY;
		},
		media: query,
		addEventListener: (_type: string, listener: () => void) => {
			if (query === PHONE_QUERY) phoneListeners.push(listener);
		},
		removeEventListener: () => {},
	}));
	// jsdom has no observers that watch layout, and no pointer capture; the gestures here don't need them to report.
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	Element.prototype.setPointerCapture = () => {};
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	document.body.replaceChildren();
	document.getSelection()?.removeAllRanges();
});

function start(page: PhonePage) {
	startPhoneGestures(page);
}

describe("holding a rail button", () => {
	test("holding a rail button for 500 ms shows its name until the finger lifts, and the click after the hold is dropped", () => {
		vi.useFakeTimers();
		const page = phonePage();
		start(page);
		const button = page.main.querySelector("#learn") as HTMLElement;
		const pressed = vi.fn();
		button.addEventListener("click", pressed);

		touch(button, "pointerdown", 10, 10);
		vi.advanceTimersByTime(499);
		expect(button.classList.contains("rail-button--held")).toBe(false);
		vi.advanceTimersByTime(1);
		expect(button.classList.contains("rail-button--held")).toBe(true);

		touch(button, "pointerup", 10, 10);
		expect(button.classList.contains("rail-button--held")).toBe(false);
		button.click();
		expect(pressed).not.toHaveBeenCalled();
	});

	test("a tap shorter than 500 ms shows no name and its click goes through", () => {
		vi.useFakeTimers();
		const page = phonePage();
		start(page);
		const button = page.main.querySelector("#learn") as HTMLElement;
		const pressed = vi.fn();
		button.addEventListener("click", pressed);

		touch(button, "pointerdown", 10, 10);
		vi.advanceTimersByTime(300);
		touch(button, "pointerup", 10, 10);
		vi.advanceTimersByTime(1000);
		expect(button.classList.contains("rail-button--held")).toBe(false);
		button.click();
		expect(pressed).toHaveBeenCalledTimes(1);
	});

	test("a click that comes long after a hold is a new tap and goes through", () => {
		vi.useFakeTimers();
		const page = phonePage();
		start(page);
		const button = page.main.querySelector("#learn") as HTMLElement;
		const pressed = vi.fn();
		button.addEventListener("click", pressed);
		touch(button, "pointerdown", 10, 10);
		vi.advanceTimersByTime(500);
		touch(button, "pointerup", 10, 10);
		vi.advanceTimersByTime(700);
		button.click();
		expect(pressed).toHaveBeenCalledTimes(1);
	});

	test("the browser's own menu never opens on a rail button", () => {
		const page = phonePage();
		start(page);
		const menu = new MouseEvent("contextmenu", {
			bubbles: true,
			cancelable: true,
		});
		page.main.querySelector("#learn")?.dispatchEvent(menu);
		expect(menu.defaultPrevented).toBe(true);
		const elsewhere = new MouseEvent("contextmenu", {
			bubbles: true,
			cancelable: true,
		});
		page.main.querySelector(".entry__body")?.dispatchEvent(elsewhere);
		expect(elsewhere.defaultPrevented).toBe(false);
	});
});

describe("swiping an entry left", () => {
	const toggles = (page: PhonePage) => {
		const abstract = vi.fn();
		const paper = vi.fn();
		page.main
			.querySelector('[data-depth="abstract"]')
			?.addEventListener("click", abstract);
		page.main
			.querySelector('[data-depth="paper"]')
			?.addEventListener("click", paper);
		return { abstract, paper };
	};
	const swipe = (target: Element, dx: number, dy: number) => {
		touch(target, "pointerdown", 300, 100);
		touch(target, "pointermove", 300 + dx, 100 + dy);
		touch(target, "pointerup", 300 + dx, 100 + dy);
	};

	test("swiping an unread paper left presses its Abstract button, as a tap would", () => {
		const page = phonePage();
		start(page);
		const clicks = toggles(page);
		swipe(page.main.querySelector("#paper .entry__body") as Element, -120, 10);
		expect(clicks.abstract).toHaveBeenCalledTimes(1);
		expect(clicks.paper).not.toHaveBeenCalled();
	});

	test("swiping a read paper left presses the button it is marked with, which marks it unread", () => {
		const page = phonePage();
		start(page);
		page.main
			.querySelector('[data-depth="paper"]')
			?.setAttribute("aria-pressed", "true");
		const clicks = toggles(page);
		swipe(page.main.querySelector("#paper .entry__body") as Element, -120, 10);
		expect(clicks.paper).toHaveBeenCalledTimes(1);
		expect(clicks.abstract).not.toHaveBeenCalled();
	});

	test("during a swipe the entry follows the finger with the button's name behind it, and letting go puts it back", () => {
		const page = phonePage();
		start(page);
		const entry = page.main.querySelector("#paper") as HTMLElement;
		const body = entry.querySelector(".entry__body") as Element;
		touch(body, "pointerdown", 300, 100);
		touch(body, "pointermove", 220, 104);
		expect(entry.classList.contains("entry--swiping")).toBe(true);
		expect(entry.style.getPropertyValue("--swipe-x")).toBe("-80px");
		expect(entry.querySelector(".entry__swipe")?.textContent).toBe("Abstract");
		touch(body, "pointerup", 220, 104);
		expect(entry.classList.contains("entry--swiping")).toBe(false);
		expect(entry.style.getPropertyValue("--swipe-x")).toBe("");
		expect(entry.querySelector(".entry__swipe")).toBeNull();
	});

	test("the name behind a read paper being swiped says Unread", () => {
		const page = phonePage();
		start(page);
		page.main
			.querySelector('[data-depth="abstract"]')
			?.setAttribute("aria-pressed", "true");
		const body = page.main.querySelector("#paper .entry__body") as Element;
		touch(body, "pointerdown", 300, 100);
		touch(body, "pointermove", 200, 100);
		expect(page.main.querySelector("#paper .entry__swipe")?.textContent).toBe(
			"Unread",
		);
	});

	test.each([
		["a swipe on a news item", "#news", -120, 0],
		["a swipe right", "#paper", 120, 0],
		["a swipe that is mostly vertical", "#paper", -80, 120],
		["a swipe that is too short", "#paper", -40, 0],
	])("%s marks nothing", (_name, entry, dx, dy) => {
		const page = phonePage();
		start(page);
		const clicks = toggles(page);
		swipe(page.main.querySelector(`${entry} .entry__body`) as Element, dx, dy);
		expect(clicks.abstract).not.toHaveBeenCalled();
		expect(clicks.paper).not.toHaveBeenCalled();
		expect(page.main.querySelector(".entry--swiping")).toBeNull();
	});

	test("with text selected, a swipe left marks nothing", () => {
		const page = phonePage();
		start(page);
		const clicks = toggles(page);
		const body = page.main.querySelector("#paper .entry__body") as Element;
		const range = document.createRange();
		range.selectNodeContents(body);
		document.getSelection()?.addRange(range);
		swipe(body, -120, 0);
		expect(clicks.abstract).not.toHaveBeenCalled();
	});

	test("dragging with a mouse marks nothing", () => {
		const page = phonePage();
		start(page);
		const clicks = toggles(page);
		const body = page.main.querySelector("#paper .entry__body") as Element;
		for (const [type, x] of [
			["pointerdown", 300],
			["pointermove", 180],
			["pointerup", 180],
		] as const) {
			body.dispatchEvent(
				new PointerEvent(type, {
					pointerType: "mouse",
					pointerId: 1,
					clientX: x,
					clientY: 100,
					bubbles: true,
				}),
			);
		}
		expect(clicks.abstract).not.toHaveBeenCalled();
	});

	test("leaving the phone layout mid-swipe puts the entry back", () => {
		const page = phonePage();
		start(page);
		const entry = page.main.querySelector("#paper") as HTMLElement;
		const body = entry.querySelector(".entry__body") as Element;
		touch(body, "pointerdown", 300, 100);
		touch(body, "pointermove", 180, 100);
		expect(entry.classList.contains("entry--swiping")).toBe(true);
		becomePhone(false);
		expect(entry.classList.contains("entry--swiping")).toBe(false);
		expect(entry.style.getPropertyValue("--swipe-x")).toBe("");
		expect(entry.querySelector(".entry__swipe")).toBeNull();
	});
});

describe("closing the sheet and the contents by dragging", () => {
	test("the sheet follows a downward drag, springs back short of 100 px, and closes past 100 px", () => {
		const page = phonePage();
		start(page);
		touch(page.sheetHandle, "pointerdown", 100, 100);
		touch(page.sheetHandle, "pointermove", 100, 160);
		expect(page.sheet.style.translate).toBe("0px 60px");
		touch(page.sheetHandle, "pointerup", 100, 160);
		expect(page.sheet.style.translate).toBe("");
		expect(page.dismissSheet).not.toHaveBeenCalled();

		touch(page.sheetHandle, "pointerdown", 100, 100);
		touch(page.sheetHandle, "pointermove", 100, 240);
		touch(page.sheetHandle, "pointerup", 100, 240);
		expect(page.dismissSheet).toHaveBeenCalledTimes(1);
	});

	test("the sheet does not follow a finger moving up", () => {
		const page = phonePage();
		start(page);
		touch(page.sheetHandle, "pointerdown", 100, 300);
		touch(page.sheetHandle, "pointermove", 100, 100);
		expect(page.sheet.style.translate).toBe("0px");
		touch(page.sheetHandle, "pointerup", 100, 100);
		expect(page.dismissSheet).not.toHaveBeenCalled();
	});

	test("the unfolded contents close when their grip is dragged up past 100 px, and stay open short of it", () => {
		const page = phonePage();
		start(page);
		page.contents.open = true;
		const grip = page.contents.querySelector(".contents__grip") as HTMLElement;
		touch(grip, "pointerdown", 100, 500);
		touch(grip, "pointermove", 100, 440);
		touch(grip, "pointerup", 100, 440);
		expect(page.contents.open).toBe(true);
		touch(grip, "pointerdown", 100, 500);
		touch(grip, "pointermove", 100, 360);
		touch(grip, "pointerup", 100, 360);
		expect(page.contents.open).toBe(false);
	});
});

describe("the gestures switch on and off with the phone layout", () => {
	test("on a desktop window nothing is attached: no grip, no hold, no swipe", () => {
		vi.useFakeTimers();
		isPhone = false;
		const page = phonePage();
		start(page);
		expect(page.contents.querySelector(".contents__grip")).toBeNull();
		const button = page.main.querySelector("#learn") as HTMLElement;
		touch(button, "pointerdown", 10, 10);
		vi.advanceTimersByTime(600);
		expect(button.classList.contains("rail-button--held")).toBe(false);
		const abstract = vi.fn();
		page.main
			.querySelector('[data-depth="abstract"]')
			?.addEventListener("click", abstract);
		const body = page.main.querySelector("#paper .entry__body") as Element;
		touch(body, "pointerdown", 300, 100);
		touch(body, "pointermove", 180, 100);
		touch(body, "pointerup", 180, 100);
		expect(abstract).not.toHaveBeenCalled();
	});

	test("switching to the phone layout turns the gestures on once, and switching back turns them off", () => {
		vi.useFakeTimers();
		isPhone = false;
		const page = phonePage();
		start(page);
		becomePhone(true);
		expect(page.contents.querySelectorAll(".contents__grip")).toHaveLength(1);
		const button = page.main.querySelector("#learn") as HTMLElement;
		touch(button, "pointerdown", 10, 10);
		vi.advanceTimersByTime(500);
		expect(button.classList.contains("rail-button--held")).toBe(true);
		touch(button, "pointerup", 10, 10);

		becomePhone(false);
		expect(page.contents.querySelector(".contents__grip")).toBeNull();
		touch(button, "pointerdown", 10, 10);
		vi.advanceTimersByTime(600);
		expect(button.classList.contains("rail-button--held")).toBe(false);

		// Back to a phone: attached once, not twice.
		becomePhone(true);
		becomePhone(true);
		expect(page.contents.querySelectorAll(".contents__grip")).toHaveLength(1);
	});

	test("the strip's ring marks the day being read as the page scrolls, and goes when the layout stops being a phone", () => {
		const watchers: {
			observed: Element[];
			callback: IntersectionObserverCallback;
			disconnected: boolean;
		}[] = [];
		vi.stubGlobal(
			"IntersectionObserver",
			class {
				observed: Element[] = [];
				callback: IntersectionObserverCallback;
				disconnected = false;
				constructor(callback: IntersectionObserverCallback) {
					this.callback = callback;
					watchers.push(this);
				}
				observe(target: Element) {
					this.observed.push(target);
				}
				disconnect() {
					this.disconnected = true;
				}
			},
		);
		Element.prototype.checkVisibility = () => true;
		const page = phonePage();
		page.main.innerHTML = ["2026-09-27", "2026-09-24", "2026-09-23"]
			.map((date) => `<section class="day" data-date="${date}"></section>`)
			.join("");
		page.bar.innerHTML = `<div class="phone-bar__strip">${[
			"2026-09-23",
			"2026-09-24",
			"2026-09-27",
		]
			.map(
				(date) => `<button class="heatmap__day" data-date="${date}"></button>`,
			)
			.join("")}</div>`;
		start(page);
		const dayWatcher = watchers.find((one) =>
			one.observed.some((node) => node.classList.contains("day")),
		);
		if (dayWatcher === undefined)
			throw new Error("no observer watches the days");
		expect(dayWatcher.observed).toHaveLength(3);
		const ringed = () =>
			Array.from(
				page.bar.querySelectorAll(".heatmap__day[aria-current]"),
				(square) => (square as HTMLElement).dataset.date,
			);
		const reaches = (...dates: string[]) =>
			dayWatcher.callback(
				dayWatcher.observed.map(
					(target) =>
						({
							target,
							isIntersecting: dates.includes(
								(target as HTMLElement).dataset.date || "",
							),
						}) as IntersectionObserverEntry,
				),
				dayWatcher as unknown as IntersectionObserver,
			);

		reaches("2026-09-27", "2026-09-24");
		expect(ringed()).toEqual(["2026-09-24"]);
		reaches("2026-09-27");
		expect(ringed()).toEqual(["2026-09-27"]);
		// Above every day, at the top of the page, the first day shown has the ring.
		reaches();
		expect(ringed()).toEqual(["2026-09-27"]);

		becomePhone(false);
		expect(dayWatcher.disconnected).toBe(true);
		expect(ringed()).toEqual([]);
	});
});
