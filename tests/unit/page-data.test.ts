// @vitest-environment jsdom
// The page's data files: which page this is, where its files are, the index and the month loader (site/page/data.ts).
import { afterEach, expect, test, vi } from "vitest";
import { FIELD_CAPS } from "../../shared/entry-checks.ts";
import { OPENALEX_CAPS } from "../../shared/openalex.ts";
import {
	createMonthLoader,
	fetchJson,
	isOwnerPage,
	readIndex,
	readSearchFile,
	siteFile,
} from "../../site/page/data.ts";

afterEach(() => {
	vi.unstubAllGlobals();
	history.replaceState(null, "", "/");
});

test("the owner's page is the one served under /owner/, and its files sit one folder up", () => {
	history.replaceState(null, "", "/liminal-space/owner/");
	expect(isOwnerPage()).toBe(true);
	expect(siteFile("data/index.json")).toBe("../data/index.json");
	history.replaceState(null, "", "/liminal-space/owner/index.html");
	expect(isOwnerPage()).toBe(true);
});

test("any other address is the public page, whose files sit beside it", () => {
	history.replaceState(null, "", "/liminal-space/");
	expect(isOwnerPage()).toBe(false);
	expect(siteFile("data/index.json")).toBe("data/index.json");
	history.replaceState(null, "", "/liminal-space/owner-notes/");
	expect(isOwnerPage()).toBe(false);
});

test("reading the index drops malformed days, entries and month files, and any day whose month has no file", () => {
	const index = readIndex({
		days: [
			{
				date: "2026-10-16",
				month: "2026-10",
				entries: [
					{ id: "arxiv:1", type: "paper" },
					{ id: 2, type: "paper" },
					{ id: "arxiv:3" },
					null,
				],
			},
			{ month: "2026-10", entries: [] },
			{ date: "2026-10-15", month: "2026-09", entries: [] },
			{ date: "2026-10-14", month: "2026-10", entries: "none" },
			"2026-10-13",
		],
		months: { "2026-10": "months/a.json", "2026-09": 7 },
	});
	expect(index).toEqual({
		days: [
			{
				date: "2026-10-16",
				month: "2026-10",
				entries: [{ id: "arxiv:1", type: "paper" }],
			},
		],
		months: { "2026-10": "months/a.json" },
	});
});

test.each([
	["a file that is not an object", "text"],
	["a file with no days", { months: {} }],
	["a file whose days aren't a list", { days: {}, months: {} }],
	["a file with no months", { days: [] }],
])("%s is not read as an index", (_name, json) => {
	expect(readIndex(json)).toBeNull();
});

test('security: a month named "__proto__" or "constructor" counts only when the index lists it, and changes no other object', () => {
	const index = readIndex(
		JSON.parse(
			'{"days": [{"date": "2026-10-16", "month": "constructor", "entries": []}], "months": {"__proto__": "months/x.json"}}',
		),
	);
	expect(index?.days).toEqual([]);
	expect(Object.keys(index?.months ?? {})).toEqual(["__proto__"]);
	expect(({} as Record<string, unknown>).x).toBeUndefined();
});

test("a file's answer carries its status and its JSON, or null when it isn't JSON", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (path: string) => {
			if (path === "ok") return Response.json({ a: 1 });
			return new Response("<html>", { status: 502 });
		}),
	);
	expect(await fetchJson("ok")).toEqual({ status: 200, json: { a: 1 } });
	expect(await fetchJson("bad")).toEqual({ status: 502, json: null });
});

test("a file that gets no answer reads as status 0", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new TypeError("offline");
		}),
	);
	expect(await fetchJson("data/index.json")).toEqual({ status: 0, json: null });
});

test("a month the index doesn't name can't be loaded", async () => {
	vi.stubGlobal("fetch", vi.fn());
	const load = createMonthLoader({ days: [], months: {} });
	await expect(load("2026-10")).rejects.toThrow(
		"The index names no file for 2026-10",
	);
});

test("a month is fetched once and the same answer is given after that", async () => {
	const fetching = vi.fn(async () => Response.json({ lines: [1, 2] }));
	vi.stubGlobal("fetch", fetching);
	const load = createMonthLoader({ days: [], months: { "2026-10": "a.json" } });
	const first = load("2026-10");
	expect(load("2026-10")).toBe(first);
	expect(await first).toEqual([1, 2]);
	expect(fetching).toHaveBeenCalledTimes(1);
});

test("a month file without a list of lines can't be loaded, and is asked for again next time", async () => {
	const fetching = vi.fn(async () => Response.json({ lines: "none" }));
	vi.stubGlobal("fetch", fetching);
	const load = createMonthLoader({ days: [], months: { "2026-10": "a.json" } });
	await expect(load("2026-10")).rejects.toThrow(
		"The file for 2026-10 couldn't be loaded",
	);
	await expect(load("2026-10")).rejects.toThrow();
	expect(fetching).toHaveBeenCalledTimes(2);
});

test("a month file that answers 404 after a newer deploy is fetched once more under its name in a fresh copy of the index", async () => {
	const answers: Record<string, () => Response> = {
		"data/a.json": () => new Response("", { status: 404 }),
		"data/index.json": () =>
			Response.json({ days: [], months: { "2026-10": "b.json" } }),
		"data/b.json": () => Response.json({ lines: ["new"] }),
	};
	const fetching = vi.fn(async (path: string) => {
		const answer = answers[path];
		if (answer === undefined) throw new Error(`unexpected ${path}`);
		return answer();
	});
	vi.stubGlobal("fetch", fetching);
	const load = createMonthLoader({ days: [], months: { "2026-10": "a.json" } });
	expect(await load("2026-10")).toEqual(["new"]);
	expect(fetching.mock.calls.map((call) => call[0])).toEqual([
		"data/a.json",
		"data/index.json",
		"data/b.json",
	]);
});

test("a month file that answers 404 fails when a fresh copy of the index names the same file", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (path: string) => {
			if (path === "data/index.json")
				return Response.json({ days: [], months: { "2026-10": "a.json" } });
			return new Response("", { status: 404 });
		}),
	);
	const load = createMonthLoader({ days: [], months: { "2026-10": "a.json" } });
	await expect(load("2026-10")).rejects.toThrow(
		"The file for 2026-10 couldn't be loaded",
	);
});

const SEARCH_ENTRY = {
	id: "arxiv:2611.00002",
	date: "2026-11-02",
	type: "paper",
	topic: { name: "Adversarial Robustness", field: "Computer Science" },
	keywords: ["jailbreak detection"],
	venue: "ACL 2026",
};

test("security: a search file that is not the search shape is refused, and the Search sentence then offers no topics, keywords or venues", () => {
	for (const json of [
		null,
		"entries",
		[SEARCH_ENTRY],
		{},
		{ entries: "none" },
		{ entries: { 0: SEARCH_ENTRY } },
	]) {
		expect(readSearchFile(json)).toBeNull();
	}
	const dropped = [
		{ ...SEARCH_ENTRY, id: 7 },
		{ ...SEARCH_ENTRY, date: "2026-13-40" },
		{ ...SEARCH_ENTRY, type: null },
		{ ...SEARCH_ENTRY, topic: undefined },
		{ ...SEARCH_ENTRY, topic: { name: "Ethics" } },
		{ ...SEARCH_ENTRY, topic: { name: " ", field: "Computer Science" } },
		{ ...SEARCH_ENTRY, keywords: "jailbreak detection" },
		{ ...SEARCH_ENTRY, keywords: ["jailbreak detection", 4] },
		{ ...SEARCH_ENTRY, keywords: ["x".repeat(OPENALEX_CAPS.text + 1)] },
		{ ...SEARCH_ENTRY, keywords: Array(OPENALEX_CAPS.keywords + 1).fill("a") },
		{ ...SEARCH_ENTRY, venue: undefined },
		{ ...SEARCH_ENTRY, venue: ["ACL 2026"] },
		{ ...SEARCH_ENTRY, venue: "v".repeat(FIELD_CAPS.source + 1) },
		null,
		"arxiv:1",
	];
	const kept = { ...SEARCH_ENTRY, topic: null, venue: null };
	const file = readSearchFile({
		entries: [
			...dropped,
			{ ...SEARCH_ENTRY, owner: "a note", html: "<img src=x onerror=1>" },
			kept,
		],
	});
	expect(file).toEqual({ entries: [SEARCH_ENTRY, kept] });
});
