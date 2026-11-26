// The Search sentence: its blanks, what they match, and the choices each blank opens.
import type { SearchEntry } from "../../shared/site-data-shape.ts";
import { venueOf } from "../../shared/venue.ts";

// What the sentence says. `subjects` holds "t:<topic>", "f:<field>", "k:<keyword>" or "none"; `time` is "today",
// "week", "m:YYYY-MM" or "any"; `marks` is the owner's only.
export type Sentence = {
	kind: "all" | "paper" | "reading";
	subjects: string[];
	join: "or" | "and";
	venue: string;
	time: string;
	marks: {
		read: "unread" | "abstract" | "paper" | null;
		tags: string[];
		adHoc: boolean;
	};
};

// What the owner's marks are for an entry, as the read blank needs them.
export type EntryMarks = {
	read: "unread" | "abstract" | "paper";
	tags: string[];
	adHoc: boolean;
};

const DAY_MS = 86400000;

export function startingSentence(today: string): Sentence {
	return {
		kind: "all",
		subjects: [],
		join: "or",
		venue: "",
		time: `m:${today.slice(0, 7)}`,
		marks: { read: null, tags: [], adHoc: false },
	};
}

// Null marks: the public page.
export function matchesSentence(
	entry: SearchEntry,
	sentence: Sentence,
	today: string,
	marks: EntryMarks | null,
): boolean {
	return (
		matchesKind(entry, sentence.kind) &&
		matchesSubjects(entry, sentence) &&
		matchesVenue(entry, sentence.venue) &&
		matchesTime(entry, sentence.time, today) &&
		(marks === null || matchesMarks(entry, sentence.marks, marks))
	);
}

function matchesKind(entry: SearchEntry, kind: Sentence["kind"]): boolean {
	if (kind === "paper") return entry.type === "paper";
	if (kind === "reading") return entry.type !== "paper";
	return true;
}

// "none" means a paper without a topic.
function matchesSubjects(entry: SearchEntry, sentence: Sentence): boolean {
	if (sentence.subjects.length === 0) return true;
	const hits = sentence.subjects.map((subject) =>
		matchesSubject(entry, subject),
	);
	return sentence.join === "and" ? hits.every(Boolean) : hits.some(Boolean);
}

function matchesSubject(entry: SearchEntry, subject: string): boolean {
	if (subject === "none") return entry.type === "paper" && entry.topic === null;
	const value = subject.slice(2);
	if (subject.startsWith("t:")) return entry.topic?.name === value;
	if (subject.startsWith("f:")) return entry.topic?.field === value;
	if (subject.startsWith("k:")) return entry.keywords.includes(value);
	return false;
}

// "conference" or "conference|track".
function matchesVenue(entry: SearchEntry, venue: string): boolean {
	if (venue === "") return true;
	if (entry.venue === null) return false;
	const written = venueOf(entry.venue);
	const bar = venue.indexOf("|");
	if (bar === -1) return written.conference === venue;
	return (
		written.conference === venue.slice(0, bar) &&
		written.track === venue.slice(bar + 1)
	);
}

function matchesTime(entry: SearchEntry, time: string, today: string): boolean {
	if (time === "today") return entry.date === today;
	if (time === "week") {
		const first = new Date(Date.parse(`${today}T00:00:00Z`) - 6 * DAY_MS);
		return (
			entry.date >= first.toISOString().slice(0, 10) && entry.date <= today
		);
	}
	if (time.startsWith("m:")) return entry.date.startsWith(time.slice(2));
	return time === "any";
}

function matchesMarks(
	entry: SearchEntry,
	wanted: Sentence["marks"],
	marks: EntryMarks,
): boolean {
	if (wanted.read !== null) {
		if (entry.type !== "paper" || marks.read !== wanted.read) return false;
	}
	if (!wanted.tags.every((tag) => marks.tags.includes(tag))) return false;
	return !wanted.adHoc || marks.adHoc;
}

export type SearchDeps = {
	entries: () => SearchEntry[];
	marksOf: ((id: string) => EntryMarks) | null;
	loadMonths: (months: string[]) => Promise<void>;
	onChange: (shown: Set<string>) => void;
};

export function createSearch(
	root: HTMLElement,
	today: string,
	deps: SearchDeps,
): { focusOn: (subject: string) => void; reset: () => void } {
	throw new Error(`not implemented: ${root.id} ${today} ${deps.marksOf}`);
}
