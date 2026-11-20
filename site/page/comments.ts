// Comments as data: finding passages, removing comments, the threads that can be drawn; and the reading line.

import { isJsonObject } from "../../shared/narrow.ts";
import type { ThreadPlace } from "../../shared/owner-protocol.ts";
import { SHORT_MONTHS } from "./days.ts";
import type { AllComments, StoredThread, Thread } from "./types.ts";

// A comment's time in `timeZone` (the machine's own when not given): "27 Sep, 23:20", or "31 Dec 2025, 22:00" when
// its year in that zone isn't now's.
export function commentTime(iso: string, now: Date, timeZone?: string): string {
	const format = new Intl.DateTimeFormat("en-GB", {
		timeZone: timeZone,
		year: "numeric",
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	});
	// formatToParts splits the date into labelled pieces, like a dict of {"day": "01", "month": "10", ...}.
	const parts: Record<string, string> = {};
	for (const part of format.formatToParts(new Date(iso)))
		parts[part.type] = part.value;
	let nowYear = "";
	for (const part of format.formatToParts(now)) {
		if (part.type === "year") nowYear = part.value;
	}
	let day = `${Number(parts.day)} ${SHORT_MONTHS[Number(parts.month) - 1]}`;
	if (parts.year !== nowYear) day += ` ${parts.year}`;
	return `${day}, ${parts.hour}:${parts.minute}`;
}

// Where the `occurrence`-th (from 1) appearance of `passage` starts in `text`, or -1 when there are fewer.
// Appearances may overlap: each search starts one character after the last match's start.
export function findPassage(
	text: string,
	passage: string,
	occurrence: number,
): number {
	let index = -1;
	for (let found = 0; found < occurrence; found++) {
		index = text.indexOf(passage, index + 1);
		if (index === -1) return -1;
	}
	return index;
}

// Which appearance (from 1) of `passage` starts at `start` in `text`, counted as findPassage counts. 0 if none does.
export function occurrenceOf(
	text: string,
	passage: string,
	start: number,
): number {
	let count = 0;
	let index = text.indexOf(passage);
	while (index !== -1 && index <= start) {
		count += 1;
		if (index === start) return count;
		index = text.indexOf(passage, index + 1);
	}
	return 0;
}

// The question the browser asks before deleting comment `index` of `thread`. The first comment takes its replies.
export function deleteQuestion(thread: Thread, index: number): string {
	if (index > 0) return "Delete this reply?";
	const replies = thread.comments.length - 1;
	if (replies === 0) return "Delete this comment?";
	if (replies === 1) return "Delete this comment and its 1 reply?";
	return `Delete this comment and its ${replies} replies?`;
}

// The threads without one comment. A thread's first comment takes the whole thread with it, except a highlight's,
// which leaves the highlight with no comments. `threads` is unchanged.
export function removeComment(
	threads: unknown[],
	threadId: string,
	commentId: string,
): unknown[] {
	const kept: unknown[] = [];
	for (const thread of threads) {
		if (!isJsonObject(thread) || thread.id !== threadId) {
			kept.push(thread);
			continue;
		}
		// A thread whose comments aren't a list fails here.
		if (!Array.isArray(thread.comments))
			throw new TypeError(`Thread ${threadId} has no list of comments`);
		const threadComments: unknown[] = thread.comments;
		const first = threadComments[0];
		const takesThread =
			threadComments.length > 0 &&
			isJsonObject(first) &&
			first.id === commentId;
		if (takesThread && thread.highlight !== true) continue;
		// A new thread object with the other comments: its fields copied one by one, its comments replaced.
		const copy: Record<string, unknown> = {};
		for (const key of Object.keys(thread)) {
			copy[key] = thread[key];
		}
		copy.comments = threadComments.filter(
			(comment) => !isJsonObject(comment) || comment.id !== commentId,
		);
		if (takesThread) copy.comments = [];
		kept.push(copy);
	}
	return kept;
}

// The threads of one entry that can be drawn, from whatever storage holds for it: threads with comments, and
// highlights on a passage, which may hold none. Anything else (an entry value that isn't a list, a thread without
// comments that isn't a highlight, a comment without text or a valid time, an anchor without a passage) is left out
// here and left as it is in storage.
export function usableThreads(value: unknown): Thread[] {
	if (!Array.isArray(value)) return [];
	const threads: unknown[] = value;
	const usable: Thread[] = [];
	for (const thread of threads) {
		if (!isJsonObject(thread) || typeof thread.id !== "string") continue;
		if (!Array.isArray(thread.comments)) continue;
		const empty = thread.comments.length === 0;
		if (empty && thread.highlight !== true) continue;
		const comments: unknown[] = thread.comments;
		let commentsOk = true;
		for (const comment of comments) {
			if (
				!isJsonObject(comment) ||
				typeof comment.id !== "string" ||
				typeof comment.text !== "string"
			)
				commentsOk = false;
			else if (Number.isNaN(Date.parse(String(comment.created))))
				commentsOk = false;
		}
		if (!commentsOk) continue;
		const anchored = thread.field === "title" || thread.field === "abstract";
		const whole = thread.field === null || thread.field === undefined;
		if (!anchored && !whole) continue;
		if (empty && !anchored) continue;
		if (
			anchored &&
			(typeof thread.passage !== "string" || thread.passage === "")
		)
			continue;
		const occurrence = thread.occurrence;
		if (
			anchored &&
			!(
				typeof occurrence === "number" &&
				Number.isInteger(occurrence) &&
				occurrence >= 1
			)
		)
			continue;
		// The checks above are what Thread promises; TypeScript can't follow them through the loop.
		usable.push(thread as Thread);
	}
	return usable;
}

// Card tops in the comment column: each card where it wants to be, or `gap` below the card before it if that is lower.
export function stackTops(
	wanted: number[],
	heights: number[],
	gap: number,
): number[] {
	const tops: number[] = [];
	for (let i = 0; i < wanted.length; i++) {
		// An index past the end reads as undefined, which Number() makes NaN.
		let top = Number(wanted[i]);
		if (i > 0)
			top = Math.max(top, Number(tops[i - 1]) + Number(heights[i - 1]) + gap);
		tops.push(top);
	}
	return tops;
}

// The thread with `threadId` among an entry's threads in `all`, or null.
export function findThread(
	all: AllComments,
	entryId: string,
	threadId: string,
): StoredThread | null {
	for (const thread of threadList(all, entryId)) {
		// Array.isArray just checked its comments, which is all StoredThread promises.
		if (
			isJsonObject(thread) &&
			thread.id === threadId &&
			Array.isArray(thread.comments)
		)
			return thread as StoredThread;
	}
	return null;
}

// A thread's id and place as the site takes them (CommentsChange's thread): a field the page left out reads as null.
export function threadPlace(thread: Record<string, unknown>): ThreadPlace {
	const place: ThreadPlace = {
		id: String(thread.id),
		field: null,
		passage: null,
		occurrence: null,
	};
	if (thread.field === "title" || thread.field === "abstract") {
		place.field = thread.field;
	}
	if (typeof thread.passage === "string") {
		place.passage = thread.passage;
	}
	if (typeof thread.occurrence === "number") {
		place.occurrence = thread.occurrence;
	}
	return place;
}

// What `all` holds for an entry as a list; a value that isn't a list counts as none, and is replaced by a save.
export function threadList(all: AllComments, entryId: string): unknown[] {
	if (Array.isArray(all[entryId])) return all[entryId];
	return [];
}

// The reading line, in px from the top of the window: once an entry's title reaches it, that entry is being read.
// Normally 35% of the window height. The day's last titles can't scroll up that far (measured: the last 2 of 12),
// so over the last stretch of scrolling the line slides down and reaches the last title just as the page reaches
// its bottom. The stretch is only as long as the last title needs, so titles that can reach 35% on their own are
// marked at 35%. lastTitleTop is the last title's top at the current scroll position.
export function readingLine(
	windowHeight: number,
	scrollRange: number,
	scrollY: number,
	lastTitleTop: number,
): number {
	const line = 0.35 * windowHeight;
	const leftToScroll = scrollRange - scrollY;
	// How far below the line the last title will still be when the page is scrolled to the bottom.
	const shortfall = lastTitleTop - leftToScroll - line;
	if (shortfall <= 0 || scrollRange <= 0) return line;
	// On a page that scrolls less than the shortfall, the whole scroll is the stretch.
	const stretch = Math.min(shortfall, scrollRange);
	if (leftToScroll >= stretch) return line;
	return line + shortfall * (1 - leftToScroll / stretch);
}
