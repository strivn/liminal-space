// Where the reader was, so coming back from a link or Refresh returns there.

export type ReadingPlace = { entryId: string; offset: number; savedAt: number };

// A saved place older than this is not restored.
export const PLACE_MAX_AGE_MS = 30 * 60 * 1000;

// The entry at the top of the screen and how far into it (negative while it is still under the bar).
export function readingPlace(
	entries: { id: string; top: number; bottom: number }[],
	barBottom: number,
	now: number,
): ReadingPlace | null {
	const here = entries.find((entry) => entry.bottom > barBottom);
	if (here === undefined) return null;
	return { entryId: here.id, offset: barBottom - here.top, savedAt: now };
}

// The scroll position that puts the place back under the bar.
export function placeScrollTop(
	place: ReadingPlace,
	entryTop: number,
	scrollY: number,
	barBottom: number,
): number {
	return Math.max(0, entryTop + scrollY + place.offset - barBottom);
}

// Whether to restore a saved place, from how the page was opened. Back and Forward return to the place even when the
// address names an entry, since a contents click left that name there; any other open follows the permalink.
export function restoresPlace(
	navigationType: string,
	refreshAsked: boolean,
	hasPermalink: boolean,
	place: ReadingPlace | null,
	now: number,
): boolean {
	if (place === null) return false;
	if (hasPermalink && navigationType !== "traverse") return false;
	if (now - place.savedAt > PLACE_MAX_AGE_MS) return false;
	if (navigationType === "reload") return refreshAsked;
	return (
		navigationType === "traverse" ||
		navigationType === "push" ||
		navigationType === "replace"
	);
}

// The place is kept per page path, since the public and the owner's copy share an origin.
const placeKey = () => `liminal-space:reading-place:${location.pathname}`;
// Refresh's mark for the next load, in this tab only.
const REFRESH_KEY = "liminal-space:refresh-asked";
// How long after the last scroll event the place is measured, in ms.
const SETTLE_MS = 200;

// A stored place if the text is one; storage is shared, so its shape is checked.
export function parsePlace(raw: string | null): ReadingPlace | null {
	if (raw === null) return null;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof value !== "object" || value === null) return null;
	const { entryId, offset, savedAt } = value as Record<string, unknown>;
	if (typeof entryId !== "string" || entryId === "") return null;
	if (typeof offset !== "number" || !Number.isFinite(offset)) return null;
	if (typeof savedAt !== "number" || !Number.isFinite(savedAt)) return null;
	return { entryId: entryId, offset: offset, savedAt: savedAt };
}

// The place on the page now, measured from the visible entries (a folded day has none), or null.
function measuredPlace(
	main: HTMLElement,
	barBottom: number,
	now: number,
): ReadingPlace | null {
	for (const article of main.querySelectorAll("article.entry[id]")) {
		const box = article.getBoundingClientRect();
		if (box.height > 0 && box.bottom > barBottom)
			return readingPlace(
				[{ id: article.id, top: box.top, bottom: box.bottom }],
				barBottom,
				now,
			);
	}
	return null;
}

// Write a place to localStorage; a refusing storage loses the place and nothing else.
function storePlace(place: ReadingPlace): void {
	try {
		localStorage.setItem(placeKey(), JSON.stringify(place));
	} catch {
		/* the place is lost, the page is not */
	}
}

// Measure the place and write it now.
export function savePlace(
	main: HTMLElement,
	barBottom: number,
	now: number,
): void {
	const place = measuredPlace(main, barBottom, now);
	if (place !== null) storePlace(place);
}

// Measure the place as scrolling settles, write it on leaving; returns a function that does both at once.
export function startSavingPlace(
	main: HTMLElement,
	barBottom: () => number,
	signal: AbortSignal = new AbortController().signal,
): () => void {
	let latest: ReadingPlace | null = null;
	const measure = () => {
		latest = measuredPlace(main, barBottom(), Date.now()) ?? latest;
	};
	const write = () => {
		if (latest !== null) storePlace(latest);
	};
	let settling: ReturnType<typeof setTimeout> | undefined;
	window.addEventListener(
		"scroll",
		() => {
			clearTimeout(settling);
			settling = setTimeout(measure, SETTLE_MS);
		},
		{ passive: true, signal: signal },
	);
	// Leaving only writes: Chrome lays the page out differently as it unloads, so a measure then is off.
	window.addEventListener("pagehide", write, { signal: signal });
	document.addEventListener(
		"visibilitychange",
		() => {
			if (document.visibilityState === "hidden") write();
		},
		{ signal: signal },
	);
	measure();
	return () => {
		measure();
		write();
	};
}

// Refresh: keep the place, mark it for the next load, reload; the mark ends with the tab.
export function refreshKeepingPlace(
	keepPlace: () => void,
	reload: () => void = () => location.reload(),
): void {
	keepPlace();
	try {
		sessionStorage.setItem(REFRESH_KEY, "1");
	} catch {
		/* Refresh then starts at the top, like a plain reload */
	}
	reload();
}

// Whether Refresh asked for this load; the mark is removed as it is read.
function takeRefreshMark(): boolean {
	try {
		const asked = sessionStorage.getItem(REFRESH_KEY) !== null;
		sessionStorage.removeItem(REFRESH_KEY);
		return asked;
	} catch {
		return false;
	}
}

// Scroll to the saved place if the page was opened in a way that restores it; whether it scrolled.
export function restoreReadingPlace(
	barBottom: number,
	hasPermalink: boolean,
	now: number,
): boolean {
	const refreshAsked = takeRefreshMark();
	let place: ReadingPlace | null = null;
	try {
		place = parsePlace(localStorage.getItem(placeKey()));
	} catch {
		/* no storage: no place */
	}
	const navigationType = window.navigation?.activation?.navigationType ?? "";
	if (!restoresPlace(navigationType, refreshAsked, hasPermalink, place, now))
		return false;
	if (place === null) return false;
	const entry = document.getElementById(place.entryId);
	if (entry === null) return false;
	const box = entry.getBoundingClientRect();
	if (box.height === 0) return false;
	const target = placeScrollTop(place, box.top, window.scrollY, barBottom);
	window.scrollTo(0, target);
	holdPlace(target);
	return true;
}

// How long a restored place is held while the page still grows, in ms.
const HOLD_MS = 3000;

// Scroll back to `target` each time the page's height changes, until the reader scrolls or HOLD_MS pass: content that
// loads after the restore (a month file, the owner's state) can make the page taller than it was at the first scroll.
function holdPlace(target: number): void {
	if (typeof ResizeObserver === "undefined") return;
	const observer = new ResizeObserver(() => {
		if (Math.abs(window.scrollY - target) > 1) window.scrollTo(0, target);
	});
	const stop = new AbortController();
	const release = () => {
		observer.disconnect();
		stop.abort();
	};
	for (const type of ["wheel", "touchstart", "keydown", "pointerdown"])
		window.addEventListener(type, release, {
			once: true,
			passive: true,
			signal: stop.signal,
		});
	setTimeout(release, HOLD_MS);
	observer.observe(document.documentElement);
}
