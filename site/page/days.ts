// Dates and counts as the page writes them: day labels, the header's day and progress line and the heatmap's squares.
import { readCounts } from "./state.ts";
import type { Day, Entry, HeatLevel, ReadCounts, ReadState } from "./types.ts";

const JAKARTA_DATE = new Intl.DateTimeFormat("en-CA", {
	timeZone: "Asia/Jakarta",
});
const DAY_LABEL = new Intl.DateTimeFormat("en-GB", {
	weekday: "long",
	day: "numeric",
	month: "long",
	timeZone: "UTC",
});
export const LONG_DATE = new Intl.DateTimeFormat("en-GB", {
	day: "numeric",
	month: "long",
	year: "numeric",
	timeZone: "UTC",
});
// "17 October": the day a shelf's paper appeared.
export const DAY_MONTH = new Intl.DateTimeFormat("en-GB", {
	day: "numeric",
	month: "long",
	timeZone: "UTC",
});
const DAY_MS = 86400000;

// Same-date lines become one day (entries in append order); newest day first.
export function mergeDays(lines: Day[]): Day[] {
	const byDate = new Map<string, Entry[]>();
	for (const line of lines) {
		let dayEntries = byDate.get(line.date);
		if (dayEntries === undefined) {
			dayEntries = [];
			byDate.set(line.date, dayEntries);
		}
		dayEntries.push(...(line.entries || []));
	}
	return [...byDate]
		.map(([date, entries]) => ({ date, entries }))
		.sort((a, b) => b.date.localeCompare(a.date));
}

// Today's date in Asia/Jakarta as YYYY-MM-DD, whatever the machine's time zone.
export function jakartaToday(now: Date): string {
	return JAKARTA_DATE.format(now);
}

// "2026-09-27" -> "Sunday 27 September". Dates are read as UTC so the machine's zone can't shift them.
export function dayLabel(date: string): string {
	return DAY_LABEL.format(new Date(`${date}T00:00:00Z`));
}

// "2026-09-26" -> "Sat 26 Sep". Built by hand: Intl's en-GB short month for September is "Sept".
const SHORT_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const SHORT_MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];
export function shortDayLabel(date: string): string {
	const day = new Date(`${date}T00:00:00Z`);
	return (
		SHORT_WEEKDAYS[day.getUTCDay()] +
		" " +
		day.getUTCDate() +
		" " +
		SHORT_MONTHS[day.getUTCMonth()]
	);
}

export function itemCount(n: number) {
	return n + (n === 1 ? " item" : " items");
}

// The header's day line: the newest digest's day, like "Sunday 27 September", and the
// stale warning "No new digest for N days" when it is 2 or more days old (a scout run failed), else null. Null when
// there is no digest.
export type HeaderDay = { day: string; warning: string | null };
export function headerDay(days: Day[], today: string): HeaderDay | null {
	const newest = days[0];
	if (newest === undefined) return null;
	const age = Math.round(
		(Date.parse(`${today}T00:00:00Z`) -
			Date.parse(`${newest.date}T00:00:00Z`)) /
			DAY_MS,
	);
	let warning: string | null = null;
	if (age >= 2) warning = `No new digest for ${age} days`;
	return { day: dayLabel(newest.date), warning: warning };
}

// "3 of 6 papers read", "0 of 1 paper read".
function papersReadText(read: number, total: number): string {
	return `${read} of ${plural(total, "paper")} read`;
}

// The progress line under the header: how many of a day's papers have read state at depth "abstract" or "paper",
// out of how many papers; its text is "3 of 6 papers read". News, articles and reports count nowhere.
export type PaperProgress = { read: number; total: number; text: string };
export function paperProgress(
	entries: Entry[],
	state: ReadState,
): PaperProgress {
	const counts = readCounts(entries, state);
	return {
		read: counts.read,
		total: counts.total,
		text: papersReadText(counts.read, counts.total),
	};
}

// Whether a day's square shows a crown: at least one of its papers has read state at depth "paper".
export function dayCrowned(
	entries: { id: string; type: string }[],
	state: ReadState,
): boolean {
	return readCounts(entries, state).papers > 0;
}

// Whether the week starting on `monday` shows a crown under its column: each of its 7 days has at least one paper
// with read state at depth "abstract" or "paper". `entriesByDate` holds every day the page knows, also days left of
// the heatmap; a day with no entry in it has no paper read.
export function weekCrowned(
	monday: string,
	entriesByDate: Map<string, { id: string; type: string }[]>,
	state: ReadState,
): boolean {
	const start = Date.parse(`${monday}T00:00:00Z`);
	for (let offset = 0; offset < 7; offset++) {
		const date = new Date(start + offset * DAY_MS).toISOString().slice(0, 10);
		const entries = entriesByDate.get(date) || [];
		if (readCounts(entries, state).read === 0) return false;
	}
	return true;
}

// A square's shade: no digest, nothing read, up to half read, more than half, or all. In whole numbers, so exactly
// half is "some".
export function heatLevel(read: number, total: number): HeatLevel {
	if (total === 0) return "no-digest";
	if (read === 0) return "none";
	if (read * 2 <= total) return "some";
	if (read < total) return "most";
	return "all";
}

// The heatmap's days: the last 84 (12 weeks), oldest first, ending today. Dates are counted in UTC, like dayLabel,
// so the machine's zone and daylight saving can't shift them.
const HEATMAP_DAYS = 84;
export function heatmapDays(today: string): string[] {
	const end = Date.parse(`${today}T00:00:00Z`);
	const days: string[] = [];
	for (let back = HEATMAP_DAYS - 1; back >= 0; back--)
		days.push(new Date(end - back * DAY_MS).toISOString().slice(0, 10));
	return days;
}

// "1 paper", "2 papers".
export function plural(n: number, word: string) {
	if (n === 1) return `${n} ${word}`;
	return `${n} ${word}s`;
}

// The caption under the heatmap: "Sun 27 Sep · 3 of 5 papers read", "Sun 27 Sep · no papers" for a day of news
// alone, or "Sun 27 Sep · no digest".
export function heatCaption(date: string, counts: ReadCounts): string {
	const label = shortDayLabel(date);
	if (counts.items === 0) return `${label} · no digest`;
	if (counts.total === 0) return `${label} · no papers`;
	return `${label} · ${papersReadText(counts.read, counts.total)}`;
}

// A square's title: "Sun 27 Sep · 2 of 3 papers read · 1 abstract, 1 paper". Parts with no papers are left out.
export function heatTitle(date: string, counts: ReadCounts): string {
	const title = heatCaption(date, counts);
	if (counts.total === 0) return title;
	const parts: string[] = [];
	if (counts.abstracts) parts.push(plural(counts.abstracts, "abstract"));
	if (counts.papers) parts.push(plural(counts.papers, "paper"));
	if (!parts.length) return title;
	return `${title} · ${parts.join(", ")}`;
}
