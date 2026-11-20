// @vitest-environment jsdom
// Links to an entry (site/page/permalinks.ts). jsdom lays nothing out; only which month is chosen and loaded is tested.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { OlderDay } from "../../site/page/older-day.ts";
import type { PageModel } from "../../site/page/page-model.ts";
import { createPermalinks } from "../../site/page/permalinks.ts";

const NEWEST = "2026-11-10";

// A page whose newest month is November and whose one older day, in September, waits for its month.
function pageWithOlderMonth(selectedMonth: string | null) {
	const newestSection = document.createElement("section");
	const article = document.createElement("article");
	article.id = "newest-entry";
	newestSection.append(article);
	const details = document.createElement("details");
	const olderDay: OlderDay = {
		day: { date: "2026-09-12", entries: [] },
		details: details as HTMLDetailsElement,
		month: "2026-09",
		ids: ["september-entry"],
		indexEntries: [],
		error: null,
	};
	document.body.append(newestSection, details);
	const model: PageModel = {
		newest: { date: NEWEST, entries: [] },
		newestSection: newestSection,
		newestDate: NEWEST,
		today: NEWEST,
		olderPairs: [olderDay],
		selectedMonth: selectedMonth,
		header: document.createElement("header"),
		skipped: [],
		warning: null,
	};
	return { model: model, olderDay: olderDay };
}

function depsFor() {
	return {
		loadMonth: vi.fn(async () => [] as unknown[]),
		selectMonth: vi.fn(async () => undefined),
		fillMonth: vi.fn(),
		showDayError: vi.fn(),
	};
}

beforeEach(() => {
	Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
	document.body.replaceChildren();
	location.hash = "";
	vi.restoreAllMocks();
});

describe("a link to an entry", () => {
	test("in a month not loaded selects that month, loads it and draws it", async () => {
		const { model } = pageWithOlderMonth("2026-11");
		const deps = depsFor();
		location.hash = "#september-entry";
		createPermalinks(model, deps).followPermalink();
		await vi.waitFor(() => expect(deps.fillMonth).toHaveBeenCalledOnce());
		expect(deps.selectMonth).toHaveBeenCalledWith("2026-09");
		expect(deps.loadMonth).toHaveBeenCalledWith("2026-09");
		expect(deps.fillMonth).toHaveBeenCalledWith("2026-09", []);
	});

	test("in a month not loaded draws it without selecting the month again when that month is already selected", async () => {
		const { model } = pageWithOlderMonth("2026-09");
		const deps = depsFor();
		location.hash = "#september-entry";
		createPermalinks(model, deps).followPermalink();
		await vi.waitFor(() => expect(deps.fillMonth).toHaveBeenCalledOnce());
		expect(deps.selectMonth).not.toHaveBeenCalled();
	});

	test("in the newest day selects the newest month, without loading a month file, when another month is selected", () => {
		const { model } = pageWithOlderMonth("2026-09");
		const deps = depsFor();
		location.hash = "#newest-entry";
		createPermalinks(model, deps).followPermalink();
		expect(deps.selectMonth).toHaveBeenCalledWith("2026-11");
		expect(deps.loadMonth).not.toHaveBeenCalled();
	});

	test("in no digest changes nothing", () => {
		const { model } = pageWithOlderMonth("2026-11");
		const deps = depsFor();
		location.hash = "#nothing-here";
		createPermalinks(model, deps).followPermalink();
		expect(deps.selectMonth).not.toHaveBeenCalled();
		expect(deps.loadMonth).not.toHaveBeenCalled();
	});

	test("in a month that fails to load opens its day for another try", async () => {
		const { model, olderDay } = pageWithOlderMonth("2026-11");
		const deps = depsFor();
		deps.loadMonth.mockRejectedValue(new Error("offline"));
		location.hash = "#september-entry";
		createPermalinks(model, deps).followPermalink();
		await vi.waitFor(() => expect(olderDay.details.open).toBe(true));
		expect(deps.fillMonth).not.toHaveBeenCalled();
	});
});
