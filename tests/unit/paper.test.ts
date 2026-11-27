// Tests of scripts/scout/web/paper.ts: claimProblems against a stand-in for the paper's page and for doi.org, and the
// command that appends a paper to a digests file. The pages are in tests/fixtures; nothing here reaches another host.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, test } from "vitest";
import {
	claimProblems,
	type PaperClaim,
} from "../../scripts/scout/web/paper.ts";
import { entryProblems } from "../../shared/entry-checks.ts";
import {
	closeServers,
	type Handler,
	serve,
	serveUnlisted,
} from "./local-server.ts";
import {
	entriesOfLine,
	removeTempFolders,
	runScript,
	scriptPath,
	tempFolder,
} from "./run-script.ts";

const PAPER = scriptPath("scout/web/paper.ts");
const DOI = "10.2139/ssrn.4685553";
const TODAY = "2026-11-27";

const fixture = (name: string) =>
	readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

// A stand-in for a publisher's pages and for doi.org: pages by path, each with a status and a body, and the DOIs that
// redirect, by path. It keeps the path of each request.
type Site = {
	pages: Record<string, { status?: number; body: string }>;
	redirects: Record<string, string>;
};

async function serveSite(site: Site) {
	const hits: string[] = [];
	const handler: Handler = (incoming, response) => {
		const path = incoming.url ?? "/";
		hits.push(path);
		// doi.org reads a DOI in any case.
		const target = site.redirects[path.toLowerCase()];
		if (target !== undefined) {
			response.writeHead(302, { location: target });
			response.end();
			return;
		}
		const page = site.pages[path];
		response.writeHead(page?.status ?? 404, { "content-type": "text/html" });
		response.end(page?.body ?? "");
	};
	return { base: await serve(handler), hits: hits };
}

// The usual site: the paper's page and a DOI that opens it.
async function serveUsual() {
	const stand = await serveSite({
		pages: {
			"/paper": { status: 200, body: fixture("paper-page.html") },
			"/other": { status: 200, body: fixture("paper-page.html") },
		},
		redirects: {},
	});
	return stand;
}

const savedDoiBase = process.env.DOI_BASE;
beforeEach(() => {
	delete process.env.DOI_BASE;
});
afterEach(async () => {
	await closeServers();
	if (savedDoiBase === undefined) {
		delete process.env.DOI_BASE;
	} else {
		process.env.DOI_BASE = savedDoiBase;
	}
});
afterAll(removeTempFolders);

function claimAt(base: string, path: string): PaperClaim {
	return {
		title: "Measuring Privacy Harms in Everyday Software",
		authors: ["Yann LeCun", "Geoffrey Hinton"],
		venue: "Journal of Privacy Studies 2026",
		url: `${base}${path}`,
	};
}

// A site whose DOI resolves to `target`.
async function serveWithDoi(
	pages: Site["pages"],
	target: (base: string) => string,
) {
	const redirects: Site["redirects"] = {};
	const stand = await serveSite({ pages: pages, redirects: redirects });
	redirects[`/${DOI}`] = target(stand.base);
	process.env.DOI_BASE = stand.base;
	return stand;
}

const FULL = { status: 200, body: fixture("paper-page.html") };

test("a paper whose page holds its title and first author's surname, and whose DOI resolves to that page, is appended", async () => {
	const stand = await serveWithDoi(
		{ "/paper": FULL },
		(base) => `${base}/paper`,
	);
	const claim = { ...claimAt(stand.base, "/paper"), doi: DOI };
	assert.deepEqual(await claimProblems(claim), []);

	const file = join(tempFolder("liminal-unit-paper-"), "digests.js");
	const claimFile = join(tempFolder("liminal-unit-paper-"), "paper.json");
	writeFileSync(claimFile, JSON.stringify(claim));
	const ran = await runScript(PAPER, ["--append", file, claimFile], {
		DOI_BASE: stand.base,
		LIMINAL_TODAY: TODAY,
	});
	assert.equal(ran.code, 0, ran.stderr);
	assert.match(ran.stdout, /appended doi:10\.2139\/ssrn\.4685553 Measuring/);
	const [entry] = entriesOfLine(
		readFileSync(file, "utf8").split("\n")[0] ?? "",
	);
	assert.equal(entry?.title, claim.title);
	assert.equal(entry?.url, claim.url);
});

test("a page that shows the title only in its citation_title tag, and the author only in citation_author, passes", async () => {
	const stand = await serveSite({
		pages: {
			"/paper": { status: 200, body: fixture("paper-meta-only.html") },
		},
		redirects: {},
	});
	assert.deepEqual(await claimProblems(claimAt(stand.base, "/paper")), []);
});

test("a page without the title is refused, naming the title check", async () => {
	const stand = await serveSite({
		pages: { "/paper": { status: 200, body: fixture("paper-other.html") } },
		redirects: {},
	});
	const claim = { ...claimAt(stand.base, "/paper"), authors: ["Ada Example"] };
	const problems = await claimProblems(claim);
	assert.equal(problems.length, 1, problems.join("\n"));
	assert.match(problems[0] ?? "", /^title check: .*Measuring Privacy Harms/);
});

test("a page without the first author's surname is refused, naming the author check", async () => {
	const stand = await serveSite({
		pages: {
			"/paper": { status: 200, body: fixture("paper-no-author.html") },
		},
		redirects: {},
	});
	const problems = await claimProblems(claimAt(stand.base, "/paper"));
	assert.equal(problems.length, 1, problems.join("\n"));
	assert.match(problems[0] ?? "", /^author check: .*"lecun"/);
});

test("a DOI that resolves to another page is refused, naming both addresses", async () => {
	const stand = await serveWithDoi(
		{ "/paper": FULL, "/other": FULL },
		(base) => `${base}/other`,
	);
	const claim = { ...claimAt(stand.base, "/paper"), doi: DOI };
	const problems = await claimProblems(claim);
	assert.deepEqual(problems, [
		`DOI check: ${DOI} resolves to ${stand.base}/other, not ${stand.base}/paper`,
	]);
});

test("a URL on a private or local address is refused before any request", async () => {
	const asked: string[] = [];
	const unlisted = await serveUnlisted((incoming, response) => {
		asked.push(incoming.url ?? "");
		response.end();
	});
	const doi = await serveWithDoi({ "/paper": FULL }, (base) => `${base}/paper`);
	const claim = { ...claimAt(unlisted, "/paper"), doi: DOI };
	const problems = await claimProblems(claim);
	assert.equal(problems.length, 1, problems.join("\n"));
	assert.match(
		problems[0] ?? "",
		/^address check: .*not on the public internet/,
	);
	assert.deepEqual(asked, []);
	assert.deepEqual(doi.hits, []);
});

test("a page that answers 403 is refused, naming the status", async () => {
	const stand = await serveSite({
		pages: { "/paper": { status: 403, body: "Just a moment..." } },
		redirects: {},
	});
	const problems = await claimProblems(claimAt(stand.base, "/paper"));
	assert.deepEqual(problems, [
		`page check: ${stand.base}/paper answered HTTP 403`,
	]);
});

test("a claim with an arXiv id is refused and sent to arxiv.ts", async () => {
	const byAddress = await claimProblems({
		...claimAt("https://arxiv.org", "/abs/2507.11473v2"),
	});
	assert.equal(byAddress.length, 1);
	assert.match(byAddress[0] ?? "", /arXiv id 2507\.11473.*arxiv\.ts/);
	const byDoi = await claimProblems({
		...claimAt("https://example.org", "/paper"),
		doi: "10.48550/arXiv.2507.11473",
	});
	assert.equal(byDoi.length, 1);
	assert.match(byDoi[0] ?? "", /arXiv id 2507\.11473.*arxiv\.ts/);

	const file = join(tempFolder("liminal-unit-paper-"), "digests.js");
	const claimFile = join(tempFolder("liminal-unit-paper-"), "paper.json");
	writeFileSync(
		claimFile,
		JSON.stringify(claimAt("https://arxiv.org", "/abs/2507.11473")),
	);
	const ran = await runScript(PAPER, ["--append", file, claimFile], {
		LIMINAL_TODAY: TODAY,
	});
	assert.equal(ran.code, 1);
	assert.match(ran.stderr, /arxiv\.ts/);
	assert.equal(existsSync(file), false);
});

test("the appended line has a doi: id when a DOI is given, else a url: id, and passes the digests check", async () => {
	const stand = await serveWithDoi(
		{ "/paper": FULL },
		(base) => `${base}/paper`,
	);
	const folder = tempFolder("liminal-unit-paper-");
	const ids: unknown[] = [];
	for (const [name, claim] of [
		["with-doi", { ...claimAt(stand.base, "/paper"), doi: DOI.toUpperCase() }],
		["without-doi", claimAt(stand.base, "/paper")],
	] as const) {
		const file = join(folder, `${name}.js`);
		const claimFile = join(folder, `${name}.json`);
		writeFileSync(claimFile, JSON.stringify(claim));
		const ran = await runScript(
			PAPER,
			["--append", file, "--date", TODAY, claimFile],
			{ DOI_BASE: stand.base, LIMINAL_TODAY: TODAY },
		);
		assert.equal(ran.code, 0, `${name}: ${ran.stderr}`);
		const [entry] = entriesOfLine(
			readFileSync(file, "utf8").split("\n")[0] ?? "",
		);
		assert.deepEqual(entryProblems(entry, "check"), [], name);
		assert.equal(entry?.type, "paper");
		assert.equal(entry?.venue, "Journal of Privacy Studies 2026");
		assert.equal(entry?.venue_source, claim.url);
		ids.push(entry?.id);
	}
	assert.deepEqual(ids, [`doi:${DOI}`, `url:${stand.base}/paper`]);
});

test("a paper already in the digests is not appended again", async () => {
	const stand = await serveUsual();
	const folder = tempFolder("liminal-unit-paper-");
	const file = join(folder, "digests.js");
	const claimFile = join(folder, "paper.json");
	writeFileSync(claimFile, JSON.stringify(claimAt(stand.base, "/paper")));
	const run = () =>
		runScript(PAPER, ["--append", file, claimFile], { LIMINAL_TODAY: TODAY });
	const first = await run();
	assert.equal(first.code, 0, first.stderr);
	const written = readFileSync(file, "utf8");
	const asked = stand.hits.length;

	const second = await run();
	assert.equal(second.code, 1);
	assert.match(second.stderr, /already in .*, skipped: url:/);
	assert.equal(readFileSync(file, "utf8"), written);
	assert.equal(stand.hits.length, asked);
});

test("the claim's text reaches no shell: a title with quotes and $() is appended as written", async () => {
	const stand = await serveSite({
		pages: { "/paper": { status: 200, body: fixture("paper-quoted.html") } },
		redirects: {},
	});
	const folder = tempFolder("liminal-unit-paper-");
	const file = join(folder, "digests.js");
	const claimFile = join(folder, "paper.json");
	const title = 'Say "hi" to $(touch pwned) and `id`';
	writeFileSync(
		claimFile,
		JSON.stringify({ ...claimAt(stand.base, "/paper"), title: title }),
	);
	const ran = await runScript(
		PAPER,
		["--append", file, claimFile],
		{ LIMINAL_TODAY: TODAY },
		folder,
	);
	assert.equal(ran.code, 0, ran.stderr);
	const [entry] = entriesOfLine(
		readFileSync(file, "utf8").split("\n")[0] ?? "",
	);
	assert.equal(entry?.title, title);
	assert.equal(existsSync(join(folder, "pwned")), false);
});
