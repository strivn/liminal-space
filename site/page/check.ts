// The page's own check of the digest lines: what it can draw, and what it leaves out and why.
import { hasText, isDay } from "../../shared/entry-checks.ts";
import { isJsonObject } from "../../shared/narrow.ts";
import type { Day, Entry, Skipped } from "./types.ts";

// Why an entry can't be drawn, as reasons for the header's warning; none when it can. These are the fields
// renderEntry relies on: one that is missing or of another shape stops the whole day from drawing.
export function entryProblems(entry: unknown) {
	if (!isJsonObject(entry)) return ["it isn't an object"];
	const problems: string[] = [];
	if (!hasText(entry.id)) problems.push("it has no id");
	if (!hasText(entry.type)) problems.push("it has no type");
	if (!hasText(entry.title)) problems.push("it has no title");
	if (entry.published !== undefined && !isDay(entry.published))
		problems.push("published isn't YYYY-MM-DD");
	const authorsAreNames =
		Array.isArray(entry.authors) &&
		entry.authors.every((name) => typeof name === "string");
	if (entry.authors !== undefined && !authorsAreNames)
		problems.push("authors isn't a list");
	if (entry.links !== undefined && !Array.isArray(entry.links))
		problems.push("links isn't a list");
	return problems;
}

// Split the digest lines into what the page can draw and what it can't. A line needs a real YYYY-MM-DD date and a
// list of entries; each entry needs the fields entryProblems checks. Returns { lines, skipped }: the lines that can
// be drawn, holding only their entries that can (a line left with none is dropped), and one { id, reason, count }
// per entry or line left out, where a line's "id" is "line dated <date>" and count is how many entries the item
// stands for in the header's warning.
export function checkDigests(lines: unknown[]): {
	lines: Day[];
	skipped: Skipped[];
} {
	const kept: Day[] = [];
	const skipped: Skipped[] = [];
	lines.forEach((line, index) => {
		if (!isJsonObject(line)) {
			skipped.push({
				id: `line ${index + 1}`,
				reason: "it isn't an object",
				count: 1,
			});
			return;
		}
		let lineName = `line ${index + 1}`;
		if (typeof line.date === "string") lineName = `line dated ${line.date}`;
		const lineProblems: string[] = [];
		if (!isDay(line.date)) lineProblems.push("its date isn't YYYY-MM-DD");
		if (!Array.isArray(line.entries))
			lineProblems.push("its entries aren't a list");
		if (lineProblems.length) {
			skipped.push({
				id: lineName,
				reason: lineProblems.join("; "),
				count: lineEntryCount(line),
			});
			return;
		}

		// TypeScript can't follow lineProblems: the check above returned for a line without a real date or a list.
		const date = line.date as string;
		const lineEntries = line.entries as unknown[];
		const entries: Entry[] = [];
		lineEntries.forEach((entry, position) => {
			const problems = entryProblems(entry);
			if (problems.length === 0) {
				// entryProblems found nothing: the entry has every field Entry promises.
				entries.push(entry as Entry);
				return;
			}
			// An entry without a usable id is named by where it sits.
			let name = `entry ${position + 1} of the ${lineName}`;
			if (isJsonObject(entry) && hasText(entry.id)) name = entry.id;
			skipped.push({ id: name, reason: problems.join("; "), count: 1 });
		});
		// A line with nothing left to draw would show as an empty day, "· 0 items"; what was left out is still named.
		if (entries.length > 0) {
			kept.push({ date: date, entries: entries });
		}
	});
	return { lines: kept, skipped: skipped };
}

// How many entries a line left out stands for: all its entries, or one when it has none or they aren't a list, so
// a line the warning names never counts as nothing.
function lineEntryCount(line: Record<string, unknown>) {
	if (Array.isArray(line.entries) && line.entries.length > 0)
		return line.entries.length;
	return 1;
}
