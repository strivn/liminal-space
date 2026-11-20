// Tests of scripts/scout/surprise.ts run as the scout runs it: Quanta's API and pages, Nature's feed and pages, arXiv and
// Crossref as stand-ins on 127.0.0.1, a digests file in a temp folder, the exit code and what it prints.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { afterAll, afterEach, test } from "vitest";
import { closeServers, serve } from "./local-server.ts";
import {
	digestText,
	removeTempFolders,
	runScript,
	scriptPath,
	tempFolder,
} from "./run-script.ts";

const SURPRISE = scriptPath("scout/surprise.ts");
// Today in the runs; the last 7 days are 2026-10-06 to 2026-10-12.
const TODAY = "2026-10-12";

afterEach(closeServers);
afterAll(removeTempFolders);

type Answer = { status?: number; type?: string; body: string };

// A Quanta post: its address is the stand-in's base and `path`, or `absolute` when it names another site.
type Post = { date: string; path: string; title: string; absolute?: string };
type NatureItem = { path: string; title: string; date: string };

// What the stand-in serves. Filled in after the server starts, since the stories' addresses hold its port.
type World = {
	posts: Post[];
	nature: NatureItem[];
	// Story pages by path, under /quanta-site or /nature-site.
	pages: Record<string, string>;
	// arXiv's primary category and first day by id.
	arxiv: Record<string, { category: string; published: string }>;
	// Crossref's records by DOI: the journal and day, or a status.
	crossref: Record<string, { journal: string; day: string } | number>;
	// A status that replaces a whole service's answer.
	quantaStatus: number | null;
	natureStatus: number | null;
	arxivStatus: number | null;
	// Story page paths that answer a status.
	pageStatus: Record<string, number>;
};

function emptyWorld(): World {
	return {
		posts: [],
		nature: [],
		pages: {},
		arxiv: {},
		crossref: {},
		quantaStatus: null,
		natureStatus: null,
		arxivStatus: null,
		pageStatus: {},
	};
}

// A page of story text linking these addresses.
function pageLinking(...links: string[]): string {
	const paragraphs = links.map((href) => `<p><a href="${href}">link</a></p>`);
	return `<html><body><article>${paragraphs.join("")}</article></body></html>`;
}

function atom(ids: string[], arxiv: World["arxiv"]): string {
	const entries: string[] = [];
	for (const id of ids) {
		const facts = arxiv[id];
		if (facts === undefined) {
			continue;
		}
		entries.push(
			`<entry><id>http://arxiv.org/abs/${id}v1</id><title>Paper ${id}</title>` +
				`<updated>${facts.published}T00:00:00Z</updated><link href="https://arxiv.org/abs/${id}v1" rel="alternate" type="text/html"/>` +
				`<summary>Summary.</summary><category term="${facts.category}" scheme="http://arxiv.org/schemas/atom"/>` +
				`<published>${facts.published}T00:00:00Z</published><arxiv:primary_category term="${facts.category}"/>` +
				"<author><name>Ada Example</name></author></entry>",
		);
	}
	return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns="http://www.w3.org/2005/Atom"><opensearch:totalResults>${entries.length}</opensearch:totalResults>${entries.join("")}</feed>`;
}

type Stand = {
	base: string;
	world: World;
	seen: string[];
	state: { mostOpen: number };
};

// The stand-ins for every service on one server; `seen` holds the request URLs, `state.mostOpen` the most requests open
// at once.
async function serveWorld(): Promise<Stand> {
	const world = emptyWorld();
	const seen: string[] = [];
	const state = { mostOpen: 0 };
	let open = 0;
	let base = "";
	base = await serve((incoming: IncomingMessage, response: ServerResponse) => {
		const url = String(incoming.url);
		seen.push(url);
		open += 1;
		state.mostOpen = Math.max(state.mostOpen, open);
		response.on("close", () => {
			open -= 1;
		});
		const answer = answerFor(world, base, url);
		response.writeHead(answer.status ?? 200, {
			"content-type": answer.type ?? "text/plain",
		});
		response.end(answer.body);
	});
	return { base: base, world: world, seen: seen, state: state };
}

function answerFor(world: World, base: string, url: string): Answer {
	const path = url.split("?")[0] ?? "";
	if (path === "/quanta/posts") {
		if (world.quantaStatus !== null) {
			return { status: world.quantaStatus, body: "" };
		}
		const posts = world.posts.map((post) => ({
			date: `${post.date}T09:00:00`,
			link: post.absolute ?? `${base}${post.path}`,
			title: { rendered: post.title },
			content: { rendered: "" },
		}));
		return { type: "application/json", body: JSON.stringify(posts) };
	}
	if (path === "/nature.rss") {
		if (world.natureStatus !== null) {
			return { status: world.natureStatus, body: "" };
		}
		const items = world.nature.map(
			(item) =>
				`<item><title><![CDATA[${item.title}]]></title><link>${base}${item.path}</link><dc:date>${item.date}</dc:date></item>`,
		);
		return {
			type: "application/rss+xml",
			body: `<rdf:RDF>${items.join("")}</rdf:RDF>`,
		};
	}
	if (path === "/arxiv") {
		if (world.arxivStatus !== null) {
			return { status: world.arxivStatus, body: "Rate exceeded." };
		}
		const listed = /id_list=([^&]*)/.exec(url);
		const ids = (listed?.[1] ?? "").split(",");
		return { type: "application/atom+xml", body: atom(ids, world.arxiv) };
	}
	if (path.startsWith("/crossref/works/")) {
		return crossrefAnswer(world, decodeURIComponent(path.slice(16)));
	}
	const status = world.pageStatus[path];
	if (status !== undefined) {
		return { status: status, body: "" };
	}
	const page = world.pages[path];
	if (page !== undefined) {
		return { type: "text/html", body: page };
	}
	return { status: 404, body: "" };
}

function crossrefAnswer(world: World, doi: string): Answer {
	const record = world.crossref[doi];
	if (record === undefined) {
		return { status: 404, body: "" };
	}
	if (typeof record === "number") {
		return { status: record, body: "" };
	}
	const [year, month, day] = record.day.split("-").map(Number);
	const message = {
		DOI: doi,
		title: ["A journal paper"],
		author: [{ given: "Ada", family: "Example" }],
		"container-title": [record.journal],
		published: { "date-parts": [[year, month, day]] },
	};
	return {
		type: "application/json",
		body: JSON.stringify({ message: message }),
	};
}

// surprise.ts against the stand-in, with a digests file holding these lines (null: a file that doesn't exist).
function runSurprise(
	stand: Stand,
	lines: string[] | null,
	args: string[] = [],
) {
	const folder = tempFolder("liminal-unit-surprise-");
	const file = join(folder, "digests.js");
	if (lines !== null) {
		writeFileSync(file, `${lines.join("\n")}\n`);
	}
	const base = stand.base;
	return runScript(SURPRISE, [...args, file], {
		QUANTA_API: `${base}/quanta`,
		QUANTA_SITE: `${base}/quanta-site/`,
		NATURE_FEED: `${base}/nature.rss`,
		NATURE_SITE: `${base}/nature-site/`,
		ARXIV_API: `${base}/arxiv`,
		CROSSREF_API: `${base}/crossref`,
		SURPRISE_PAGE_PAUSE_MS: "0",
		ARXIV_PAUSE_MS: "0",
		LIMINAL_TODAY: TODAY,
		// arXiv's pacing record goes in the run's own folder, not in the machine's temp folder.
		TMPDIR: folder,
	});
}

const RECENT = { category: "astro-ph.CO", published: "2026-09-20" };

// A paper entry for the digests file.
function paperLine(id: string) {
	return digestText("2026-10-01", [
		{
			id: `arxiv:${id}`,
			type: "paper",
			title: "In the digests",
			authors: ["Ada Example"],
			published: "2026-10-01",
			source: "arXiv",
			url: `https://arxiv.org/abs/${id}`,
			links: [],
			abstract: "Measurements.",
		},
	]);
}

// A channel's printed part: its heading line (heading and "none" are one line) and the lines under it.
function section(stdout: string, name: string): string[] {
	const lines = stdout.split("\n");
	const start = lines.findIndex((line) => line.startsWith(`${name} (`));
	assert.ok(start >= 0, `a "${name}" heading in ${stdout}`);
	let end = lines.length;
	for (let index = start + 1; index < lines.length; index++) {
		if (/^[a-z]+ \(/.test(lines[index] ?? "")) {
			end = index;
			break;
		}
	}
	return lines.slice(start, end).filter((line) => line !== "");
}

test("limit: Quanta's stories come newest first, each with the first paper its page links and a DOI paper's journal, one request at a time", async () => {
	const stand = await serveWorld();
	const world = stand.world;
	world.posts = [
		{ date: "2026-10-10", path: "/quanta-site/two", title: "Two days ago" },
		{ date: "2026-10-11", path: "/quanta-site/one", title: "Yesterday" },
		{ date: "2026-10-12", path: "/quanta-site/zero", title: "Today" },
	];
	world.pages = {
		"/quanta-site/two": pageLinking("https://arxiv.org/abs/2610.01234"),
		"/quanta-site/one": pageLinking("https://arxiv.org/pdf/2609.55555v2"),
		"/quanta-site/zero": pageLinking("https://doi.org/10.1073/pnas.2523198122"),
	};
	world.arxiv = { "2610.01234": RECENT, "2609.55555": RECENT };
	world.crossref = {
		"10.1073/pnas.2523198122": { journal: "PNAS", day: "2026-09-30" },
	};
	const ran = await runSurprise(stand, null);
	assert.equal(ran.code, 0, ran.stderr);
	assert.deepEqual(section(ran.stdout, "quanta").slice(1), [
		`2026-10-12 doi:10.1073/pnas.2523198122 Today ${stand.base}/quanta-site/zero | PNAS`,
		`2026-10-11 arxiv:2609.55555 Yesterday ${stand.base}/quanta-site/one`,
		`2026-10-10 arxiv:2610.01234 Two days ago ${stand.base}/quanta-site/two`,
	]);
	assert.equal(stand.state.mostOpen, 1);
});

test("security: A Quanta story whose address is on another site is never read", async () => {
	const stand = await serveWorld();
	const elsewhere = await serveWorld();
	stand.world.posts = [
		{
			date: "2026-10-11",
			path: "",
			absolute: `${elsewhere.base}/story`,
			title: "Elsewhere",
		},
	];
	const ran = await runSurprise(stand, null);
	assert.equal(ran.code, 0, ran.stderr);
	assert.deepEqual(elsewhere.seen, []);
	assert.match(ran.stderr, /Quanta story not read, its address is not on /);
	assert.deepEqual(section(ran.stdout, "quanta"), [
		"quanta (stories from the last 7 days that link a paper, newest first): none",
	]);
});

test("A dataset a Nature story cites first doesn't hide its paper, and a paper already in the digests is marked", async () => {
	const stand = await serveWorld();
	const world = stand.world;
	world.nature = [
		{
			path: "/nature-site/articles/d41586-026-00001-1",
			title: "Spider silk",
			date: "2026-10-11",
		},
		{
			path: "/nature-site/articles/d41586-026-00002-2",
			title: "Already here",
			date: "2026-10-10",
		},
	];
	world.pages = {
		"/nature-site/articles/d41586-026-00001-1": pageLinking(
			"https://doi.org/10.5281/zenodo.123456",
			"https://doi.org/10.1038%2Fs41586-026-05678-9",
		),
		"/nature-site/articles/d41586-026-00002-2": pageLinking(
			"https://arxiv.org/abs/2610.01234",
		),
	};
	world.crossref = {
		"10.1038/s41586-026-05678-9": { journal: "Nature", day: "2026-10-01" },
	};
	const ran = await runSurprise(stand, [paperLine("2610.01234")]);
	assert.equal(ran.code, 0, ran.stderr);
	assert.deepEqual(section(ran.stdout, "nature").slice(1), [
		`2026-10-11 doi:10.1038/s41586-026-05678-9 Spider silk ${stand.base}/nature-site/articles/d41586-026-00001-1 | Nature`,
		`2026-10-10 arxiv:2610.01234 Already here ${stand.base}/nature-site/articles/d41586-026-00002-2 (in digests)`,
	]);
	assert.match(
		ran.stderr,
		/Crossref doesn't know doi:10\.5281\/zenodo\.123456; passed over/,
	);
});

test("An arXiv paper in an AI category is left out and named", async () => {
	const stand = await serveWorld();
	stand.world.posts = [
		{ date: "2026-10-11", path: "/quanta-site/ai", title: "An AI paper" },
	];
	stand.world.pages = {
		"/quanta-site/ai": pageLinking("https://arxiv.org/abs/1706.03762"),
	};
	stand.world.arxiv = {
		"1706.03762": { category: "cs.CL", published: "2026-10-01" },
	};
	const ran = await runSurprise(stand, null);
	assert.equal(ran.code, 0, ran.stderr);
	assert.match(
		ran.stderr,
		/left out arxiv:1706\.03762, an AI paper \(cs\.CL\)/,
	);
	assert.deepEqual(section(ran.stdout, "quanta"), [
		"quanta (stories from the last 7 days that link a paper, newest first): none",
	]);
});

test("A paper whose field can't be read is kept and marked field unknown, and the run exits 0", async () => {
	const stand = await serveWorld();
	stand.world.posts = [
		{ date: "2026-10-11", path: "/quanta-site/x", title: "Unknown field" },
	];
	stand.world.pages = {
		"/quanta-site/x": pageLinking("https://arxiv.org/abs/2607.15352"),
	};
	stand.world.arxivStatus = 429;
	const ran = await runSurprise(stand, null);
	assert.equal(ran.code, 0, ran.stderr);
	assert.match(
		section(ran.stdout, "quanta")[1] ?? "",
		/^2026-10-11 arxiv:2607\.15352 Unknown field .* \(field unknown\)$/,
	);
	assert.match(ran.stderr, /arXiv answered HTTP 429/);
});

test("When Quanta or Nature fails the other is still listed, and when both fail the run names both and exits non-zero", async () => {
	const stand = await serveWorld();
	stand.world.nature = [
		{
			path: "/nature-site/articles/d41586-026-00001-1",
			title: "Spider silk",
			date: "2026-10-11",
		},
	];
	stand.world.pages = {
		"/nature-site/articles/d41586-026-00001-1": pageLinking(
			"https://arxiv.org/abs/2610.01234",
		),
	};
	stand.world.arxiv = { "2610.01234": RECENT };
	stand.world.quantaStatus = 503;
	const one = await runSurprise(stand, null);
	assert.equal(one.code, 0, one.stderr);
	assert.match(
		one.stderr,
		new RegExp(`Quanta answered HTTP 503 \\(${stand.base}/quanta/posts`),
	);
	assert.match(
		section(one.stdout, "nature")[1] ?? "",
		/arxiv:2610\.01234 Spider silk/,
	);
	assert.match(one.stdout, /quanta \(.*\): not available/);

	stand.world.natureStatus = 503;
	const both = await runSurprise(stand, null);
	assert.notEqual(both.code, 0);
	assert.match(both.stderr, /Quanta answered HTTP 503/);
	assert.match(
		both.stderr,
		new RegExp(`Nature answered HTTP 503 \\(${stand.base}/nature.rss\\)`),
	);
});

test("A story page that can't be read is named and the other story is still listed", async () => {
	const stand = await serveWorld();
	stand.world.posts = [
		{ date: "2026-10-11", path: "/quanta-site/broken", title: "Broken" },
		{ date: "2026-10-10", path: "/quanta-site/fine", title: "Fine" },
	];
	stand.world.pageStatus = { "/quanta-site/broken": 404 };
	stand.world.pages = {
		"/quanta-site/fine": pageLinking("https://arxiv.org/abs/2610.01234"),
	};
	stand.world.arxiv = { "2610.01234": RECENT };
	const ran = await runSurprise(stand, null);
	assert.equal(ran.code, 0, ran.stderr);
	assert.match(
		ran.stderr,
		new RegExp(
			`Quanta story page answered HTTP 404 \\(${stand.base}/quanta-site/broken\\)`,
		),
	);
	assert.equal(section(ran.stdout, "quanta").length, 2);
});

test("privacy: A digests line that doesn't load is named by number and never quoted, and nothing is requested", async () => {
	const stand = await serveWorld();
	const ran = await runSurprise(stand, [
		paperLine("2601.00001"),
		"SECRET-7f3a(not a digest)",
	]);
	assert.notEqual(ran.code, 0);
	assert.match(ran.stderr, /line 2 of .* doesn't load/);
	assert.equal((ran.stdout + ran.stderr).includes("SECRET-7f3a"), false);
	assert.deepEqual(stand.seen, []);
});

test("With --date, the 7 days end on that day for both Quanta and Nature, and Quanta's API is asked for those days only", async () => {
	const stand = await serveWorld();
	const world = stand.world;
	world.posts = [
		{ date: "2026-10-02", path: "/quanta-site/early", title: "Too early" },
		{ date: "2026-10-05", path: "/quanta-site/fits", title: "Fits" },
		{ date: "2026-10-11", path: "/quanta-site/late", title: "After the day" },
	];
	world.nature = [
		{
			path: "/nature-site/articles/d41586-026-00001-1",
			title: "Fits too",
			date: "2026-10-05",
		},
		{
			path: "/nature-site/articles/d41586-026-00002-2",
			title: "Too late",
			date: "2026-10-11",
		},
	];
	const link = pageLinking("https://arxiv.org/abs/2610.01234");
	world.pages = {
		"/quanta-site/early": link,
		"/quanta-site/fits": link,
		"/quanta-site/late": link,
		"/nature-site/articles/d41586-026-00001-1": link,
		"/nature-site/articles/d41586-026-00002-2": link,
	};
	world.arxiv = { "2610.01234": RECENT };
	const ran = await runSurprise(stand, null, ["--date", "2026-10-10"]);
	assert.equal(ran.code, 0, ran.stderr);
	const asked = stand.seen.find((url) => url.startsWith("/quanta/posts"));
	assert.ok(asked?.includes("after=2026-10-04T00:00:00"), String(asked));
	assert.ok(asked?.includes("before=2026-10-11T00:00:00"), String(asked));
	assert.equal(section(ran.stdout, "quanta").length, 2);
	assert.match(section(ran.stdout, "quanta")[1] ?? "", / Fits /);
	assert.equal(section(ran.stdout, "nature").length, 2);
	assert.match(section(ran.stdout, "nature")[1] ?? "", / Fits too /);
});

test("A --date after today, and missing arguments, stop before any request", async () => {
	const stand = await serveWorld();
	const late = await runSurprise(stand, null, ["--date", "2026-10-13"]);
	assert.notEqual(late.code, 0);
	assert.match(late.stderr, /--date is after today/);
	const usage = await runScript(SURPRISE, [], { LIMINAL_TODAY: TODAY });
	assert.notEqual(usage.code, 0);
	assert.match(usage.stderr, /usage: node scripts\/scout\/surprise\.ts/);
	assert.deepEqual(stand.seen, []);
});
