// Unit tests for scripts/scout/arxiv/first-page.ts, run as the scout runs it, against servers on 127.0.0.1 only.
import { execFile } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, expect, test } from "vitest";
import { twoPagePdf } from "../support/pdf.ts";
import { closeServers, serve } from "./local-server.ts";
import { removeTempFolders, runScript, tempFolder } from "./run-script.ts";

const SCRIPT = new URL(
	"../../scripts/scout/arxiv/first-page.ts",
	import.meta.url,
);
const STORE = mkdtempSync(join(tmpdir(), "liminal-unit-first-page-"));
const run = promisify(execFile);

afterEach(closeServers);
afterAll(() => {
	rmSync(STORE, { recursive: true, force: true });
	removeTempFolders();
});

// first-page.ts for one id, its HTML and PDF addresses pointed at the given bases; the run's stdout and stderr (the
// run ends with exit code 1 when the PDF can't be read).
async function firstPage(id: string, htmlBase: string, pdfBase: string) {
	try {
		const done = await run(process.execPath, [SCRIPT.pathname, id], {
			env: {
				...process.env,
				ARXIV_HTML_BASE: htmlBase,
				ARXIV_PDF_BASE: pdfBase,
				ARXIV_HTML_STORE: STORE,
			},
			timeout: 60_000,
		});
		return done;
	} catch (error) {
		return error as { stdout: string; stderr: string };
	}
}

test("an HTML page is stored with the address it was finally served from, after redirects", async () => {
	const base = await serve((incoming, out) => {
		if (incoming.url === "/html/2501.00001") {
			out.writeHead(302, { location: "/html/2501.00001v1" });
			out.end();
			return;
		}
		if (incoming.url === "/html/2501.00001v1") {
			out.end("<html>a page that names no affiliation</html>");
			return;
		}
		out.writeHead(404);
		out.end();
	});
	await firstPage("2501.00001", `${base}/html`, `${base}/pdf`);
	const stored = JSON.parse(
		readFileSync(join(STORE, "liminal-arxiv-html", "2501.00001.json"), "utf8"),
	);
	expect(stored.status).toBe(200);
	expect(stored.finalUrl).toBe(`${base}/html/2501.00001v1`);
	expect(stored.text).toBe("<html>a page that names no affiliation</html>");
});

test("a PDF that cannot be reached is reported with its address and the network error", async () => {
	const base = await serve((_in, out) => {
		out.writeHead(404);
		out.end();
	});
	await closeServers();
	const run = await firstPage("2501.00002", `${base}/html`, `${base}/pdf`);
	expect(run.stderr).toContain(
		`first-page.ts: arxiv:2501.00002: could not fetch ${base}/pdf/2501.00002: ECONNREFUSED`,
	);
});

test("page 1 of a PDF is read through a range request", async () => {
	const pdf = twoPagePdf("2501.00003");
	const asked: string[] = [];
	const base = await serve((incoming, out) => {
		if (incoming.url !== "/pdf/2501.00003") {
			out.writeHead(404);
			out.end();
			return;
		}
		const range = /^bytes=(\d+)-(\d+)$/.exec(String(incoming.headers.range));
		asked.push(String(incoming.headers.range));
		if (range === null) {
			out.end(pdf);
			return;
		}
		const begin = Number(range[1]);
		const end = Math.min(Number(range[2]), pdf.length - 1);
		out.writeHead(206, {
			"content-range": `bytes ${begin}-${end}/${pdf.length}`,
		});
		out.end(pdf.subarray(begin, end + 1));
	});
	const run = await firstPage("2501.00003", `${base}/html`, `${base}/pdf`);
	expect(run.stdout).toContain("== arxiv:2501.00003 (from PDF) ==");
	expect(run.stdout).toContain("Page one of 2501.00003");
	expect(run.stdout).not.toContain("Page two");
	expect(asked[0]).toBe("bytes=0-65535");
});

// ---- runs of several papers, the day's page store and the arguments ----

// An arXiv HTML page that marks an affiliation, as LaTeXML writes it.
function htmlWith(affiliation: string): string {
	return [
		'<h1 class="ltx_title ltx_title_document">Fixture paper title</h1>',
		'<div class="ltx_authors"><span class="ltx_personname">Ada Example</span>',
		`<span class="ltx_role_affiliation"><span class="ltx_contact_name">Affiliation: </span>${affiliation}</span></div>`,
		'<div class="ltx_abstract">Abstract.</div>',
	].join("\n");
}

// A stand-in for arXiv's HTML and PDF pages: HTML by id (an id not listed answers HTTP 404), the PDF of every id in
// `pdfs` served in ranges (or whole, when `ignoreRange`), and every request recorded by path with its time.
async function serveArxiv(options: {
	html?: Record<string, string>;
	pdfs?: string[];
	ignoreRange?: boolean;
}) {
	const seen: {
		path: string;
		range: string | undefined;
		at: number;
		ended: number;
	}[] = [];
	const base = await serve((incoming, out) => {
		const record = {
			path: String(incoming.url),
			range: incoming.headers.range,
			at: Date.now(),
			ended: 0,
		};
		seen.push(record);
		out.on("finish", () => {
			record.ended = Date.now();
		});
		const [, kind, id] = record.path.split("/");
		const html = options.html?.[String(id)];
		if (kind === "html" && html !== undefined) {
			out.writeHead(200, { "content-type": "text/html" });
			out.end(html);
			return;
		}
		if (kind === "pdf" && options.pdfs?.includes(String(id))) {
			const pdf = twoPagePdf(String(id));
			const range = /^bytes=(\d+)-(\d+)$/.exec(String(incoming.headers.range));
			if (range === null || options.ignoreRange === true) {
				out.end(pdf);
				return;
			}
			const begin = Number(range[1]);
			const end = Math.min(Number(range[2]), pdf.length - 1);
			out.writeHead(206, {
				"content-range": `bytes ${begin}-${end}/${pdf.length}`,
			});
			out.end(pdf.subarray(begin, end + 1));
			return;
		}
		out.writeHead(404);
		out.end();
	});
	return { html: `${base}/html`, pdf: `${base}/pdf`, seen: seen };
}

// first-page.ts for these arguments against the stand-in, with its own store folder unless `store` is given.
function firstPages(
	args: string[],
	arxiv: { html: string; pdf: string },
	store: string,
	env: Record<string, string> = {},
) {
	return runScript(SCRIPT.pathname, args, {
		ARXIV_HTML_BASE: arxiv.html,
		ARXIV_PDF_BASE: arxiv.pdf,
		ARXIV_HTML_STORE: store,
		FIRST_PAGE_HTML_DELAY_MS: "0",
		...env,
	});
}

test("The HTML is used when it marks an affiliation, and no PDF is asked for", async () => {
	const arxiv = await serveArxiv({
		html: { "2501.00010": htmlWith("Example University") },
		pdfs: ["2501.00010"],
	});
	const ran = await firstPages(
		["2501.00010"],
		arxiv,
		tempFolder("liminal-unit-fp-"),
	);
	expect(ran.code).toBe(0);
	expect(ran.stdout).toContain("== arxiv:2501.00010 (from HTML) ==");
	expect(ran.stdout).toContain("Fixture paper title");
	expect(ran.stdout).toContain("Ada Example");
	expect(ran.stdout).toContain("Example University");
	expect(arxiv.seen.some((request) => request.path.startsWith("/pdf"))).toBe(
		false,
	);
});

test.each([
	["marks no ltx_role_affiliation", "<h1>No affiliation here</h1>"],
	["marks ltx_role_affiliation with only its label", htmlWith("")],
	["answers HTTP 404", undefined],
])("The PDF's page 1 is read when the HTML %s", async (_name, html) => {
	const pages: Record<string, string> = {};
	if (html !== undefined) {
		pages["2501.00011"] = html;
	}
	const arxiv = await serveArxiv({ html: pages, pdfs: ["2501.00011"] });
	const ran = await firstPages(
		["2501.00011"],
		arxiv,
		tempFolder("liminal-unit-fp-"),
	);
	expect(ran.code).toBe(0);
	expect(ran.stdout).toContain("== arxiv:2501.00011 (from PDF) ==");
	expect(ran.stdout).toContain("Page one of 2501.00011");
	expect(ran.stdout).not.toContain("Page two");
});

test("Each argument that is not an arXiv id is reported and never fetched, the ids come out in order, and the run fails", async () => {
	const arxiv = await serveArxiv({
		html: { "1706.03762": htmlWith("Example University") },
		pdfs: ["2501.00012"],
	});
	const ran = await firstPages(
		[
			"https://example.com/a.pdf",
			"hello",
			"url:https://example.com/a",
			"doi:10.1234/x",
			"-K/tmp/curlrc",
			"2501.00012",
			"arxiv:1706.03762",
		],
		arxiv,
		tempFolder("liminal-unit-fp-"),
	);
	expect(ran.code).not.toBe(0);
	for (const argument of [
		"https://example.com/a.pdf",
		"hello",
		"url:https://example.com/a",
		"doi:10.1234/x",
		"-K/tmp/curlrc",
	]) {
		expect(ran.stderr).toContain(
			`first-page.ts: "${argument}" is not an arXiv id`,
		);
	}
	expect(ran.stdout.indexOf("arxiv:2501.00012")).toBeGreaterThan(-1);
	expect(ran.stdout.indexOf("arxiv:2501.00012")).toBeLessThan(
		ran.stdout.indexOf("arxiv:1706.03762"),
	);
	const asked = new Set(
		arxiv.seen.map((request) => request.path.split("/")[2]),
	);
	expect([...asked].sort()).toEqual(["1706.03762", "2501.00012"]);
});

test("A run without an id says it needs one and sends no request to arXiv", async () => {
	const arxiv = await serveArxiv({});
	const ran = await firstPages([], arxiv, tempFolder("liminal-unit-fp-"));
	expect(ran.code).not.toBe(0);
	expect(ran.stderr).toContain("needs at least one arXiv id");
	expect(arxiv.seen).toEqual([]);
});

test("A paper with neither HTML nor PDF is reported with the PDF address and HTTP 404, and the next paper is still read", async () => {
	const arxiv = await serveArxiv({
		html: { "1706.03762": htmlWith("Example University") },
	});
	const ran = await firstPages(
		["2507.99999", "1706.03762"],
		arxiv,
		tempFolder("liminal-unit-fp-"),
	);
	expect(ran.code).not.toBe(0);
	expect(ran.stderr).toContain(
		`first-page.ts: arxiv:2507.99999: could not fetch ${arxiv.pdf}/2507.99999: HTTP 404`,
	);
	expect(ran.stdout).toContain("== arxiv:1706.03762 (from HTML) ==");
});

test("A server that ignores Range still gives page 1, from one request for the PDF", async () => {
	const arxiv = await serveArxiv({ pdfs: ["2501.00013"], ignoreRange: true });
	const ran = await firstPages(
		["2501.00013"],
		arxiv,
		tempFolder("liminal-unit-fp-"),
	);
	expect(ran.code).toBe(0);
	expect(ran.stdout).toContain("Page one of 2501.00013");
	expect(
		arxiv.seen.filter((request) => request.path.startsWith("/pdf")),
	).toHaveLength(1);
});

test("limit: The wait between two HTML requests starts when the first one has finished", async () => {
	const arxiv = await serveArxiv({
		html: {
			"2501.00014": htmlWith("Example University"),
			"2501.00015": htmlWith("Example University"),
		},
	});
	const ran = await firstPages(
		["2501.00014", "2501.00015"],
		arxiv,
		tempFolder("liminal-unit-fp-"),
		{ FIRST_PAGE_HTML_DELAY_MS: "400" },
	);
	expect(ran.code).toBe(0);
	const [first, second] = arxiv.seen;
	// A timer may fire a millisecond early.
	expect((second?.at ?? 0) - (first?.ended ?? 0)).toBeGreaterThanOrEqual(395);
});

test("A run leaves the working folder and the temp folder empty", async () => {
	const arxiv = await serveArxiv({ pdfs: ["2501.00016"] });
	const work = tempFolder("liminal-unit-fp-work-");
	const tmp = tempFolder("liminal-unit-fp-tmp-");
	const store = tempFolder("liminal-unit-fp-store-");
	const ran = await runScript(
		SCRIPT.pathname,
		["2501.00016", "2507.99999"],
		{
			ARXIV_HTML_BASE: arxiv.html,
			ARXIV_PDF_BASE: arxiv.pdf,
			ARXIV_HTML_STORE: store,
			FIRST_PAGE_HTML_DELAY_MS: "0",
			TMPDIR: tmp,
		},
		work,
	);
	expect(ran.code).not.toBe(0);
	expect(readdirSync(work)).toEqual([]);
	expect(readdirSync(tmp)).toEqual([]);
});

// The store's file for an id, and a page as first-page.ts keeps it.
function storedFile(store: string, id: string): string {
	return join(store, "liminal-arxiv-html", `${id}.json`);
}

test("A fetched HTML page is stored with its status, final address and text, and a 404 is stored too", async () => {
	const arxiv = await serveArxiv({
		html: { "2501.00017": htmlWith("Example University") },
		pdfs: ["2501.00018"],
	});
	const store = tempFolder("liminal-unit-fp-store-");
	await firstPages(["2501.00017", "2501.00018"], arxiv, store);
	const page = JSON.parse(
		readFileSync(storedFile(store, "2501.00017"), "utf8"),
	);
	expect(page.status).toBe(200);
	expect(page.finalUrl).toBe(`${arxiv.html}/2501.00017`);
	expect(page.text).toBe(htmlWith("Example University"));
	const missing = JSON.parse(
		readFileSync(storedFile(store, "2501.00018"), "utf8"),
	);
	expect(missing.status).toBe(404);
});

test("A page stored an hour ago is read without a request, and one stored 25 hours ago is fetched again", async () => {
	const arxiv = await serveArxiv({
		html: { "2501.00020": htmlWith("Example University") },
	});
	const store = tempFolder("liminal-unit-fp-store-");
	mkdirSync(join(store, "liminal-arxiv-html"));
	const keep = (id: string, ago: number, text: string) =>
		writeFileSync(
			storedFile(store, id),
			JSON.stringify({
				status: 200,
				finalUrl: `${arxiv.html}/${id}`,
				text: text,
				storedAt: new Date(Date.now() - ago).toISOString(),
			}),
		);
	keep("2501.00019", 3600 * 1000, htmlWith("Stored University"));
	keep("2501.00020", 25 * 3600 * 1000, htmlWith("Stale University"));
	const ran = await firstPages(["2501.00019", "2501.00020"], arxiv, store);
	expect(ran.stdout).toContain("Stored University");
	expect(ran.stdout).toContain("Example University");
	expect(ran.stdout).not.toContain("Stale University");
	expect(arxiv.seen.map((request) => request.path)).toEqual([
		"/html/2501.00020",
	]);
});
