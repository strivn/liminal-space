// The owner's header line: a thin bar filled by the share of the newest digest's papers read, and its words.
import { paperProgress } from "./days.ts";
import { el } from "./dom.ts";
import type { Entry, ReadState } from "./types.ts";

// The share of the day's papers read, 0 to 1, or null without papers.
export function progressShare(
	entries: Entry[],
	state: ReadState,
): number | null {
	const progress = paperProgress(entries, state);
	if (progress.total === 0) return null;
	return progress.read / progress.total;
}

// Draw the line inside `container` for the day's `entries`: a bar named by its numbers, and "3 of 6 papers read"
// under it. A day without a paper has nothing to fill, so it draws nothing.
export function drawProgress(
	container: HTMLElement,
	entries: Entry[],
	state: ReadState,
): void {
	const share = progressShare(entries, state);
	if (share === null) {
		container.replaceChildren();
		return;
	}
	const progress = paperProgress(entries, state);
	const fill = el("i");
	fill.style.width = `${share * 100}%`;
	const bar = el(
		"div",
		{
			class: "progress__bar",
			role: "progressbar",
			"aria-label": "Papers read",
			"aria-valuemin": "0",
			"aria-valuemax": String(progress.total),
			"aria-valuenow": String(progress.read),
			"aria-valuetext": progress.text,
		},
		fill,
	);
	container.replaceChildren(
		bar,
		el("p", { class: "progress__text" }, progress.text),
	);
}

// Fill the phone bar's line to the same share; a day without papers draws nothing.
export function drawBarProgress(
	line: HTMLElement,
	entries: Entry[],
	state: ReadState,
): void {
	const share = progressShare(entries, state);
	if (share === null) {
		line.replaceChildren();
		return;
	}
	const fill = el("i");
	fill.style.width = `${share * 100}%`;
	line.replaceChildren(fill);
}
