// Tests of scripts/scout/arxiv/figure.ts run as the scout runs it: a digests file in a temp folder, arXiv's HTML pages on a 127.0.0.1
// stand-in (ARXIV_HTML_BASE), the day's page store in a temp folder, the exit code and what it prints.

import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { afterAll, afterEach, test } from "vitest";
import { closeServers, serve } from "./local-server.ts";
import {
	digestText,
	entriesOfLine,
	removeTempFolders,
	runScript,
	scriptPath,
	tempFolder,
} from "./run-script.ts";

const FIGURE = scriptPath("scout/arxiv/figure.ts");

afterEach(closeServers);
afterAll(removeTempFolders);

// A paper entry as arxiv.ts writes it.
function paper(id: string, extra: Record<string, unknown> = {}) {
	return {
		id: `arxiv:${id}`,
		type: "paper",
		title: `Paper ${id}`,
		authors: ["Ada Example"],
		published: "2026-10-04",
		source: "arXiv Machine Learning",
		url: `https://arxiv.org/abs/${id}`,
		links: [{ label: "PDF", url: `https://arxiv.org/pdf/${id}` }],
		abstract: "Measurements across several benchmarks.",
		...extra,
	};
}

// A page of arXiv's HTML with one figure: its graphic and its caption.
function pageWith(graphic: string, captionText: string): string {
	return `<!doctype html><html><body><article><figure class="ltx_figure">${graphic}<figcaption class="ltx_caption"><span class="ltx_tag ltx_tag_figure">Figure 1: </span>${captionText}</figcaption></figure></article></body></html>`;
}

const OVERVIEW = pageWith(
	'<img src="x1.png" width="698" height="245" alt="Refer to caption">',
	"Overview of the four stages.",
);

// What a stand-in saw: each request's path with the time it arrived and ended.
type Seen = { path: string; arrived: number; ended: number };

// A stand-in for arXiv's HTML pages: pages by path under /html, anything else HTTP 404, and a record of every request.
async function serveHtml(
	pages: Record<string, (response: ServerResponse) => void>,
) {
	const seen: Seen[] = [];
	const base = await serve((incoming: IncomingMessage, response) => {
		const record = {
			path: String(incoming.url),
			arrived: Date.now(),
			ended: 0,
		};
		seen.push(record);
		response.on("finish", () => {
			record.ended = Date.now();
		});
		const answer = pages[record.path];
		if (answer === undefined) {
			response.writeHead(404);
			response.end();
			return;
		}
		answer(response);
	});
	return { base: `${base}/html`, seen: seen };
}

function html(text: string): (response: ServerResponse) => void {
	return (response) => {
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		response.end(text);
	};
}

function status(code: number): (response: ServerResponse) => void {
	return (response) => {
		response.writeHead(code);
		response.end();
	};
}

type Setup = { file: string; folder: string; store: string };

// A digests file of one line holding these entries, and an empty store folder, in fresh temp folders.
function setup(entries: unknown[], more: string[] = []): Setup {
	const folder = tempFolder("liminal-unit-figure-");
	const file = join(folder, "digests.js");
	writeFileSync(
		file,
		`${[digestText("2026-10-04", entries), ...more].join("\n")}\n`,
	);
	return {
		file: file,
		folder: folder,
		store: tempFolder("liminal-unit-store-"),
	};
}

// figure.ts for these ids; the delay is 0 unless a test measures it.
function runFigure(
	run: Setup,
	base: string,
	ids: string[],
	env: Record<string, string> = {},
) {
	return runScript(FIGURE, [run.file, ...ids], {
		ARXIV_HTML_BASE: base,
		ARXIV_HTML_STORE: run.store,
		FIGURE_DELAY_MS: "0",
		...env,
	});
}

function firstLineEntries(file: string) {
	return entriesOfLine(readFileSync(file, "utf8").split("\n")[0] ?? "");
}

function storeFile(run: Setup, id: string): string {
	return join(run.store, "liminal-arxiv-html", `${id}.json`);
}

test("A Figure 1 is recorded with its caption, size and page address, replacing an older figure, without downloading the image", async () => {
	const { base, seen } = await serveHtml({
		"/html/2609.35544": (response) => {
			response.writeHead(302, { location: "/html/2609.35544v1/" });
			response.end();
		},
		"/html/2609.35544v1/": html(OVERVIEW),
		"/html/2609.35545": html(pageWith('<img src="a.svg">', "Teaser.")),
	});
	const run = setup([
		paper("2609.35544"),
		paper("2609.35545", {
			figure: { src: "figures/2609.35545.png", caption: "Old." },
		}),
	]);
	const ran = await runFigure(run, base, ["2609.35544", "2609.35545"]);
	assert.equal(ran.code, 0, ran.stderr);
	assert.equal(ran.stdout, `added 2 figures to ${run.file}\n`);
	const [first, second] = firstLineEntries(run.file);
	assert.deepEqual(first, {
		...paper("2609.35544"),
		figure: {
			src: `${base}/2609.35544v1/x1.png`,
			caption: "Figure 1: Overview of the four stages.",
			from: `${base}/2609.35544v1/`,
			width: 698,
			height: 245,
		},
	});
	assert.deepEqual((second as { figure: unknown }).figure, {
		src: `${base}/a.svg`,
		caption: "Figure 1: Teaser.",
		from: `${base}/2609.35545`,
	});
	assert.equal(
		seen.some((request) => request.path.endsWith(".png")),
		false,
		"the image itself is never requested",
	);
});

test("A paper with no Figure 1 image gets no figure and its reason is reported, and the run still exits 0", async () => {
	const { base } = await serveHtml({
		"/html/2609.00001": html(
			"<html><body><p>No figure at all.</p></body></html>",
		),
		"/html/2609.00002": html(
			"<html><body><figure><table><tr><td>x</td></tr></table><figcaption><span>Figure 1: </span>A table.</figcaption></figure></body></html>",
		),
		"/html/2609.00003": html(pageWith('<img src="x1.eps">', "An EPS file.")),
		"/html/2609.00004": status(404),
	});
	const ids = ["2609.00001", "2609.00002", "2609.00003", "2609.00004"];
	const run = setup(ids.map((id) => paper(id)));
	const ran = await runFigure(run, base, ids);
	assert.equal(ran.code, 0, ran.stderr);
	assert.equal(ran.stdout, `added 0 figures to ${run.file}\n`);
	assert.match(ran.stderr, /2609\.00001: it has no Figure 1/);
	assert.match(ran.stderr, /2609\.00002: its Figure 1 holds no image file/);
	assert.match(
		ran.stderr,
		/2609\.00003: its image isn't PNG, JPEG, GIF, WebP or SVG/,
	);
	assert.match(
		ran.stderr,
		/2609\.00004: arXiv has no HTML version of 2609\.00004/,
	);
	for (const entry of firstLineEntries(run.file)) {
		assert.equal("figure" in entry, false, String(entry.id));
	}
});

test("A failed request is reported with its cause and the run exits non-zero, but the paper before it still gets its figure", async () => {
	const { base } = await serveHtml({
		"/html/2609.00001": html(OVERVIEW),
		"/html/2609.00002": status(503),
	});
	const run = setup([paper("2609.00001"), paper("2609.00002")]);
	const ran = await runFigure(run, base, ["2609.00001", "2609.00002"]);
	assert.notEqual(ran.code, 0);
	assert.match(ran.stderr, /2609\.00002: answered HTTP 503/);
	const [first, second] = firstLineEntries(run.file);
	assert.ok(first && "figure" in first);
	assert.ok(second && !("figure" in second));
});

test("A run whose only paper fails leaves the digests file unchanged, byte for byte", async () => {
	const { base } = await serveHtml({ "/html/2609.00002": status(503) });
	const run = setup([paper("2609.00002")]);
	const before = readFileSync(run.file, "utf8");
	const ran = await runFigure(run, base, ["2609.00002"]);
	assert.notEqual(ran.code, 0);
	assert.equal(readFileSync(run.file, "utf8"), before);
});

test("limit: A run adds figures to the first 10 papers given and lists the rest to run again", async () => {
	const ids = Array.from(
		{ length: 12 },
		(_, n) => `2609.${String(n + 10).padStart(5, "0")}`,
	);
	const pages: Record<string, (response: ServerResponse) => void> = {};
	for (const id of ids) {
		pages[`/html/${id}`] = html(OVERVIEW);
	}
	const { base, seen } = await serveHtml(pages);
	const run = setup(ids.map((id) => paper(id)));
	const ran = await runFigure(run, base, ids);
	assert.equal(ran.code, 0, ran.stderr);
	assert.equal(seen.length, 10);
	assert.equal(ran.stdout.split("\n")[0], `added 10 figures to ${run.file}`);
	assert.match(
		ran.stdout,
		new RegExp(`${ids[10]}, ${ids[11]}; run the same command again`),
	);
	const entries = firstLineEntries(run.file);
	assert.equal(entries.filter((entry) => "figure" in entry).length, 10);
	assert.equal("figure" in (entries[10] ?? {}), false);
});

test("limit: The wait between two HTML requests starts when the first one has finished", async () => {
	const { base, seen } = await serveHtml({
		"/html/2609.00001": html(OVERVIEW),
		"/html/2609.00002": html(OVERVIEW),
	});
	const run = setup([paper("2609.00001"), paper("2609.00002")]);
	const ran = await runFigure(run, base, ["2609.00001", "2609.00002"], {
		FIGURE_DELAY_MS: "400",
	});
	assert.equal(ran.code, 0, ran.stderr);
	assert.equal(seen.length, 2);
	const [first, second] = seen;
	assert.ok(first && second);
	// A timer may fire a millisecond early.
	assert.ok(
		second.arrived - first.ended >= 395,
		`the second request came ${second.arrived - first.ended} ms after the first ended`,
	);
});

test("A paper that already has a figure, an id with no entry, and an argument that is not an arXiv id are reported, and nothing is fetched", async () => {
	const { base, seen } = await serveHtml({
		"/html/2609.00001": html(OVERVIEW),
	});
	const run = setup([
		paper("2609.00001", {
			figure: {
				src: "https://arxiv.org/html/2609.00001v1/x1.png",
				caption: "Figure 1: Kept.",
			},
		}),
	]);
	const ran = await runFigure(run, base, ["2609.00001", "2601.99999", "hello"]);
	assert.notEqual(ran.code, 0);
	assert.match(ran.stderr, /2609\.00001: already has a figure/);
	assert.match(ran.stderr, /2601\.99999: no paper entry for 2601\.99999/);
	assert.match(ran.stderr, /hello: not an arXiv id/);
	assert.deepEqual(seen, []);
});

test("privacy: Lines the run does not change keep their bytes, and a line that does not load stops the run before any request and is reported by number only", async () => {
	const { base, seen } = await serveHtml({
		"/html/2609.00001": html(OVERVIEW),
	});
	const untouched = digestText("2026-10-01", [paper("2601.00001")]);
	const good = setup([paper("2609.00001")], [untouched]);
	const ran = await runFigure(good, base, ["2609.00001"]);
	assert.equal(ran.code, 0, ran.stderr);
	const lines = readFileSync(good.file, "utf8").split("\n");
	assert.equal(lines[1], untouched);

	const before = seen.length;
	const bad = setup([paper("2609.00001")], ["SECRET-7f3a(not a digest)"]);
	const refused = await runFigure(bad, base, ["2609.00001"]);
	assert.notEqual(refused.code, 0);
	assert.match(refused.stderr, /line 2 of .* doesn't load/);
	assert.equal(
		(refused.stdout + refused.stderr).includes("SECRET-7f3a"),
		false,
	);
	assert.equal(seen.length, before, "no request");
});

test("Missing arguments print the usage line, and a digests file that does not exist is reported", async () => {
	const run = setup([]);
	const usage = await runScript(FIGURE, [run.file]);
	assert.notEqual(usage.code, 0);
	assert.match(usage.stderr, /usage: node scripts\/scout\/arxiv\/figure\.ts/);
	const missing = await runScript(FIGURE, [
		join(run.folder, "none.js"),
		"2609.00001",
	]);
	assert.notEqual(missing.code, 0);
	assert.match(missing.stderr, /doesn't exist/);
});

// A page as first-page.ts stores it, `agoMs` ago, at the store's file for `id`.
function storeAt(
	run: Setup,
	id: string,
	page: { status: number; finalUrl: string; text: string },
	agoMs: number,
) {
	mkdirSync(join(run.store, "liminal-arxiv-html"), { recursive: true });
	writeFileSync(
		storeFile(run, id),
		JSON.stringify({
			...page,
			storedAt: new Date(Date.now() - agoMs).toISOString(),
		}),
	);
}

const HOUR = 3600 * 1000;

test("A page stored an hour ago gives the figure with no request, and a stored 404 is reported as no HTML version", async () => {
	const { base, seen } = await serveHtml({});
	const run = setup([paper("2609.00001"), paper("2609.00002")]);
	storeAt(
		run,
		"2609.00001",
		{ status: 200, finalUrl: `${base}/2609.00001v1/`, text: OVERVIEW },
		HOUR,
	);
	storeAt(
		run,
		"2609.00002",
		{ status: 404, finalUrl: `${base}/2609.00002`, text: "" },
		HOUR,
	);
	const ran = await runFigure(run, base, ["2609.00001", "2609.00002"], {
		FIGURE_DELAY_MS: "60000",
	});
	assert.equal(ran.code, 0, ran.stderr);
	assert.deepEqual(seen, []);
	const [first] = firstLineEntries(run.file);
	assert.deepEqual((first as { figure: unknown }).figure, {
		src: `${base}/2609.00001v1/x1.png`,
		caption: "Figure 1: Overview of the four stages.",
		from: `${base}/2609.00001v1/`,
		width: 698,
		height: 245,
	});
	assert.match(
		ran.stderr,
		/2609\.00002: arXiv has no HTML version of 2609\.00002/,
	);
});

test("A page stored 25 hours ago is fetched again, and the new copy replaces the stored one", async () => {
	const { base, seen } = await serveHtml({
		"/html/2609.00001": html(OVERVIEW),
	});
	const run = setup([paper("2609.00001")]);
	storeAt(
		run,
		"2609.00001",
		{ status: 404, finalUrl: `${base}/2609.00001`, text: "" },
		25 * HOUR,
	);
	const ran = await runFigure(run, base, ["2609.00001"]);
	assert.equal(ran.code, 0, ran.stderr);
	assert.equal(seen.length, 1);
	const kept = JSON.parse(readFileSync(storeFile(run, "2609.00001"), "utf8"));
	assert.equal(kept.status, 200);
	assert.equal(kept.finalUrl, `${base}/2609.00001`);
	assert.equal(kept.text, OVERVIEW);
	assert.deepEqual(readdirSync(join(run.store, "liminal-arxiv-html")), [
		"2609.00001.json",
	]);
});
