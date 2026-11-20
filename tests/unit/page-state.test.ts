// The owner's saved state as the page reads it (site/page/state.ts): what is kept, what is dropped, and keys that are
// also names on every object.
import { expect, test } from "vitest";
import {
	feedbackOf,
	readStateOf,
	tagsOf,
	takeawaysOf,
} from "../../site/page/state.ts";

test("read state keeps every id with the depth abstract, paper or the older read, and drops any other depth or value", () => {
	const state = readStateOf({
		"arxiv:1": { depth: "abstract", date: "2026-09-27" },
		"arxiv:2": { depth: "paper", date: "2026-09-26" },
		"arxiv:3": { depth: "read", date: "2026-09-25" },
		"arxiv:4": { depth: "skimmed", date: "2026-09-25" },
		"arxiv:5": "paper",
		"arxiv:6": null,
	});
	expect(Object.keys(state).sort()).toEqual(["arxiv:1", "arxiv:2", "arxiv:3"]);
	expect(state["arxiv:1"]).toEqual({ depth: "abstract", date: "2026-09-27" });
});

test("read state from something that isn't an object counts as nothing read", () => {
	for (const saved of [null, undefined, "paper", 3, ["paper"]])
		expect(Object.keys(readStateOf(saved))).toEqual([]);
});

test('security: an entry id "__proto__" is an ordinary key in read state, tags, likes and takeaways', () => {
	const read = readStateOf(
		JSON.parse('{"__proto__": {"depth": "paper", "date": "2026-09-27"}}'),
	);
	expect(Object.keys(read)).toEqual(["__proto__"]);
	expect(Object.getPrototypeOf(read)).toBeNull();
	const tags = tagsOf(JSON.parse('{"__proto__": {"toRead": true}}'));
	expect(Object.keys(tags)).toEqual(["__proto__"]);
	expect(Object.getPrototypeOf(tags)).toBeNull();
	const marks = feedbackOf(
		JSON.parse('{"__proto__": {"mark": "ok", "date": "2026-09-27"}}'),
	);
	expect(Object.keys(marks)).toEqual(["__proto__"]);
	expect(Object.getPrototypeOf(marks)).toBeNull();
	expect(({} as Record<string, unknown>).depth).toBeUndefined();
	const all = takeawaysOf(JSON.parse('{"__proto__": []}'));
	expect(Object.getPrototypeOf(all)).toBeNull();
});

test("tags keep only the tags set to true, and an id left with none loses its key", () => {
	const tags = tagsOf({
		"arxiv:1": { toRead: true, learnFirst: false },
		"arxiv:2": { toRead: false },
		"arxiv:3": { other: true },
		"arxiv:4": "toRead",
	});
	expect(Object.keys(tags)).toEqual(["arxiv:1"]);
	expect(tags["arxiv:1"]).toEqual({ toRead: true });
});

test("likes keep only a dislike, OK or like with a date, and leave out anything else", () => {
	const marks = feedbackOf({
		"a:1": { mark: "dislike", date: "2026-09-27" },
		"a:2": { mark: "ok", date: "2026-09-27" },
		"a:3": { mark: "like", date: "2026-09-27" },
		"a:4": { mark: "love", date: "2026-09-27" },
		"a:5": { mark: "like" },
		"a:6": "like",
	});
	expect(Object.keys(marks)).toEqual(["a:1", "a:2", "a:3"]);
});
