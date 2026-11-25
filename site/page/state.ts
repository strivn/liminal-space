// Read marks, likes and dislikes, tags and the read filter as the page holds them in memory.
import { isDay } from "../../shared/entry-checks.ts";
import { isJsonObject, type JsonObject } from "../../shared/narrow.ts";
import {
	type Depth,
	isDepth,
	type TagName,
	type Takeaway,
} from "../../shared/owner-protocol.ts";
import type {
	AllTakeaways,
	FeedbackMarks,
	ReadCounts,
	ReadState,
	Standouts,
	Tags,
} from "./types.ts";

// An entry's takeaways, newest first.
export function newestFirst(takeaways: Takeaway[]): Takeaway[] {
	return takeaways
		.slice()
		.sort((a, b) => Date.parse(b.created) - Date.parse(a.created));
}

// The site's takeaways by entry id, each list newest first. A takeaway that isn't one is passed over and logged.
export function takeawaysOf(json: Record<string, unknown>): AllTakeaways {
	const all: AllTakeaways = Object.create(null);
	for (const entryId of Object.keys(json)) {
		const list = json[entryId];
		if (!Array.isArray(list)) continue;
		const kept: Takeaway[] = [];
		for (const item of list) {
			if (isTakeaway(item)) kept.push(item);
			else console.warn(`A takeaway on ${entryId} can't be shown:`, item);
		}
		if (kept.length > 0) all[entryId] = newestFirst(kept);
	}
	return all;
}

// A takeaway as the site answers it (shared/owner-protocol.ts).
function isTakeaway(value: unknown): value is Takeaway {
	if (!isJsonObject(value)) return false;
	const question = value.question;
	const edited = value.edited;
	return (
		typeof value.id === "string" &&
		typeof value.text === "string" &&
		typeof value.created === "string" &&
		(question === null || typeof question === "string") &&
		(edited === null || typeof edited === "string") &&
		(value.source === "claude.ai" ||
			value.source === "ChatGPT" ||
			value.source === "page")
	);
}

// Read state from a value read as JSON: { id: { depth, date } }. A value that isn't an object counts as nothing read;
// an entry with an unknown depth is dropped, every other id is kept, whether or not a digest still has it.
export function readStateOf(saved: unknown): ReadState {
	if (!isJsonObject(saved)) return Object.create(null);
	const state: ReadState = Object.create(null);
	for (const [id, value] of Object.entries(saved)) {
		if (isJsonObject(value) && isDepth(value.depth))
			state[id] = { depth: value.depth, date: value.date };
	}
	return state;
}

// A copy of read state, each mark its own object, so changing one copy never changes the other.
export function copyReadState(state: ReadState): ReadState {
	const copy: ReadState = Object.create(null);
	for (const id of Object.keys(state)) {
		const mark = state[id];
		if (mark !== undefined) copy[id] = { depth: mark.depth, date: mark.date };
	}
	return copy;
}

// Press a toggle: the entry's own depth again clears it; any other depth replaces it, dated today.
export function toggleRead(
	state: ReadState,
	id: string,
	depth: Depth,
	today: string,
): void {
	if (state[id] && state[id].depth === depth) {
		delete state[id];
		return;
	}
	state[id] = { depth: depth, date: today };
}

// One day's tally: its entries, its papers, how many papers are read and at which depth. Only papers are tracked, so
// a read mark on a news item, an article or a report counts nowhere, and a paper counts once. Only ids and types are
// read, so a day of a month not loaded yet counts from the index.
export function readCounts(
	entries: { id: string; type: string }[],
	state: ReadState,
): ReadCounts {
	const counts: ReadCounts = {
		items: entries.length,
		total: 0,
		read: 0,
		abstracts: 0,
		papers: 0,
	};
	for (const entry of entries) {
		if (entry.type !== "paper") continue;
		counts.total += 1;
		const saved = state[entry.id];
		if (saved === undefined) continue;
		if (saved.depth === "abstract") counts.abstracts += 1;
		if (saved.depth === "paper") counts.papers += 1;
	}
	counts.read = counts.abstracts + counts.papers;
	return counts;
}

// ---- likes and dislikes ----

// Dislike, OK and Like marks from the saved state: { id: { mark: "dislike", "ok" or "like", date } }. A value that
// isn't one is left out.
export function feedbackOf(saved: JsonObject): FeedbackMarks {
	const marks: FeedbackMarks = Object.create(null);
	for (const id of Object.keys(saved)) {
		const value = saved[id];
		if (!isJsonObject(value)) continue;
		if (
			value.mark !== "dislike" &&
			value.mark !== "ok" &&
			value.mark !== "like"
		)
			continue;
		if (typeof value.date !== "string") continue;
		marks[id] = { mark: value.mark, date: value.date };
	}
	return marks;
}

// ---- marked papers ----

// The papers with a note or a mark from the saved state: { id: { date, note } }, a date of null for a paper no longer
// marked. A value that isn't one is left out; saved state without the key (an older site) holds none.
export function standoutsOf(saved: unknown): Standouts {
	const rows: Standouts = Object.create(null);
	if (!isJsonObject(saved)) return rows;
	for (const id of Object.keys(saved)) {
		const value = saved[id];
		if (!isJsonObject(value)) continue;
		if (value.date !== null && !isDay(value.date)) continue;
		if (typeof value.note !== "string") continue;
		rows[id] = { date: value.date, note: value.note };
	}
	return rows;
}

// ---- tags ----

// The two next-action tags an entry can carry, each independent of the other, by the name they are saved under.
export const TAG_NAMES: TagName[] = ["toRead", "learnFirst"];
// What each tag's toggle and filter chip say.
export const TAG_LABELS: Record<TagName, string> = {
	toRead: "To read",
	learnFirst: "Learn first",
};

// Tags from a value read as JSON: { id: { toRead: true, learnFirst: true } }, a tag that is off left out. A value
// that isn't an object counts as no tags. Per id only a tag set to true is kept, and an id left with none is
// dropped; every other id is kept, whether or not a digest still has it, as read state keeps them.
export function tagsOf(saved: unknown): Tags {
	if (!isJsonObject(saved)) return Object.create(null);
	const tags: Tags = Object.create(null);
	for (const id of Object.keys(saved)) {
		const kept = entryTagsOf(saved[id]);
		if (Object.keys(kept).length > 0) tags[id] = kept;
	}
	return tags;
}

// One entry's tags from a value: a new object holding only the tags set to true.
export function entryTagsOf(value: unknown): Partial<Record<TagName, true>> {
	const kept: Partial<Record<TagName, true>> = {};
	if (!isJsonObject(value)) return kept;
	for (const name of TAG_NAMES) {
		if (value[name] === true) kept[name] = true;
	}
	return kept;
}

// Press a tag's toggle: a tag that is on turns off, one that is off turns on.
export function toggleTag(tags: Tags, id: string, name: TagName): void {
	setTag(tags, id, name, !matchesTags(tags, id, [name]));
}

// Turn one tag of an entry on or off.
export function setTag(
	tags: Tags,
	id: string,
	name: TagName,
	on: boolean,
): void {
	if (!on) {
		clearTag(tags, id, name);
		return;
	}
	if (!tags[id]) tags[id] = {};
	tags[id][name] = true;
}

// Turn a tag off; nothing changes when it is off. An entry left with no tag loses its key.
export function clearTag(tags: Tags, id: string, name: TagName): void {
	if (!tags[id]) return;
	delete tags[id][name];
	if (Object.keys(tags[id]).length === 0) delete tags[id];
}

// How many of `entries` carry each tag: { toRead, learnFirst }. An entry with both counts once for each. Only ids
// are read.
export function tagCounts(
	entries: { id: string }[],
	tags: Tags,
): Record<TagName, number> {
	const counts: Record<TagName, number> = { toRead: 0, learnFirst: 0 };
	for (const entry of entries) {
		for (const name of TAG_NAMES) {
			if (matchesTags(tags, entry.id, [name])) counts[name] += 1;
		}
	}
	return counts;
}

// Whether an entry carries every tag in `names`. Every entry does when `names` is empty.
export function matchesTags(tags: Tags, id: string, names: TagName[]): boolean {
	for (const name of names) {
		if (!tags[id] || tags[id][name] !== true) return false;
	}
	return true;
}

// ---- read filter ----

// The three read chips, in the order the sidebar shows them.
export type ReadChip = "unread" | "abstract" | "paper";
export const READ_CHIPS: ReadChip[] = ["unread", "abstract", "paper"];
// What each read chip says.
export const READ_CHIP_LABELS: Record<ReadChip, string> = {
	unread: "Unread",
	abstract: "Abstract",
	paper: "Paper",
};

// Whether an entry shows while a read chip is on: only papers are tracked, so no other type matches a chip. For a
// paper, unread means no read state; abstract and paper mean that depth. null (no chip on) matches every entry.
export function matchesRead(
	state: ReadState,
	entry: { id: string; type: string },
	chip: ReadChip | null,
): boolean {
	if (chip === null) return true;
	if (entry.type !== "paper") return false;
	const saved = state[entry.id];
	if (chip === "unread") return saved === undefined;
	return saved !== undefined && saved.depth === chip;
}

// Each read chip's count across the given entries. Only ids and types are read.
export function readChipCounts(
	entries: { id: string; type: string }[],
	state: ReadState,
): Record<ReadChip, number> {
	const counts: Record<ReadChip, number> = { unread: 0, abstract: 0, paper: 0 };
	for (const entry of entries) {
		for (const chip of READ_CHIPS) {
			if (matchesRead(state, entry, chip)) counts[chip] += 1;
		}
	}
	return counts;
}

// The site's state taken as the page's own: each entry's value from `fresh`, except for an entry `keeps` names (a
// change to it is still on its way to the site), which keeps the page's value from `current`. Each value goes
// through `copy`.
export function takeSiteState<T>(
	fresh: Record<string, T>,
	current: Record<string, T>,
	keeps: (id: string) => boolean,
	copy: (value: T) => T,
): Record<string, T> {
	const next: Record<string, T> = Object.create(null);
	for (const [id, value] of Object.entries(fresh)) {
		if (!keeps(id)) next[id] = copy(value);
	}
	for (const [id, value] of Object.entries(current)) {
		if (keeps(id)) next[id] = copy(value);
	}
	return next;
}

// A copy of every entry's tags, each entry's its own object, so changing one copy never changes the other.
export function copyTags(tags: Tags): Tags {
	const copy: Tags = Object.create(null);
	for (const id of Object.keys(tags)) {
		copy[id] = entryTagsOf(tags[id]);
	}
	return copy;
}

// What the page says when no entry carries every tag whose chip is on: 'No entries are tagged "To read"', or
// 'No entries are tagged "To read" and "Learn first"'.
function noTaggedEntriesText(names: TagName[]) {
	const quoted = names.map((name) => `"${TAG_LABELS[name]}"`);
	return `No entries are tagged ${quoted.join(" and ")}`;
}

// What the page says when no entry matches the chips that are on: the tag chips' words alone, 'No entries are
// unread' or 'No entries are read "Paper"' for a read chip alone, 'No entries match the filters' for both.
export function noFilteredEntriesText(
	names: TagName[],
	readChip: ReadChip | null,
) {
	if (readChip === null) return noTaggedEntriesText(names);
	if (names.length > 0) return "No entries match the filters";
	if (readChip === "unread") return "No entries are unread";
	return `No entries are read "${READ_CHIP_LABELS[readChip]}"`;
}
