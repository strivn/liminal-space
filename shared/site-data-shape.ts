// The static data the hosted page reads, as scripts/deploy/build-site.ts writes it and scripts/deploy/sync.ts pull reads it.
// Types only, so the page (site/page/), the scripts and the tests share one description.

// data/index.json: every day, newest first, with its entries' id and type in the order the page lists them, and the
// file that holds the day's month. About 40 bytes an entry. Cached briefly ("no-cache"), so it can change.
//   {"days": [{"date": "2026-10-16", "month": "2026-10", "entries": [{"id": "arxiv:2610.00001", "type": "paper"}]}],
//    "months": {"2026-10": "months/2026-10.3f9a1c2b7d4e.json"}}
// Month file names are relative to data/.
export type SiteIndex = {
	days: IndexDay[];
	months: Record<string, string>;
};
export type IndexDay = {
	date: string;
	month: string;
	entries: IndexEntry[];
};
// study names the entry's words file, STUDY_WORDS_PATH, relative to the page's folder, for an entry with a study.
export type IndexEntry = { id: string; type: string; study?: string };
export const STUDY_WORDS_PATH = /^study\/words\/[0-9a-f]{16}\.json$/;

// data/months/YYYY-MM.<hash>.json: that month's digest lines as the digests file holds them, in file order, each
// {"date", "entries"} with every field of every entry. <hash> is the first 12 hex digits of the SHA-256 of the
// file's bytes, so a name changes exactly when the content does, and month files are cached for good.
export type MonthFile = { lines: MonthLine[] };
export type MonthLine = { date: string; entries: unknown[] };

// Where the files sit under the published page folder (<output folder>/liminal-space/).
export const INDEX_PATH = "data/index.json";
export const MONTHS_FOLDER = "data/months";
export const STUDY_FOLDER = "study";
export const STUDY_CHARS_FOLDER = `${STUDY_FOLDER}/chars`;

// study/chars/<codepoint>.json: one character a study uses. The file's name and content never change with a deploy,
// so browsers keep it for a year. Everything but `character` is copied as written from hanzi-writer-data and Make Me
// a Hanzi; a character one of them lacks has null there.
export type CharFile = {
	character: string;
	// Hanzi Writer's data for the character.
	drawing: CharDrawing | null;
	// Make Me a Hanzi's row for the character, as dictionary.txt writes it.
	dictionary: CharDictionaryRow | null;
	// The components of the row's decomposition, in order, each with what the dictionary says about it.
	parts: CharPart[];
};
export type CharDrawing = {
	strokes: string[];
	medians: number[][][];
	radStrokes?: number[];
};
export type CharDictionaryRow = {
	character: string;
	definition?: string;
	pinyin: string[];
	decomposition: string;
	radical: string;
	etymology?: {
		type: "ideographic" | "pictographic" | "pictophonetic";
		hint?: string;
		phonetic?: string;
		semantic?: string;
	};
	matches: (number[] | null)[];
};
// role: "semantic" or "phonetic" when the row's etymology names the part so.
export type CharPart = {
	character: string;
	pinyin?: string[];
	definition?: string;
	role?: "semantic" | "phonetic";
};

// A character's file, relative to the page's folder: the character's code point in lower-case hex.
export function charFilePath(character: string): string {
	const codePoint = character.codePointAt(0);
	if (codePoint === undefined) {
		throw new Error("a character file needs a character");
	}
	return `${STUDY_CHARS_FOLDER}/${codePoint.toString(16)}.json`;
}
