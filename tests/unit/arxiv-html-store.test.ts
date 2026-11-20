// Unit tests for scripts/scout/arxiv/html-store.ts, the day store of arXiv HTML pages first-page.ts fills and figure.ts reads:
// where the folder is, a page round-tripping through storePage and
// readStoredPage, what readStoredPage returns when nothing is stored, when the copy is too old or when its file is
// unreadable, and the file an id is kept in. Each test gets a fresh ARXIV_HTML_STORE folder, deleted after it.
import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import type { StoredPage } from "../../scripts/scout/arxiv/html-store.ts";
import {
	readStoredPage,
	STORED_PAGE_MS,
	storeFolder,
	storePage,
} from "../../scripts/scout/arxiv/html-store.ts";

// The folder the test under way points ARXIV_HTML_STORE at, and the value it had before, put back afterwards.
let base = "";
let previousBase: string | undefined;

beforeEach(() => {
	previousBase = process.env.ARXIV_HTML_STORE;
	base = mkdtempSync(join(tmpdir(), "liminal-unit-arxiv-html-store-"));
	process.env.ARXIV_HTML_STORE = base;
});

afterEach(() => {
	if (previousBase === undefined) {
		delete process.env.ARXIV_HTML_STORE;
	} else {
		process.env.ARXIV_HTML_STORE = previousBase;
	}
	rmSync(base, { recursive: true, force: true });
});

const HOUR_MS = 3600 * 1000;

// A stored page of an arXiv paper that has an HTML version, as first-page.ts stores it: stored `agoMs` before `now`.
function pageOf(id: string, agoMs: number, now: number): StoredPage {
	return {
		status: 200,
		finalUrl: `https://arxiv.org/html/${id}v1`,
		text: `<html><body><h1>Paper ${id}</h1></body></html>`,
		storedAt: new Date(now - agoMs).toISOString(),
	};
}

// ---- The folder ----

test("the store is liminal-arxiv-html inside ARXIV_HTML_STORE when it is set", () => {
	assert.equal(storeFolder(), join(base, "liminal-arxiv-html"));
});

test("without ARXIV_HTML_STORE the store is liminal-arxiv-html inside the system temp folder", () => {
	delete process.env.ARXIV_HTML_STORE;
	assert.equal(storeFolder(), join(tmpdir(), "liminal-arxiv-html"));
});

// ---- Round trips ----

test("a page stored is read back with its status, final address, text and time", () => {
	const now = Date.now();
	const page = pageOf("2507.11473", 0, now);
	storePage("2507.11473", page);
	assert.deepEqual(readStoredPage("2507.11473", now), page);
});

test("arXiv's 404 is stored and read back with its empty text", () => {
	const now = Date.now();
	const page: StoredPage = {
		status: 404,
		finalUrl: "https://arxiv.org/html/2507.11473",
		text: "",
		storedAt: new Date(now).toISOString(),
	};
	storePage("2507.11473", page);
	assert.deepEqual(readStoredPage("2507.11473", now), page);
});

test("storing a page again replaces the earlier copy", () => {
	const now = Date.now();
	storePage("2507.11473", pageOf("2507.11473", 2 * HOUR_MS, now));
	const fresh = pageOf("2507.11473", 0, now);
	fresh.text = "<html><body>the page as fetched again</body></html>";
	storePage("2507.11473", fresh);
	assert.deepEqual(readStoredPage("2507.11473", now), fresh);
});

test("pages of different ids are kept apart", () => {
	const now = Date.now();
	const first = pageOf("2507.11473", 0, now);
	const second = pageOf("1706.03762", 0, now);
	storePage("2507.11473", first);
	storePage("1706.03762", second);
	assert.deepEqual(readStoredPage("2507.11473", now), first);
	assert.deepEqual(readStoredPage("1706.03762", now), second);
});

// An old-style id in normalizeId form holds a slash; the stub leaves how its file is named to the implementation.
test("an old-style id such as hep-th/9711200 is stored and read back too", () => {
	const now = Date.now();
	const page = pageOf("hep-th/9711200", 0, now);
	storePage("hep-th/9711200", page);
	assert.deepEqual(readStoredPage("hep-th/9711200", now), page);
	assert.equal(readStoredPage("9711200", now), null);
});

// ---- Nothing stored ----

test("nothing stored gives null, whether or not the folder exists", () => {
	assert.equal(existsSync(storeFolder()), false);
	assert.equal(readStoredPage("2507.11473"), null);
	mkdirSync(storeFolder(), { recursive: true });
	assert.equal(readStoredPage("2507.11473"), null);
});

// ---- Age ----

test("a page stored an hour ago is read back", () => {
	const now = Date.now();
	const page = pageOf("2507.11473", HOUR_MS, now);
	storePage("2507.11473", page);
	assert.deepEqual(readStoredPage("2507.11473", now), page);
});

test("a page stored 25 hours ago reads as null and its file is removed", () => {
	const now = Date.now();
	storePage("2507.11473", pageOf("2507.11473", 25 * HOUR_MS, now));
	assert.equal(readdirSync(storeFolder()).length, 1);
	assert.equal(readStoredPage("2507.11473", now), null);
	assert.deepEqual(readdirSync(storeFolder()), []);
	// Gone for good: a later read at an earlier `now` finds nothing either.
	assert.equal(readStoredPage("2507.11473", now - 24 * HOUR_MS), null);
});

test("a page just under 24 hours old is read back, and one 24 hours old reads as null", () => {
	assert.equal(STORED_PAGE_MS, 24 * HOUR_MS);
	const now = Date.now();
	const justUnder = pageOf("2507.11473", STORED_PAGE_MS - 1000, now);
	storePage("2507.11473", justUnder);
	assert.deepEqual(readStoredPage("2507.11473", now), justUnder);
	storePage("1706.03762", pageOf("1706.03762", STORED_PAGE_MS, now));
	assert.equal(readStoredPage("1706.03762", now), null);
});

test("without a given time, a read uses the clock, so a page stored a day and a minute ago reads as null", () => {
	storePage(
		"2507.11473",
		pageOf("2507.11473", STORED_PAGE_MS + 60 * 1000, Date.now()),
	);
	assert.equal(readStoredPage("2507.11473"), null);
	storePage("1706.03762", pageOf("1706.03762", HOUR_MS, Date.now()));
	assert.notEqual(readStoredPage("1706.03762"), null);
});

// ---- A file that doesn't load ----

test("a stored file that is not JSON reads as null and is removed", () => {
	const folder = storeFolder();
	mkdirSync(folder, { recursive: true });
	const file = join(folder, "2507.11473.json");
	writeFileSync(file, "<html>not json at all");
	assert.equal(readStoredPage("2507.11473"), null);
	assert.equal(existsSync(file), false);
});

test("an empty stored file reads as null and is removed", () => {
	const folder = storeFolder();
	mkdirSync(folder, { recursive: true });
	const file = join(folder, "2507.11473.json");
	writeFileSync(file, "");
	assert.equal(readStoredPage("2507.11473"), null);
	assert.equal(existsSync(file), false);
});

test("a file that doesn't load leaves the other pages alone", () => {
	const now = Date.now();
	const kept = pageOf("1706.03762", 0, now);
	storePage("1706.03762", kept);
	writeFileSync(join(storeFolder(), "2507.11473.json"), "{broken");
	assert.equal(readStoredPage("2507.11473", now), null);
	assert.deepEqual(readStoredPage("1706.03762", now), kept);
});

// ---- A store that can't be written ----

// The scripts fetched the page; not keeping it is reported, not thrown. ARXIV_HTML_STORE naming a file is the case
// where even removing the temporary file fails (ENOTDIR).
test("storing a page when ARXIV_HTML_STORE names a file does not throw and stores nothing", () => {
	const file = join(base, "a-file");
	writeFileSync(file, "");
	process.env.ARXIV_HTML_STORE = file;
	const now = Date.now();
	assert.doesNotThrow(() =>
		storePage("2507.11473", pageOf("2507.11473", 0, now)),
	);
	assert.equal(readStoredPage("2507.11473", now), null);
	assert.equal(readFileSync(file, "utf8"), "");
});

// ---- The file: <folder>/<id>.json, holding the page as JSON, which the scenarios write by hand ----

test("a new-style id is kept in <folder>/<id>.json holding the page as JSON, and nothing else is left in the folder", () => {
	const now = Date.now();
	const page = pageOf("2507.11473", 0, now);
	storePage("2507.11473", page);
	const folder = storeFolder();
	assert.deepEqual(readdirSync(folder), ["2507.11473.json"]);
	assert.deepEqual(
		JSON.parse(readFileSync(join(folder, "2507.11473.json"), "utf8")),
		page,
	);
});

test("a page written by hand as <folder>/<id>.json is read", () => {
	const now = Date.now();
	const page = pageOf("2507.11473", HOUR_MS, now);
	const folder = storeFolder();
	mkdirSync(folder, { recursive: true });
	writeFileSync(join(folder, "2507.11473.json"), JSON.stringify(page));
	assert.deepEqual(readStoredPage("2507.11473", now), page);
});
