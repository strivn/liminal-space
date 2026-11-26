// Read marks, likes and dislikes and tags as the page holds them in memory.
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
// What each tag's toggle and the Search sentence say.
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

// Whether an entry carries every tag in `names`. Every entry does when `names` is empty.
export function matchesTags(tags: Tags, id: string, names: TagName[]): boolean {
	for (const name of names) {
		if (!tags[id] || tags[id][name] !== true) return false;
	}
	return true;
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
