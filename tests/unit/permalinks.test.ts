// @vitest-environment jsdom
// Links to an entry (site/page/permalinks.ts).
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { OlderDay } from "../../site/page/older-day.ts";
import type { PageModel } from "../../site/page/page-model.ts";
import { createPermalinks } from "../../site/page/permalinks.ts";

const NEWEST = "2026-11-10";
const OLDER = "2026-09-12";

// A page whose newest month is November and whose one older day, in September, waits for its month.
function pageWithOlderMonth() {
	const newestSection = document.createElement("section");
	newestSection.dataset.date = NEWEST;
	const article = document.createElement("article");
	article.id = "newest-entry";
	newestSection.append(article);
	const details = document.createElement("details");
	details.dataset.date = OLDER;
	const olderDay: OlderDay = {
		day: { date: OLDER, entries: [] },
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
		header: document.createElement("header"),
		skipped: [],
		warning: null,
	};
	return { model: model, olderDay: olderDay };
}

// `shown`: whether the sentence shows the entry.
function depsFor(shown: boolean) {
	return {
		loadMonth: vi.fn(async () => [] as unknown[]),
		isShown: vi.fn(() => shown),
		showDay: vi.fn(),
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
	test("in a month not loaded shows that day in the sentence, loads the month and draws it", async () => {
		const { model } = pageWithOlderMonth();
		const deps = depsFor(false);
		location.hash = "#september-entry";
		createPermalinks(model, deps).followPermalink();
		await vi.waitFor(() => expect(deps.fillMonth).toHaveBeenCalledOnce());
		expect(deps.showDay).toHaveBeenCalledWith(OLDER);
		expect(deps.loadMonth).toHaveBeenCalledWith("2026-09");
		expect(deps.fillMonth).toHaveBeenCalledWith("2026-09", []);
	});

	test("in a month not loaded draws it without changing the sentence when it already shows the entry", async () => {
		const { model } = pageWithOlderMonth();
		const deps = depsFor(true);
		location.hash = "#september-entry";
		createPermalinks(model, deps).followPermalink();
		await vi.waitFor(() => expect(deps.fillMonth).toHaveBeenCalledOnce());
		expect(deps.showDay).not.toHaveBeenCalled();
	});

	test("in the newest day shows that day in the sentence, without loading a month file, when the sentence hides it", () => {
		const { model } = pageWithOlderMonth();
		const deps = depsFor(false);
		location.hash = "#newest-entry";
		createPermalinks(model, deps).followPermalink();
		expect(deps.showDay).toHaveBeenCalledWith(NEWEST);
		expect(deps.loadMonth).not.toHaveBeenCalled();
	});

	test("in no digest changes nothing", () => {
		const { model } = pageWithOlderMonth();
		const deps = depsFor(false);
		location.hash = "#nothing-here";
		createPermalinks(model, deps).followPermalink();
		expect(deps.showDay).not.toHaveBeenCalled();
		expect(deps.loadMonth).not.toHaveBeenCalled();
	});

	test("in a month that fails to load opens its day for another try", async () => {
		const { model, olderDay } = pageWithOlderMonth();
		const deps = depsFor(true);
		deps.loadMonth.mockRejectedValue(new Error("offline"));
		location.hash = "#september-entry";
		createPermalinks(model, deps).followPermalink();
		await vi.waitFor(() => expect(olderDay.details.open).toBe(true));
		expect(deps.fillMonth).not.toHaveBeenCalled();
	});
});
