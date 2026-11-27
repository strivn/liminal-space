// Tests of scripts/scout/web/paper.ts: claimProblems against a stand-in for the paper's page and for Crossref, and the
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

// A stand-in for a publisher's pages and for Crossref: pages by path, each with a status and a body, and Crossref's
// records by DOI (in lower case, as Crossref keeps it) under /crossref. It keeps the path of each request.
type Site = {
	pages: Record<string, { status?: number; body: string }>;
	crossref?: Record<
		string,
		{ title: string; subtitle?: string; authors: string[] }
	>;
};

// "Given Family" as Crossref's author object.
function crossrefAuthor(name: string) {
	const space = name.lastIndexOf(" ");
	return { given: name.slice(0, space), family: name.slice(space + 1) };
}

async function serveSite(site: Site) {
	const hits: string[] = [];
	const handler: Handler = (incoming, response) => {
		const path = incoming.url ?? "/";
		hits.push(path);
		const doi = path.match(/^\/crossref\/works\/(.+)$/)?.[1];
		if (doi !== undefined) {
			const record = site.crossref?.[decodeURIComponent(doi)];
			if (record === undefined) {
				response.writeHead(404);
				response.end();
				return;
			}
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					message: {
						title: [record.title],
						subtitle: record.subtitle === undefined ? [] : [record.subtitle],
						author: record.authors.map(crossrefAuthor),
						"container-title": ["Journal of Privacy Studies"],
					},
				}),
			);
			return;
		}
		const page = site.pages[path];
		response.writeHead(page?.status ?? 404, { "content-type": "text/html" });
		response.end(page?.body ?? "");
	};
	const base = await serve(handler);
	process.env.CROSSREF_API = `${base}/crossref`;
	return { base: base, hits: hits };
}

// The usual site: the paper's page.
async function serveUsual() {
	return serveSite({
		pages: { "/paper": { status: 200, body: fixture("paper-page.html") } },
	});
}

const savedCrossref = process.env.CROSSREF_API;
beforeEach(() => {
	delete process.env.CROSSREF_API;
});
afterEach(async () => {
	await closeServers();
	if (savedCrossref === undefined) {
		delete process.env.CROSSREF_API;
	} else {
		process.env.CROSSREF_API = savedCrossref;
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

// What Crossref holds for the usual paper.
const RECORD = {
	title: "Measuring Privacy Harms in Everyday Software",
	authors: ["Yann LeCun", "Geoffrey Hinton"],
};

test("a paper with a DOI is appended when Crossref's record for the DOI has its title and first author's surname, without opening its page", async () => {
	const stand = await serveSite({
		pages: { "/paper": { status: 200, body: fixture("paper-other.html") } },
		crossref: { [DOI]: RECORD },
	});
	const claim = { ...claimAt(stand.base, "/paper"), doi: DOI };
	assert.deepEqual(await claimProblems(claim), []);

	const file = join(tempFolder("liminal-unit-paper-"), "digests.js");
	const claimFile = join(tempFolder("liminal-unit-paper-"), "paper.json");
	writeFileSync(claimFile, JSON.stringify(claim));
	const ran = await runScript(PAPER, ["--append", file, claimFile], {
		CROSSREF_API: process.env.CROSSREF_API ?? "",
		LIMINAL_TODAY: TODAY,
	});
	assert.equal(ran.code, 0, ran.stderr);
	assert.match(ran.stdout, /appended doi:10\.2139\/ssrn\.4685553 Measuring/);
	assert.match(
		ran.stdout,
		/checked against Crossref's record for doi:10\.2139\/ssrn\.4685553/,
	);
	const [entry] = entriesOfLine(
		readFileSync(file, "utf8").split("\n")[0] ?? "",
	);
	assert.equal(entry?.title, claim.title);
	assert.equal(entry?.url, `https://doi.org/${DOI}`);
	assert.equal(
		stand.hits.some((path) => path === "/paper"),
		false,
	);

	// A record that keeps its subtitle in a field of its own matches the title alone, and the title with the subtitle.
	const split = await serveSite({
		pages: {},
		crossref: {
			[DOI]: {
				title: "Measuring Privacy Harms",
				subtitle: "In Everyday Software 🦜",
				authors: RECORD.authors,
			},
		},
	});
	for (const title of [
		"Measuring Privacy Harms",
		"Measuring Privacy Harms: In Everyday Software",
	]) {
		const problems = await claimProblems({
			...claimAt(split.base, "/paper"),
			title: title,
			doi: DOI,
		});
		assert.deepEqual(problems, [], title);
	}
});

test("a paper without a DOI is appended when its page holds its title and first author's surname", async () => {
	const stand = await serveUsual();
	const file = join(tempFolder("liminal-unit-paper-"), "digests.js");
	const claimFile = join(tempFolder("liminal-unit-paper-"), "paper.json");
	writeFileSync(claimFile, JSON.stringify(claimAt(stand.base, "/paper")));
	const ran = await runScript(PAPER, ["--append", file, claimFile], {
		LIMINAL_TODAY: TODAY,
	});
	assert.equal(ran.code, 0, ran.stderr);
	assert.match(
		ran.stdout,
		new RegExp(`checked against the page ${stand.base}/paper`),
	);
	assert.deepEqual(
		stand.hits.filter((path) => path.startsWith("/crossref")),
		[],
	);
});

test("a page that shows the title only in its citation_title tag, and the author only in citation_author, passes", async () => {
	const stand = await serveSite({
		pages: {
			"/paper": { status: 200, body: fixture("paper-meta-only.html") },
		},
	});
	assert.deepEqual(await claimProblems(claimAt(stand.base, "/paper")), []);
});

test("a page without the title is refused, naming the title check", async () => {
	const stand = await serveSite({
		pages: { "/paper": { status: 200, body: fixture("paper-other.html") } },
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
	});
	const problems = await claimProblems(claimAt(stand.base, "/paper"));
	assert.equal(problems.length, 1, problems.join("\n"));
	assert.match(problems[0] ?? "", /^author check: .*"lecun"/);
});

test("a paper whose DOI's Crossref record has another title or first author is refused, naming both", async () => {
	const other = {
		title: "Counting Birds in City Parks",
		authors: ["Ada Example"],
	};
	const cases: [{ title: string; authors: string[] }, string[]][] = [
		[
			{ ...RECORD, title: other.title },
			[
				`Crossref check: the record's title is "Counting Birds in City Parks", the claim's is "Measuring Privacy Harms in Everyday Software"`,
			],
		],
		[
			{ ...RECORD, authors: other.authors },
			[
				`Crossref check: the record's first author is "Ada Example", the claim's is "Yann LeCun"`,
			],
		],
	];
	for (const [record, expected] of cases) {
		const stand = await serveSite({
			pages: { "/paper": { status: 200, body: fixture("paper-page.html") } },
			crossref: { [DOI]: record },
		});
		const claim = { ...claimAt(stand.base, "/paper"), doi: DOI };
		assert.deepEqual(await claimProblems(claim), expected);
	}
});

test("a URL on a private or local address is refused before any request", async () => {
	const asked: string[] = [];
	const unlisted = await serveUnlisted((incoming, response) => {
		asked.push(incoming.url ?? "");
		response.end();
	});
	const doi = await serveSite({ pages: {}, crossref: { [DOI]: RECORD } });
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

test("a plain http address is refused before any request", async () => {
	// A public address as a number: nothing to look up, and a request would be a page check.
	const problems = await claimProblems({
		...claimAt("http://93.184.216.34", "/paper"),
	});
	assert.equal(problems.length, 1, problems.join("\n"));
	assert.match(problems[0] ?? "", /^address check: .* is not an https address/);
});

test("the appended line has a doi: id when a DOI is given, else a url: id, and passes the digests check", async () => {
	const stand = await serveSite({
		pages: { "/paper": { status: 200, body: fixture("paper-page.html") } },
		crossref: { [DOI]: RECORD },
	});
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
			{
				CROSSREF_API: process.env.CROSSREF_API ?? "",
				LIMINAL_TODAY: TODAY,
			},
		);
		assert.equal(ran.code, 0, `${name}: ${ran.stderr}`);
		const [entry] = entriesOfLine(
			readFileSync(file, "utf8").split("\n")[0] ?? "",
		);
		assert.deepEqual(entryProblems(entry, "check"), [], name);
		assert.equal(entry?.type, "paper");
		assert.equal(entry?.venue, "Journal of Privacy Studies 2026");
		assert.equal(entry?.venue_source, claim.url);
		// A DOI paper links to the DOI's address; one without a DOI, to its page.
		assert.equal(
			entry?.url,
			name === "with-doi" ? `https://doi.org/${DOI}` : claim.url,
		);
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
