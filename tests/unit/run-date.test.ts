// Unit tests for scripts/lib/run-date.ts: runDateProblem(value, today), the --date rule digests.ts, arxiv.ts, search.ts and
// surprise.ts share. Each test is named after what the --date scenarios of the features say.

import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type * as RunDate from "../../scripts/lib/run-date.ts";

const SCRIPT = new URL("../../scripts/lib/run-date.ts", import.meta.url);

// The three refusals, as the contract writes them.
const MALFORMED = "--date must be YYYY-MM-DD";
const AFTER_TODAY = "--date is after today";
const TOO_EARLY = "--date is more than 7 days before today";

test("today is the date in Asia/Jakarta: at 18:00 UTC it is already the next day", async () => {
	const { jakartaToday }: typeof RunDate = await import(SCRIPT.href);
	const set = process.env.LIMINAL_TODAY;
	delete process.env.LIMINAL_TODAY;
	vi.useFakeTimers({ toFake: ["Date"] });
	try {
		vi.setSystemTime(new Date("2026-11-18T18:00:00Z"));
		assert.equal(jakartaToday(), "2026-11-19");
		vi.setSystemTime(new Date("2026-11-18T16:59:00Z"));
		assert.equal(jakartaToday(), "2026-11-18");
	} finally {
		vi.useRealTimers();
		if (set !== undefined) process.env.LIMINAL_TODAY = set;
	}
});

test("A --date of today is accepted", async () => {
	const { runDateProblem }: typeof RunDate = await import(SCRIPT.href);
	assert.equal(runDateProblem("2026-10-12", "2026-10-12"), null);
});

test("A --date 1 to 7 days before today is accepted", async () => {
	const { runDateProblem }: typeof RunDate = await import(SCRIPT.href);
	assert.equal(runDateProblem("2026-10-11", "2026-10-12"), null);
	assert.equal(runDateProblem("2026-10-05", "2026-10-12"), null);
});

test("A --date 8 days before today is refused", async () => {
	const { runDateProblem }: typeof RunDate = await import(SCRIPT.href);
	assert.equal(runDateProblem("2026-10-04", "2026-10-12"), TOO_EARLY);
	assert.equal(runDateProblem("2025-10-12", "2026-10-12"), TOO_EARLY);
});

// Today is 3 October, so 7 days back is 26 September, across the month's end.
test("The 7 days count back across a month's end", async () => {
	const { runDateProblem }: typeof RunDate = await import(SCRIPT.href);
	assert.equal(runDateProblem("2026-09-26", "2026-10-03"), null);
	assert.equal(runDateProblem("2026-09-25", "2026-10-03"), TOO_EARLY);
});

test("A --date after today is refused", async () => {
	const { runDateProblem }: typeof RunDate = await import(SCRIPT.href);
	assert.equal(runDateProblem("2026-10-13", "2026-10-12"), AFTER_TODAY);
	assert.equal(runDateProblem("2027-01-01", "2026-10-12"), AFTER_TODAY);
});

test("A --date that isn't a real YYYY-MM-DD date is refused", async () => {
	const { runDateProblem }: typeof RunDate = await import(SCRIPT.href);
	const malformed = [
		"2026-10-4",
		"2026-02-30",
		"2026-13-01",
		"10-10-2026",
		"2026-10-10T00:00",
		"",
	];
	for (const value of malformed) {
		assert.equal(runDateProblem(value, "2026-10-12"), MALFORMED, value);
	}
});
