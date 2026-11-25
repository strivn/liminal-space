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
export type IndexEntry = { id: string; type: string };

// data/months/YYYY-MM.<hash>.json: that month's digest lines as the digests file holds them, in file order, each
// {"date", "entries"} with every field of every entry. <hash> is the first 12 hex digits of the SHA-256 of the
// file's bytes, so a name changes exactly when the content does, and month files are cached for good.
export type MonthFile = { lines: MonthLine[] };
export type MonthLine = { date: string; entries: unknown[] };

// data/selected.json, newest mark first.
export type SelectedFile = { papers: SelectedPaper[] };
export type SelectedPaper = { entry: unknown; date: string; note: string };

// Where the files sit under the published page folder (<output folder>/liminal-space/).
export const SELECTED_PATH = "data/selected.json";
export const INDEX_PATH = "data/index.json";
export const MONTHS_FOLDER = "data/months";
