// Unit tests for lookUpProceedings and addProceedingsToPool in scripts/scout/proceedings/lookup.ts, against a stand-in for
// PoPETs and AAAI's journal site on 127.0.0.1 that serves the pages saved in tests/fixtures/proceedings. Nothing here
// contacts a conference site.
import { readFileSync } from "node:fs";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
	vi,
} from "vitest";
import type {
	Lookup,
	ReadList,
	Run,
} from "../../scripts/scout/arxiv/search.ts";
import type * as Lookup_ from "../../scripts/scout/proceedings/lookup.ts";
import { closeServers, serve } from "./local-server.ts";

const LOOKUP = new URL(
	"../../scripts/scout/proceedings/lookup.ts",
	import.meta.url,
);
const page = (name: string) =>
	readFileSync(
		new URL(`../fixtures/proceedings/${name}`, import.meta.url),
		"utf8",
	);

const TODAY = "2026-10-20";
const PETS_TITLE =
	"Clicking into Exposure: Uncovering Privacy Risks of Google Click Identifier in YouTube Ads";
const AIES_TITLE =
	"Frictionless validation: AI sycophancy and developmental risks";

// What the stand-in has been asked, and the status it answers a path with in place of its page.
const requested: string[] = [];
const failing = new Map<string, number>();
let base = "";
let lookup: typeof Lookup_;

beforeAll(async () => {
	base = await serve((incoming, out) => {
		const path = incoming.url as string;
		requested.push(path);
		const status = failing.get(path);
		if (status !== undefined) {
			out.writeHead(status);
			out.end();
			return;
		}
		let body: string | null = null;
		if (path === "/popets/2026/") {
			body = page("popets-2026-index.html");
		} else if (path === "/popets/2026/popets-2026-0038.php") {
			body = page("popets-2026-0038.html");
		} else if (path === "/index.php/AIES/issue/archive") {
			body = page("aies-archive.html");
		} else if (path === "/index.php/AIES/issue/view/744") {
			body = page("aies-issue-744.html");
		} else if (path === "/index.php/AIES/article/view/43234") {
			body = page("aies-article-43234.html");
		}
		if (body === null) {
			out.writeHead(404);
			out.end();
			return;
		}
		// The saved pages name the real hosts; the stand-in's own address stands in for them.
		out.end(body.replaceAll("https://ojs.aaai.org", base));
	});
	process.env.POPETS_BASE = base;
	process.env.AAAI_OJS_BASE = base;
	process.env.PROCEEDINGS_PAUSE_MS = "0";
	lookup = await import(LOOKUP.href);
});
afterAll(async () => {
	vi.unstubAllEnvs();
	await closeServers();
});
beforeEach(() => {
	requested.length = 0;
	failing.clear();
});

// A list of PETS or AIES holding the title, as search.ts read it.
function listOf(venue: string, title: string): ReadList {
	return {
		venue: venue,
		url: `https://example.org/${venue.toLowerCase()}/2026/accepted.html`,
		published: null,
		titles: [title],
		copyKept: null,
		problem: null,
		matching: [[title]],
	};
}

// The title is known not to be on arXiv.
const notOnArxiv = (title: string): Record<string, Lookup> => ({
	[title
		.toLowerCase()
		.replace(/[^\p{L}\p{N} ]+/gu, " ")
		.replace(/ +/g, " ")
		.trim()]: { id: null, arxivDate: null, checked: "2026-10-01" },
});

const aRun = (): Run => ({ failed: false, arxivStopped: false });

describe("lookUpProceedings", () => {
	test("a PoPETs paper not on arXiv is found through the volume's index and kept with its DOI and the list that named it", async () => {
		const kept = {};
		const run = aRun();
		const changed = await lookup.lookUpProceedings(
			[listOf("PETS", PETS_TITLE)],
			notOnArxiv(PETS_TITLE),
			kept,
			TODAY,
			run,
		);
		expect(changed).toBe(true);
		expect(run.failed).toBe(false);
		const answers = Object.values(kept) as Lookup_.ProceedingsAnswer[];
		expect(answers).toHaveLength(1);
		expect(answers[0]?.checked).toBe(TODAY);
		expect(answers[0]?.paper).toMatchObject({
			id: "doi:10.56553/popets-2026-0038",
			title: PETS_TITLE,
			source: "PoPETs",
			note: "PETS 2026",
			venueSource: "https://example.org/pets/2026/accepted.html",
		});
	});

	test("an AIES paper not on arXiv is found through AAAI's archive and issue pages", async () => {
		const kept = {};
		await lookup.lookUpProceedings(
			[listOf("AIES", AIES_TITLE)],
			notOnArxiv(AIES_TITLE),
			kept,
			TODAY,
			aRun(),
		);
		const answers = Object.values(kept) as Lookup_.ProceedingsAnswer[];
		expect(answers[0]?.paper?.id).toBe("doi:10.1609/aies.v9i2.43234");
		expect(answers[0]?.paper?.note).toBe("AIES 2026");
	});

	test("a paper found in the proceedings earlier is not looked for again: no proceedings page is requested", async () => {
		const kept = {};
		await lookup.lookUpProceedings(
			[listOf("PETS", PETS_TITLE)],
			notOnArxiv(PETS_TITLE),
			kept,
			"2026-10-19",
			aRun(),
		);
		requested.length = 0;
		const changed = await lookup.lookUpProceedings(
			[listOf("PETS", PETS_TITLE)],
			notOnArxiv(PETS_TITLE),
			kept,
			TODAY,
			aRun(),
		);
		expect(changed).toBe(false);
		expect(requested).toEqual([]);
	});

	test("a title missing from the proceedings is looked for again once more than 30 days have passed, and not before", async () => {
		const title = "A privacy study nobody published";
		const missing = {
			[title.toLowerCase()]: { paper: null, checked: "2026-09-19" },
		};
		const recent = {
			[title.toLowerCase()]: { paper: null, checked: "2026-09-20" },
		};
		await lookup.lookUpProceedings(
			[listOf("PETS", title)],
			notOnArxiv(title),
			recent,
			TODAY,
			aRun(),
		);
		expect(requested).toEqual([]);
		await lookup.lookUpProceedings(
			[listOf("PETS", title)],
			notOnArxiv(title),
			missing,
			TODAY,
			aRun(),
		);
		expect(requested).toEqual(["/popets/2026/"]);
		expect(missing[title.toLowerCase()]?.checked).toBe(TODAY);
	});

	test("a title not yet looked up on arXiv, or one from a venue without a proceedings site, makes no request", async () => {
		await lookup.lookUpProceedings(
			[listOf("PETS", PETS_TITLE), listOf("ICML", "Some other paper")],
			{
				...notOnArxiv("Some other paper"),
			},
			{},
			TODAY,
			aRun(),
		);
		expect(requested).toEqual([]);
	});

	test("a conference site that fails is named with what it answered, the run is marked failed, and nothing is kept for the title", async () => {
		failing.set("/popets/2026/", 503);
		const kept = {};
		const run = aRun();
		const written = vi.spyOn(console, "error").mockImplementation(() => {});
		const changed = await lookup.lookUpProceedings(
			[listOf("PETS", PETS_TITLE)],
			notOnArxiv(PETS_TITLE),
			kept,
			TODAY,
			run,
		);
		const said = written.mock.calls.map((call) => String(call[0]));
		written.mockRestore();
		expect(changed).toBe(false);
		expect(run.failed).toBe(true);
		expect(kept).toEqual({});
		expect(said).toEqual([
			`search.ts: PETS 2026 proceedings (${base}/popets/2026/) answered HTTP 503`,
		]);
	});

	test("a site whose proceedings aren't out yet (every index page answers 404) keeps no answer and does not fail the run", async () => {
		failing.set("/popets/2026/", 404);
		const kept = {};
		const run = aRun();
		const changed = await lookup.lookUpProceedings(
			[listOf("PETS", PETS_TITLE)],
			notOnArxiv(PETS_TITLE),
			kept,
			TODAY,
			run,
		);
		expect(changed).toBe(false);
		expect(run.failed).toBe(false);
		expect(kept).toEqual({});
	});

	test("a paper page that fails is named, the run is marked failed, and nothing is kept for its title", async () => {
		failing.set("/popets/2026/popets-2026-0038.php", 500);
		const kept = {};
		const run = aRun();
		const written = vi.spyOn(console, "error").mockImplementation(() => {});
		await lookup.lookUpProceedings(
			[listOf("PETS", PETS_TITLE)],
			notOnArxiv(PETS_TITLE),
			kept,
			TODAY,
			run,
		);
		const said = written.mock.calls.map((call) => String(call[0]));
		written.mockRestore();
		expect(run.failed).toBe(true);
		expect(said[0]).toContain("PETS 2026 paper page");
		expect(said[0]).toContain("answered HTTP 500");
		expect(kept).toEqual({});
	});
});

describe("addProceedingsToPool", () => {
	const paper = {
		id: "doi:10.56553/popets-2026-0038",
		title: PETS_TITLE,
		authors: ["Ada Example"],
		published: "2026",
		abstract: "We read what Google Click Identifiers expose.",
		url: "https://petsymposium.org/popets/2026/popets-2026-0038.php",
		pdf: null,
		source: "PoPETs",
		note: "PETS 2026",
		venueSource: "https://petsymposium.org/2026/paperlist.php",
	};
	const kept = {
		"clicking into exposure uncovering privacy risks of google click identifier in youtube ads":
			{
				paper: paper,
				checked: TODAY,
			},
	};
	const topics = [{ name: "Privacy", phrases: ["privacy risks"] }];

	test("a paper found in its proceedings joins the pool under its DOI, with its venue note and the venue that listed it", () => {
		const pool = {};
		lookup.addProceedingsToPool(
			pool,
			[listOf("PETS", PETS_TITLE)],
			kept,
			topics as never,
			new Set(),
			TODAY,
		);
		expect(pool).toMatchObject({
			[paper.id]: {
				id: paper.id,
				title: PETS_TITLE,
				note: "PETS 2026",
				listed: "PETS",
				firstSeen: TODAY,
			},
		});
	});

	test("a paper already in the digests stays out of the pool", () => {
		const pool = {};
		lookup.addProceedingsToPool(
			pool,
			[listOf("PETS", PETS_TITLE)],
			kept,
			topics as never,
			new Set([paper.id]),
			TODAY,
		);
		expect(pool).toEqual({});
	});

	test("a title with no paper found in the proceedings adds nothing", () => {
		const pool = {};
		lookup.addProceedingsToPool(
			pool,
			[listOf("PETS", PETS_TITLE)],
			{
				"clicking into exposure uncovering privacy risks of google click identifier in youtube ads":
					{
						paper: null,
						checked: TODAY,
					},
			},
			topics as never,
			new Set(),
			TODAY,
		);
		expect(pool).toEqual({});
	});
});
