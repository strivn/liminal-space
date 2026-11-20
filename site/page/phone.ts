// Reading on a phone: the touch gestures (hold a rail button for its name, swipe an entry left to mark it read,
// swipe the comment sheet down and the contents up to close them), the strip's ring on the day being read, and the
// measures they rest on. A phone is a touch screen narrower than 600 pixels; nothing here runs on any other window.
import { el, pageSelection, targetElement } from "./dom.ts";
import { iconSvg } from "./icons.ts";
import { pinReading } from "./pinning.ts";

// A phone, as style.css's phone rules name it too.
export const PHONE_QUERY = "(max-width: 599px) and (pointer: coarse)";

// How far the on-screen keyboard reaches up from the bottom of the window, in px: what the visual viewport leaves
// uncovered below its bottom edge. 0 when no keyboard shows.
export function keyboardInset(
	innerHeight: number,
	viewportHeight: number,
	viewportOffsetTop: number,
): number {
	return Math.max(0, innerHeight - viewportHeight - viewportOffsetTop);
}

// A swipe left marks an entry read when the finger moved at least 80px left and less than half as far up or down.
const SWIPE_DISTANCE = 80;

// Whether a touch that moved `dx` px across and `dy` px down is a swipe left that marks an entry read. A selection
// in the page means the finger was moving a selection handle, not swiping.
export function isReadSwipe(
	dx: number,
	dy: number,
	textSelected: boolean,
): boolean {
	if (textSelected) return false;
	if (dx > -SWIPE_DISTANCE) return false;
	return Math.abs(dy) * 2 < Math.abs(dx);
}

// How long a finger rests on a rail button before its name shows, and how far a sheet or the contents must be
// dragged before letting go closes them.
const HOLD_MS = 500;
const CLOSE_DISTANCE = 100;

// What the gestures act on: the entries in `main`, the contents' <details> under the bar, and the comment sheet: its
// dialog, the handle along its top, and `dismissSheet`, which closes it as its close button does.
export type PhoneParts = {
	main: HTMLElement;
	bar: HTMLElement;
	contents: HTMLDetailsElement;
	sheet: HTMLDialogElement;
	sheetHandle: HTMLElement;
	dismissSheet: () => void;
};

// Attach the phone gestures while the window is a phone, and detach them when it stops being one.
export function startPhoneGestures(parts: PhoneParts): void {
	const phone = window.matchMedia(PHONE_QUERY);
	let detach: (() => void) | null = null;
	function follow() {
		if (phone.matches && detach === null) detach = attach(parts);
		if (!phone.matches && detach !== null) {
			detach();
			detach = null;
		}
	}
	follow();
	phone.addEventListener("change", follow);
}

// Attach every gesture and the strip's ring; the function returned takes them all off again.
function attach(parts: PhoneParts): () => void {
	const controller = new AbortController();
	const signal = controller.signal;
	ringDayInView(parts, signal);
	const pinnedRow = pinReading(parts, signal);
	holdForNames(parts.main, signal);
	holdForNames(pinnedRow, signal);
	swipeToMarkRead(parts.main, signal);
	const grip = contentsGrip(parts, signal);
	dragToClose(
		parts.sheetHandle,
		parts.sheet,
		1,
		() => parts.dismissSheet(),
		signal,
	);
	return () => {
		controller.abort();
		grip.remove();
	};
}

// How far below the bar a day's top may be and still be the day being read, in px.
const RING_SLACK = 8;
// How far above the screen the band reaches, in px: past the top of any page (a browser's layout stops near 33
// million px).
const RING_ABOVE = 10_000_000;

// The strip's ring marks the day being read: the last day, in the page's order, whose box reaches into the band from
// far above the screen to RING_SLACK below the stuck bar, so the last whose top has reached the bar, as an
// IntersectionObserver reports it. Above every day, at the top of the page, it is the first day shown. The band
// reaches above the screen so a jump straight past days, which draws nothing in between, still lands on the right
// one. It is measured from the bar and the window, and again whenever the window resizes. entry.ts keeps the ring
// when the strip redraws.
function ringDayInView(parts: PhoneParts, signal: AbortSignal) {
	const strip = parts.bar.querySelector<HTMLElement>(".phone-bar__strip");
	const days = Array.from(
		parts.main.querySelectorAll<HTMLElement>(".day[data-date]"),
	);
	if (strip === null || days.length === 0) return;
	const ring = (date: string) => {
		strip.dataset.current = date;
		for (const square of strip.querySelectorAll<HTMLElement>(".heatmap__day")) {
			if (square.dataset.date === date)
				square.setAttribute("aria-current", "true");
			else square.removeAttribute("aria-current");
		}
	};
	const reaching = new Set<Element>();
	const watch = () => {
		const line =
			Number.parseFloat(getComputedStyle(parts.bar).top) +
			parts.bar.offsetHeight +
			RING_SLACK;
		const observer = new IntersectionObserver(
			(changes) => {
				for (const change of changes) {
					if (change.isIntersecting) reaching.add(change.target);
					else reaching.delete(change.target);
				}
				let here = days.filter((day) => reaching.has(day)).at(-1);
				if (here === undefined)
					here = days.find((day) => day.checkVisibility());
				if (here !== undefined) ring(here.dataset.date || "");
			},
			{
				rootMargin: `${RING_ABOVE}px 0px ${line - window.innerHeight}px 0px`,
			},
		);
		for (const day of days) observer.observe(day);
		return observer;
	};
	let observer = watch();
	window.addEventListener(
		"resize",
		() => {
			observer.disconnect();
			reaching.clear();
			observer = watch();
		},
		{ signal: signal },
	);
	signal.addEventListener("abort", () => {
		observer.disconnect();
		ring("");
		delete strip.dataset.current;
	});
}

// A touch that rests on a rail button for HOLD_MS shows the button's name above it, until the finger lifts. The
// press is then not a tap: the click that may follow is dropped, and the browser's own menu never opens.
function holdForNames(main: HTMLElement, signal: AbortSignal) {
	let timer: number | undefined;
	let held: HTMLElement | null = null; // the button whose name shows
	let swallow: { button: HTMLElement; until: number } | null = null; // the click to drop after a hold
	const end = () => {
		clearTimeout(timer);
		if (held === null) return;
		held.classList.remove("rail-button--held");
		swallow = { button: held, until: Date.now() + 600 };
		held = null;
	};
	main.addEventListener(
		"pointerdown",
		(event) => {
			if (event.pointerType !== "touch") return;
			const button = targetElement(event).closest<HTMLElement>(".rail-button");
			if (button === null) return;
			timer = window.setTimeout(() => {
				const box = button.getBoundingClientRect();
				button.style.setProperty("--held-x", `${box.left + box.width / 2}px`);
				button.style.setProperty("--held-y", `${box.top - 4}px`);
				button.classList.add("rail-button--held");
				held = button;
			}, HOLD_MS);
		},
		{ signal: signal },
	);
	main.addEventListener("pointerup", end, { signal: signal });
	main.addEventListener("pointercancel", end, { signal: signal });
	signal.addEventListener("abort", end);
	main.addEventListener(
		"click",
		(event) => {
			const dropped = swallow;
			swallow = null;
			if (dropped === null || Date.now() > dropped.until) return;
			if (!dropped.button.contains(targetElement(event))) return;
			event.preventDefault();
			event.stopPropagation();
		},
		{ capture: true, signal: signal },
	);
	main.addEventListener(
		"contextmenu",
		(event) => {
			if (targetElement(event).closest(".rail-button")) event.preventDefault();
		},
		{ signal: signal },
	);
}

// A touch that swipes a paper's text left presses its read toggle: Abstract, or the toggle already pressed, which
// marks it unread. While the finger moves, the entry follows it and the read colour
// behind shows what letting go will do. The press goes through the button's own click handler, so the state is
// saved and drawn as after a tap.
function swipeToMarkRead(main: HTMLElement, signal: AbortSignal) {
	let start: {
		pointer: number;
		x: number;
		y: number;
		entry: HTMLElement;
		selected: boolean;
		under: HTMLElement | null;
		top: number; // the entry's top on screen, read when the swipe shows; a vertical pan cancels the swipe
	} | null = null;
	// Put the entry back where it was.
	const settle = () => {
		if (start === null) return;
		start.entry.classList.remove("entry--swiping");
		start.entry.style.removeProperty("--swipe-x");
		start.entry.style.removeProperty("--swipe-y");
		if (start.under !== null) start.under.remove();
		start = null;
	};
	main.addEventListener(
		"pointerdown",
		(event) => {
			settle();
			if (event.pointerType !== "touch") return;
			const body = targetElement(event).closest(".entry__body");
			const entry = targetElement(event).closest<HTMLElement>("article.entry");
			if (body === null || entry === null) return;
			// Only papers have read toggles; a swipe on anything else does nothing, and the entry doesn't move.
			if (readToggleToPress(entry) === null) return;
			start = {
				pointer: event.pointerId,
				x: event.clientX,
				y: event.clientY,
				entry: entry,
				selected: !pageSelection().isCollapsed,
				under: null,
				top: 0,
			};
		},
		{ signal: signal },
	);
	main.addEventListener(
		"pointermove",
		(event) => {
			if (start === null || start.pointer !== event.pointerId) return;
			if (start.selected) return;
			const dx = event.clientX - start.x;
			if (dx >= 0 || Math.abs(event.clientY - start.y) > Math.abs(dx)) {
				start.entry.style.setProperty("--swipe-x", "0px");
				return;
			}
			if (start.under === null) {
				start.top = start.entry.getBoundingClientRect().top;
				start.under = swipeUnder(start.entry);
				start.entry.append(start.under);
				start.entry.classList.add("entry--swiping");
			}
			start.entry.style.setProperty("--swipe-x", `${dx}px`);
			start.entry.style.setProperty(
				"--swipe-y",
				`${event.clientY - start.top}px`,
			);
		},
		{ signal: signal },
	);
	main.addEventListener(
		"pointerup",
		(event) => {
			const begun = start;
			if (begun === null || begun.pointer !== event.pointerId) return;
			settle();
			const selected = begun.selected || !pageSelection().isCollapsed;
			if (
				!isReadSwipe(event.clientX - begun.x, event.clientY - begun.y, selected)
			)
				return;
			const toggle = readToggleToPress(begun.entry);
			if (toggle !== null) toggle.click();
		},
		{ signal: signal },
	);
	main.addEventListener("pointercancel", settle, { signal: signal });
	signal.addEventListener("abort", settle);
}

// The read toggle a swipe presses: the one pressed now, else the first, Abstract. A type without read toggles has
// none. entry.ts marks the read toggles with their depth.
function readToggleToPress(entry: HTMLElement): HTMLButtonElement | null {
	return (
		entry.querySelector<HTMLButtonElement>(
			'.entry__rail button[data-depth][aria-pressed="true"]',
		) ||
		entry.querySelector<HTMLButtonElement>(".entry__rail button[data-depth]")
	);
}

// What shows behind a swiped entry: the toggle a swipe will press, by its own icon and name, or Unread for one
// pressed.
function swipeUnder(entry: HTMLElement): HTMLElement {
	const under = el("div", { class: "entry__swipe", "aria-hidden": "true" });
	const toggle = readToggleToPress(entry);
	if (toggle === null) return under;
	if (toggle.getAttribute("aria-pressed") === "true") {
		under.append(iconSvg("unread"), "Unread");
		return under;
	}
	const icon = toggle.querySelector("svg");
	if (icon !== null) under.append(icon.cloneNode(true));
	under.append(toggle.getAttribute("aria-label") || "");
	return under;
}

// The unfolded contents hang from the bar to the bottom of the screen (style.css): the bar's bottom is noted each time
// they unfold. A grip along their bottom edge closes them when dragged up.
function contentsGrip(parts: PhoneParts, signal: AbortSignal) {
	const grip = el("div", { class: "contents__grip", "aria-hidden": "true" });
	parts.contents.append(grip);
	parts.contents.addEventListener(
		"toggle",
		() => {
			if (!parts.contents.open) return;
			const bottom = parts.bar.getBoundingClientRect().bottom;
			document.documentElement.style.setProperty(
				"--phone-bar-bottom",
				`${bottom}px`,
			);
		},
		{ signal: signal },
	);
	dragToClose(
		grip,
		grip,
		-1,
		() => {
			parts.contents.open = false;
		},
		signal,
	);
	return grip;
}

// A touch dragging `handle` moves `moved` with it in `direction` (1 down, -1 up). Let go past CLOSE_DISTANCE, `close`
// runs; short of it, `moved` springs back.
function dragToClose(
	handle: HTMLElement,
	moved: HTMLElement,
	direction: 1 | -1,
	close: () => void,
	signal: AbortSignal,
) {
	let start: { pointer: number; y: number } | null = null;
	let distance = 0;
	const springBack = () => {
		start = null;
		distance = 0;
		moved.style.removeProperty("translate");
	};
	handle.addEventListener(
		"pointerdown",
		(event) => {
			if (event.pointerType !== "touch") return;
			start = { pointer: event.pointerId, y: event.clientY };
			distance = 0;
			handle.setPointerCapture(event.pointerId);
		},
		{ signal: signal },
	);
	handle.addEventListener(
		"pointermove",
		(event) => {
			if (start === null || start.pointer !== event.pointerId) return;
			distance = Math.max(0, (event.clientY - start.y) * direction);
			moved.style.translate = `0 ${distance * direction}px`;
		},
		{ signal: signal },
	);
	handle.addEventListener(
		"pointerup",
		(event) => {
			if (start === null || start.pointer !== event.pointerId) return;
			const far = distance >= CLOSE_DISTANCE;
			springBack();
			if (far) close();
		},
		{ signal: signal },
	);
	handle.addEventListener("pointercancel", springBack, { signal: signal });
	signal.addEventListener("abort", springBack);
}
