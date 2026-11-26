// @vitest-environment jsdom
// The Search sentence: its blanks, what each choice shows in the Feed, and the choice panels.
import { expect, test } from "vitest";
import type { SearchEntry } from "../../shared/site-data-shape.ts";
import {
	type EntryMarks,
	matchesSentence,
	type Sentence,
	startingSentence,
} from "../../site/page/search.ts";

const TODAY = "2026-11-26";

function entry(fields: Partial<SearchEntry> & { id: string }): SearchEntry {
	return {
		date: TODAY,
		type: "paper",
		topic: null,
		keywords: [],
		venue: null,
		...fields,
	};
}

function topic(name: string, field = "Computer Science") {
	return { name, field };
}

// The ids shown, given marks by id.
function shown(
	sentence: Partial<Sentence>,
	entries: SearchEntry[],
	marks: Record<string, EntryMarks> | null = null,
) {
	const full = { ...startingSentence(TODAY), time: "any", ...sentence };
	return entries
		.filter((e) =>
			matchesSentence(
				e,
				full,
				TODAY,
				marks === null ? null : (marks[e.id] ?? null),
			),
		)
		.map((e) => e.id);
}

test.todo(
	"the sentence reads Show me [everything] about [any subject] from [any venue], [this month] on the public page, and adds [read or not] on the owner's",
);
test("a topic shows only papers whose main OpenAlex topic it is, and a keyword shows only papers that carry it", () => {
	const entries = [
		entry({
			id: "a",
			topic: topic("Adversarial Robustness"),
			keywords: ["jailbreak detection"],
		}),
		entry({
			id: "b",
			topic: topic("Ethics of AI"),
			keywords: ["jailbreak detection", "monitoring"],
		}),
		entry({ id: "c", topic: topic("Adversarial Robustness") }),
		entry({ id: "d" }),
	];
	expect(shown({ subjects: ["t:Adversarial Robustness"] }, entries)).toEqual([
		"a",
		"c",
	]);
	expect(shown({ subjects: ["k:jailbreak detection"] }, entries)).toEqual([
		"a",
		"b",
	]);
	expect(shown({ subjects: ["f:Computer Science"] }, entries)).toEqual([
		"a",
		"b",
		"c",
	]);
	expect(shown({ subjects: ["none"] }, entries)).toEqual(["d"]);
	expect(shown({ subjects: ["k:jailbreak"] }, entries)).toEqual([]);
});
test("two picked subjects show entries about either, or only entries with both when the reader picks all", () => {
	const entries = [
		entry({ id: "a", topic: topic("Adversarial Robustness") }),
		entry({
			id: "b",
			topic: topic("Ethics of AI"),
			keywords: ["jailbreak detection"],
		}),
		entry({
			id: "c",
			topic: topic("Adversarial Robustness"),
			keywords: ["jailbreak detection"],
		}),
	];
	const subjects = ["t:Adversarial Robustness", "k:jailbreak detection"];
	expect(shown({ subjects, join: "or" }, entries)).toEqual(["a", "b", "c"]);
	expect(shown({ subjects, join: "and" }, entries)).toEqual(["c"]);
});
test("the kind blank shows everything, papers only, or news and articles only", () => {
	const entries = [
		entry({ id: "paper" }),
		entry({ id: "news", type: "news" }),
		entry({ id: "report", type: "report" }),
	];
	expect(shown({ kind: "all" }, entries)).toEqual(["paper", "news", "report"]);
	expect(shown({ kind: "paper" }, entries)).toEqual(["paper"]);
	expect(shown({ kind: "reading" }, entries)).toEqual(["news", "report"]);
});
test("a conference shows every one of its tracks, and a track shows only that track", () => {
	const entries = [
		entry({ id: "main", venue: "ACL 2026" }),
		entry({ id: "findings", venue: "ACL Findings 2026" }),
		entry({ id: "findings-again", venue: "ACL 2026 Findings" }),
		entry({ id: "workshop", venue: "ACL 2026 Workshop (BiAlign)" }),
		entry({ id: "other", venue: "ICML 2026" }),
		entry({ id: "preprint" }),
	];
	expect(shown({ venue: "ACL 2026" }, entries)).toEqual([
		"main",
		"findings",
		"findings-again",
		"workshop",
	]);
	expect(shown({ venue: "ACL 2026|Findings" }, entries)).toEqual([
		"findings",
		"findings-again",
	]);
	expect(shown({ venue: "ACL 2026|" }, entries)).toEqual(["main"]);
	expect(shown({ venue: "" }, entries)).toHaveLength(entries.length);
});
test("the time blank shows today, the last week, one month or any time, and loads the months its choice needs", () => {
	const entries = [
		entry({ id: "today" }),
		entry({ id: "six-days-ago", date: "2026-11-20" }),
		entry({ id: "seven-days-ago", date: "2026-11-19" }),
		entry({ id: "october", date: "2026-10-30" }),
		entry({ id: "september", date: "2026-09-02" }),
	];
	expect(shown({ time: "today" }, entries)).toEqual(["today"]);
	expect(shown({ time: "week" }, entries)).toEqual(["today", "six-days-ago"]);
	expect(shown({ time: "m:2026-10" }, entries)).toEqual(["october"]);
	expect(shown({ time: "any" }, entries)).toHaveLength(entries.length);
	expect(shown({ time: startingSentence(TODAY).time }, entries)).toEqual([
		"today",
		"six-days-ago",
		"seven-days-ago",
	]);
});
test("the read blank shows unread, abstract read or paper read papers, those tagged To read or Learn first, and those added ad hoc", () => {
	const entries = [
		entry({ id: "unread" }),
		entry({ id: "abstract" }),
		entry({ id: "paper" }),
		entry({ id: "to-read" }),
		entry({ id: "both-tags" }),
		entry({ id: "ad-hoc" }),
		entry({ id: "news", type: "news" }),
	];
	const mark = (fields: Partial<EntryMarks>): EntryMarks => ({
		read: "unread",
		tags: [],
		adHoc: false,
		...fields,
	});
	const marks = {
		unread: mark({}),
		abstract: mark({ read: "abstract" }),
		paper: mark({ read: "paper" }),
		"to-read": mark({ tags: ["To read"] }),
		"both-tags": mark({ tags: ["To read", "Learn first"] }),
		"ad-hoc": mark({ adHoc: true }),
		news: mark({}),
	};
	const read = (fields: Partial<Sentence["marks"]>) => ({
		marks: { read: null, tags: [], adHoc: false, ...fields },
	});
	expect(shown(read({ read: "unread" }), entries, marks)).toEqual([
		"unread",
		"to-read",
		"both-tags",
		"ad-hoc",
	]);
	expect(shown(read({ read: "abstract" }), entries, marks)).toEqual([
		"abstract",
	]);
	expect(shown(read({ read: "paper" }), entries, marks)).toEqual(["paper"]);
	expect(shown(read({ tags: ["To read"] }), entries, marks)).toEqual([
		"to-read",
		"both-tags",
	]);
	expect(
		shown(read({ tags: ["To read", "Learn first"] }), entries, marks),
	).toEqual(["both-tags"]);
	expect(shown(read({ adHoc: true }), entries, marks)).toEqual(["ad-hoc"]);
	// Public page: no marks.
	expect(shown(read({ read: "paper" }), entries)).toHaveLength(entries.length);
});
test.todo(
	"every choice shows how many entries it would give with the other blanks as they are, and a choice that gives none cannot be picked",
);
test.todo(
	"the current month is drawn as a choice already made, and Reset shows only after a blank moved from where it started",
);
test.todo(
	"Reset puts every blank back and shows the entries of the current month",
);
test.todo(
	"typing in the subject box lists the topics and keywords that contain the typed letters, and changes nothing in the Feed",
);
test.todo(
	"a topic or keyword under a paper adds itself to the subject and keeps the other blanks and the reading place",
);
test.todo(
	"a paper OpenAlex has not classified yet reads Topics (OpenAlex): none yet, and the subject no topic yet finds it",
);
test.todo(
	"on a wide window the choices open beside the sidebar, so the sentence and its count stay in view",
);
test.todo(
	"on a phone the choices open in a sheet that holds the count, and keeps focus inside it until Done or Escape",
);
test.todo(
	"accessibility: each blank is named for what it filters, single-choice panels are radio groups, and the count is spoken once the reader stops changing it",
);
test.todo(
	"security: topic, keyword and venue names from the search file are drawn as text, never as HTML",
);
