// The Search sentence: its blanks, what they match, and the choices each blank opens.
import type { SearchEntry } from "../../shared/site-data-shape.ts";

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

export function startingSentence(today: string): Sentence {
	throw new Error(`not implemented: ${today}`);
}

export function matchesSentence(
	entry: SearchEntry,
	sentence: Sentence,
	today: string,
	marks: EntryMarks | null,
): boolean {
	throw new Error(
		`not implemented: ${entry.id} ${sentence.kind} ${today} ${marks?.read}`,
	);
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
