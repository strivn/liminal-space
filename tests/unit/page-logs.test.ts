// @vitest-environment jsdom
// The owner's Logs view: the scout's runs, each with its log.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { showScoutLogs } from "../../site/page/scout-logs.ts";
import { openingView } from "../../site/page/selected.ts";
import {
	type FakeSite,
	openPage,
	paperEntry,
	releasePage,
	siteOf,
	texts,
} from "./page-site.ts";

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	// 12:00 on Sunday 27 September 2026 in Jakarta.
	vi.setSystemTime(new Date("2026-09-27T05:00:00Z"));
});

afterEach(() => {
	releasePage();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	history.replaceState(null, "", "/");
	document.body.replaceChildren();
});

const TODAY = "2026-09-27";
const LOGS = "api/owner/logs";
const settle = () => new Promise((done) => setTimeout(done, 0));

function run(id: string, date: string, log: string) {
	return { id: id, date: date, log: log, updated: `${date}T05:00:00.000Z` };
}

function ownerSite(): FakeSite {
	const site = siteOf([
		{ date: TODAY, entries: [paperEntry("2609.00001", "P1")] },
	]);
	site.owner = {
		read: {},
		tags: {},
		comments: {},
		feedback: {},
		takeaways: {},
		standouts: {},
	};
	site.files[LOGS] = {
		logs: [run("a", TODAY, "Scout run done: 8 papers")],
	};
	return site;
}

const logsView = () => {
	const found = document.getElementById("logs-view");
	if (found === null) throw new Error("no Logs view");
	return found;
};

async function go(hash: string) {
	location.hash = hash;
	window.dispatchEvent(new HashChangeEvent("hashchange"));
	await settle();
}

test("The owner's menu reads Selected, Feed and Logs; the public page's has no Logs", async () => {
	const site = ownerSite();
	await openPage(site, { owner: true });
	expect(texts("#views a")).toEqual(["Selected", "Feed", "Logs"]);
	releasePage();

	await openPage(site);
	expect(texts("#views a")).toEqual(["Selected", "Feed"]);
});

test("#logs opens Logs on the owner's page and Selected on the public page", async () => {
	expect(openingView("#logs", true)).toBe("logs");
	expect(openingView("#logs", false)).toBe("selected");

	const site = ownerSite();
	await openPage(site, { owner: true, hash: "#logs" });
	await settle();
	expect(logsView().hidden).toBe(false);
	expect(texts(".scout-log__text")).toEqual(["Scout run done: 8 papers"]);
	releasePage();

	await openPage(site, { hash: "#logs" });
	expect(logsView().hidden).toBe(true);
	expect(document.getElementById("selected-view")?.hidden).toBe(false);
	expect(site.requested.filter((path) => path === LOGS)).toEqual([LOGS]);
});

test("Logs asks for the scout's logs only when it first opens", async () => {
	const site = ownerSite();
	await openPage(site, { owner: true });
	await settle();
	expect(site.requested).not.toContain(LOGS);

	await go("#logs");
	await go("#feed");
	await go("#logs");
	expect(site.requested.filter((path) => path === LOGS)).toEqual([LOGS]);
});

test("Neither Selected nor Feed shows the scout's logs", async () => {
	const site = ownerSite();
	await openPage(site, { owner: true, hash: "#logs" });
	await settle();
	await go("#feed");
	expect(document.getElementById("digests")?.hidden).toBe(false);
	expect(logsView().hidden).toBe(true);
	await go("#selected");
	expect(logsView().hidden).toBe(true);
	expect(document.querySelector(".scout-logs")).toBeNull();
});

// ---- the view's content ----

function answering(status: number, body: unknown) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json(body, { status: status })),
	);
}

function root() {
	const node = document.createElement("main");
	document.body.replaceChildren(node);
	return node;
}

test("Logs lists each run as the site sends it, newest first, with its log", async () => {
	answering(200, {
		logs: [
			run("b", "2026-10-28", "Scout run done: 8 papers"),
			run("a", "2026-10-27", "Nothing found: arXiv refused every search"),
		],
	});
	await showScoutLogs(root());
	expect(texts(".scout-log__text")).toEqual([
		"Scout run done: 8 papers",
		"Nothing found: arXiv refused every search",
	]);
});

test("security: a run's log is shown as text, never as HTML", async () => {
	answering(200, {
		logs: [run("a", "2026-10-28", '<img src=x onerror="alert(1)">')],
	});
	await showScoutLogs(root());
	expect(document.querySelector(".scout-log img")).toBeNull();
	expect(texts(".scout-log__text")).toEqual(['<img src=x onerror="alert(1)">']);
});

test("with no runs Logs says so, and when the logs can't be read it says it couldn't load them", async () => {
	answering(200, { logs: [] });
	const view = root();
	await showScoutLogs(view);
	expect(view.textContent).toContain("No runs in the last 30 days");
	answering(500, {});
	await showScoutLogs(view);
	expect(view.textContent).toContain("Couldn't load the scout logs");
	expect(view.textContent).not.toContain("No runs in the last 30 days");
});
