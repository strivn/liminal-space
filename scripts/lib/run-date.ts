// The day a script works as: today in Asia/Jakarta, or an earlier day given with --date to fill in a day the scout
// missed. scripts/digests/digests.ts, arxiv.ts, search.ts and surprise.ts share this rule.
// Environment: LIMINAL_TODAY (YYYY-MM-DD), when set, is taken as today in Asia/Jakarta; tests only.
import CONSTANTS from "./constants.json" with { type: "json" };

// How far back --date may go, in days before today.
export const MAX_DAYS_BACK = 7;

const DAY_MS = 24 * 60 * 60 * 1000;
// The en-CA locale writes dates as YYYY-MM-DD.
const JAKARTA_DATE = new Intl.DateTimeFormat("en-CA", {
	timeZone: CONSTANTS.timeZone,
});

// Today's date in Asia/Jakarta, YYYY-MM-DD; LIMINAL_TODAY when it is set.
export function jakartaToday(): string {
	return process.env.LIMINAL_TODAY || JAKARTA_DATE.format(new Date());
}

// The YYYY-MM-DD date `count` days before another one; a negative count goes forward.
export function daysBefore(day: string, count: number): string {
	const time = Date.parse(`${day}T00:00:00Z`) - count * DAY_MS;
	return new Date(time).toISOString().slice(0, 10);
}

// True for a YYYY-MM-DD string naming a day that exists: "2026-02-30" is false.
// A day that doesn't exist either fails to parse or rolls over to another day, so the round trip catches both.
function isRealDay(text: string) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
		return false;
	}
	const date = new Date(`${text}T00:00:00Z`);
	if (Number.isNaN(date.getTime())) {
		return false;
	}
	return date.toISOString().slice(0, 10) === text;
}

// Why a --date value can't be used, as the sentence the script prints, or null when it can. `today` is YYYY-MM-DD in
// Asia/Jakarta. The sentences: "--date must be YYYY-MM-DD", "--date is after today",
// "--date is more than 7 days before today".
export function runDateProblem(value: string, today: string): string | null {
	if (!isRealDay(value)) {
		return "--date must be YYYY-MM-DD";
	}
	// YYYY-MM-DD strings sort as the days they name.
	if (value > today) {
		return "--date is after today";
	}
	if (value < daysBefore(today, MAX_DAYS_BACK)) {
		return `--date is more than ${MAX_DAYS_BACK} days before today`;
	}
	return null;
}

// The command line without its --date option, and the date it gave (null when not given). Takes "--date D" and
// "--date=D". null when --date is given twice or without a value: the caller prints its usage line.
export function takeDateOption(
	args: string[],
): { date: string | null; rest: string[] } | null {
	let date: string | null = null;
	const rest: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === undefined) {
			continue;
		}
		let value: string | undefined;
		if (arg === "--date") {
			i += 1;
			value = args[i];
		} else if (arg.startsWith("--date=")) {
			value = arg.slice("--date=".length);
		} else {
			rest.push(arg);
			continue;
		}
		if (value === undefined || value === "" || date !== null) {
			return null;
		}
		date = value;
	}
	return { date: date, rest: rest };
}
