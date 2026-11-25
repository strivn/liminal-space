// The marked papers Selected lists: the public page's from data/selected.json, the owner's from their saved marks.
import { isDay } from "../../shared/entry-checks.ts";
import { isJsonObject } from "../../shared/narrow.ts";
import { SELECTED_PATH, type SiteIndex } from "../../shared/site-data-shape.ts";
import { checkDigests, entryProblems } from "./check.ts";
import { fetchJson, type MonthLoader, siteFile } from "./data.ts";
import { mergeDays } from "./days.ts";
import type { MarkedPaper } from "./selected-view.ts";
import type { Entry, Standouts } from "./types.ts";

// The public page's marked papers, newest mark first as the file holds them. A paper with no usable entry, day or note
// is left out and logged; a file that can't be read holds none.
export async function fetchMarkedPapers(): Promise<MarkedPaper[]> {
	const answer = await fetchJson(siteFile(SELECTED_PATH));
	const json = answer.json;
	if (
		answer.status !== 200 ||
		!isJsonObject(json) ||
		!Array.isArray(json.papers)
	)
		return [];
	const papers: MarkedPaper[] = [];
	const listed: unknown[] = json.papers;
	for (const paper of listed) {
		if (
			!isJsonObject(paper) ||
			!isDay(paper.date) ||
			typeof paper.note !== "string" ||
			entryProblems(paper.entry).length > 0
		) {
			console.warn("A marked paper can't be shown:", paper);
			continue;
		}
		// entryProblems found nothing: the entry has every field Entry promises.
		papers.push({
			entry: paper.entry as Entry,
			date: paper.date,
			note: paper.note,
		});
	}
	return papers;
}

// The owner's marked papers: each id's entry read from its month, which the index names, so a paper from a month the
// page hasn't loaded is loaded now. A paper whose month can't be read, or that no digest holds, is left out.
export async function ownerMarkedPapers(
	marks: Standouts,
	index: SiteIndex,
	loadMonth: MonthLoader,
): Promise<MarkedPaper[]> {
	const monthOf = new Map<string, string>();
	for (const day of index.days)
		for (const entry of day.entries) monthOf.set(entry.id, day.month);
	const ids = Object.keys(marks);
	const months = new Set<string>();
	for (const id of ids) {
		const month = monthOf.get(id);
		if (month !== undefined) months.add(month);
	}
	const entries = new Map<string, Entry>();
	await Promise.all(
		[...months].map(async (month) => {
			try {
				const lines = checkDigests(await loadMonth(month)).lines;
				for (const day of mergeDays(lines))
					for (const entry of day.entries) entries.set(entry.id, entry);
			} catch (error) {
				console.error(`${month} not loaded for Selected:`, error);
			}
		}),
	);
	const papers: MarkedPaper[] = [];
	for (const id of ids) {
		const entry = entries.get(id);
		const mark = marks[id];
		if (entry !== undefined && mark !== undefined)
			papers.push({ entry: entry, date: mark.date, note: mark.note });
	}
	return papers;
}
