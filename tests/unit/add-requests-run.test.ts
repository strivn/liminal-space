// Unit tests for the run and report commands of scripts/deploy/add-requests.ts, run as add.yml runs them: against stand-ins for
// the site's request routes, arXiv and a news page on 127.0.0.1, with the scout's real scripts as its children. Nothing
// here contacts a real site. One run handles four queued requests that each go their own way; the report runs and the
// refused command lines start with it and are read by the tests below.
// Requests that never answer run apart.
import { execFile } from "node:child_process";
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
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { closeServers, serve } from "./local-server.ts";

const SCRIPT = new URL("../../scripts/deploy/add-requests.ts", import.meta.url);
const run = promisify(execFile);
const TODAY = "2026-10-20";
const LIMIT = "5000";
const WORK = mkdtempSync(join(tmpdir(), "liminal-unit-add-run-"));

const fixture = (name: string) =>
	readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

// The saved arXiv API entries of the ids the stand-in has, as one feed.
function feedFor(ids: string[]) {
	const files: Record<string, string> = {
		"2507.11473": "arxiv-2507.11473.xml",
		"1706.03762": "arxiv-1706.03762.xml",
		"hep-th/9901001": "arxiv-hep-th-9901001.xml",
	};
	const head = fixture("arxiv-2507.11473.xml").split("<entry>")[0] as string;
	const entries = ids
		.filter((id) => id in files)
		.sort()
		.map(
			(id) =>
				(
					fixture(files[id] as string).match(
						/<entry>[\s\S]*<\/entry>/,
					) as RegExpMatchArray
				)[0],
		);
	return `${head}${entries.join("\n")}\n</feed>\n`;
}

// A paper Crossref knows, without an abstract, and the one Semantic Scholar's stand-in gives every DOI.
const PARROTS_DOI = "10.1145/3442188.3445922";
const PARROTS_RECORD = {
	title: ["Why Language Models Are Too Big, a Fixture Title"],
	author: [{ given: "Ada", family: "Example" }],
	"container-title": ["Proceedings of the 2021 ACM Conference"],
	published: { "date-parts": [[2021, 3, 1]] },
};
const SEMANTIC_ABSTRACT = "Language models grew, and so did the questions.";

type Queued = { id: string; kind: "papers" | "links"; payload: unknown };
type Item = { id: string; outcome: string; reason?: string };
type Update = { id: string; status: string; result?: { items: Item[] } };

// Stand-ins: the site's routes at /site (the queue, and what is reported), arXiv's API at /api, its HTML pages at /html
// (none), and two news pages. A request whose address holds one of `hang` is never answered.
async function standIn(queue: (base: string) => Queued[], hang: string[] = []) {
	const updates: Update[] = [];
	let address = "";
	const base = await serve((incoming, out) => {
		const url = new URL(incoming.url as string, "http://stand-in.test");
		if (hang.some((name) => (incoming.url as string).includes(name))) {
			return;
		}
		if (
			url.pathname === "/site/api/sync/requests" &&
			incoming.method === "GET"
		) {
			out.end(JSON.stringify({ requests: queue(address) }));
			return;
		}
		if (url.pathname === "/site/api/sync/requests") {
			const chunks: Buffer[] = [];
			incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
			incoming.on("end", () => {
				updates.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
				out.end("{}");
			});
			return;
		}
		if (url.pathname === "/api") {
			out.end(feedFor((url.searchParams.get("id_list") as string).split(",")));
			return;
		}
		const doiPaper = url.pathname.match(/^\/doi\/(.+)$/);
		if (doiPaper !== null && doiPaper[1] === "10.2139/ssrn.4685553") {
			out.writeHead(302, { location: `${address}/page/paper` });
			out.end();
			return;
		}
		const crossref = url.pathname.match(/^\/crossref\/works\/(.+)$/);
		if (crossref !== null && crossref[1] !== undefined) {
			const doi = decodeURIComponent(crossref[1]);
			if (doi === PARROTS_DOI) {
				out.end(JSON.stringify({ message: PARROTS_RECORD }));
				return;
			}
		}
		const semantic = url.pathname.match(/^\/s2\/paper\/DOI:(.+)$/);
		if (semantic !== null) {
			out.end(JSON.stringify({ abstract: SEMANTIC_ABSTRACT }));
			return;
		}
		const paperPage = url.pathname.match(/^\/page\/(paper|other|quoted)$/);
		if (paperPage !== null && paperPage[1] !== undefined) {
			out.setHeader("content-type", "text/html");
			out.end(
				fixture(
					`paper-${paperPage[1] === "paper" ? "page" : paperPage[1]}.html`,
				),
			);
			return;
		}
		if (url.pathname === "/page/ok") {
			out.setHeader("content-type", "text/html");
			out.end(
				'<html><head><meta property="og:description" content="Forty ocean buoys now report Java Sea temperatures every ten minutes."></head><body></body></html>',
			);
			return;
		}
		out.writeHead(404);
		out.end();
	});
	address = base;
	return { base: base, updates: updates };
}

type Result = { code: number; stdout: string; stderr: string };

let counter = 0;

// A folder for one run, with a digests file holding `content`; the folder's paths.
function setup(content: string) {
	counter += 1;
	const dir = join(WORK, `run-${counter}`);
	mkdirSync(dir);
	const digests = join(dir, "digests.js");
	writeFileSync(digests, content);
	return { dir: dir, digests: digests, results: join(dir, "results.json") };
}

// add-requests.ts with the stand-ins; `limit` is each script's time limit in milliseconds.
async function addRequests(
	dir: string,
	args: string[],
	base: string,
	limit = LIMIT,
): Promise<Result> {
	try {
		const done = await run(process.execPath, [SCRIPT.pathname, ...args], {
			cwd: dir,
			env: {
				...process.env,
				ACCESS_SYNC_ID: "test-id",
				ACCESS_SYNC_SECRET: "test-secret",
				LIMINAL_URL: `${base}/site`,
				ARXIV_API: `${base}/api`,
				ARXIV_OAI: `${base}/oai`,
				ARXIV_HTML_BASE: `${base}/html`,
				ARXIV_HTML_STORE: join(dir, "html-store"),
				CROSSREF_API: `${base}/crossref`,
				DOI_BASE: `${base}/doi`,
				SEMANTIC_SCHOLAR_API: `${base}/s2`,
				SEMANTIC_SCHOLAR_API_KEY: "test-key",
				SEMANTIC_SCHOLAR_PAUSE_MS: "0",
				SEMANTIC_SCHOLAR_RETRY_MS: "0",
				ARXIV_PAUSE_MS: "1",
				FIGURE_DELAY_MS: "0",
				SYNC_RETRY_SECOND_MS: "1",
				ADD_SCRIPT_TIMEOUT_MS: limit,
				LIMINAL_TODAY: TODAY,
				LIMINAL_CACHE: join(dir, "cache"),
				LIMINAL_ALLOW_LOCAL: new URL(base).host,
				TMPDIR: WORK,
			},
			timeout: 120_000,
		});
		return { code: 0, stdout: done.stdout, stderr: done.stderr };
	} catch (error) {
		const failed = error as { code: number; stdout: string; stderr: string };
		return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
	}
}

const OLD_LINE = `digest(${JSON.stringify({
	date: "2026-10-01",
	entries: [
		{
			id: "arxiv:2507.11473",
			type: "paper",
			title: "Kept",
			authors: ["Ada Example"],
			published: "2025-07-15",
		},
	],
})});\n`;

// The entries of every line the digests file holds after its first.
function appendedEntries(digests: string): Record<string, unknown>[] {
	return readFileSync(digests, "utf8")
		.trimEnd()
		.split("\n")
		.slice(1)
		.flatMap(
			(line) => JSON.parse(line.slice("digest(".length, -");".length)).entries,
		);
}

const results = (file: string): Update[] =>
	JSON.parse(readFileSync(file, "utf8"));

const newsLink = (url: string) => ({
	type: "news",
	title: "Fixture news",
	authors: [],
	published: "2026-10-04",
	source: "Fixture Times",
	url: url,
});

// A results file as run keeps it: one request with its items.
function writeResults(file: string, items: { id: string; outcome: string }[]) {
	writeFileSync(
		file,
		JSON.stringify([
			{
				id: "r1",
				status: "done",
				result: { items: items },
			},
		]),
	);
}

// ---- The runs ----

type Handled = {
	result: Result;
	updates: Update[];
	digests: string;
	done: Update[];
	base: string;
};

// One run over the queued requests, against a stand-in that never answers a request holding one of `hang`.
async function handle(
	queue: (base: string) => Queued[],
	hang: string[] = [],
): Promise<Handled> {
	const stand = await standIn(queue, hang);
	const files = setup(OLD_LINE);
	const result = await addRequests(
		files.dir,
		["run", files.digests, files.results],
		stand.base,
	);
	return {
		result: result,
		updates: stand.updates,
		digests: files.digests,
		done: results(files.results),
		base: stand.base,
	};
}

const hepth: Queued = {
	id: "r6",
	kind: "papers",
	payload: { papers: ["hep-th/9901001"] },
};

const outcomes: {
	handled?: Handled;
	paperLimit?: Handled;
	linkLimit?: Handled;
	refusedPush?: { result: Result; sent: Update[] };
	pushFailed?: { sent: Update[] };
	cutOff?: { sent: Update[] };
	noResults?: { result: Result; sent: Update[] };
	notAccepted?: { result: Result; sent: string[] };
	badLimit?: { result: Result; sent: Update[] };
	usage?: { args: string[]; result: Result }[];
} = {};

beforeAll(async () => {
	await Promise.all([
		(async () => {
			outcomes.handled = await handle((base) => [
				{
					id: "r1",
					kind: "papers",
					payload: { papers: ["2507.11473", "1706.03762", "--append"] },
				},
				{ id: "r2", kind: "papers", payload: { papers: ["2507.99999"] } },
				{
					id: "r3",
					kind: "links",
					payload: { links: [newsLink(`${base}/page/ok`)] },
				},
				hepth,
			]);
		})(),
		(async () => {
			outcomes.paperLimit = await handle(
				() => [
					{ id: "r4", kind: "papers", payload: { papers: ["2601.00001"] } },
					hepth,
				],
				["id_list=2601.00001"],
			);
		})(),
		(async () => {
			outcomes.linkLimit = await handle(
				(base) => [
					{
						id: "r5",
						kind: "links",
						payload: { links: [newsLink(`${base}/page/hang`)] },
					},
					hepth,
				],
				["/page/hang"],
			);
		})(),
		(async () => {
			const stand = await standIn(() => []);
			const files = setup(OLD_LINE);
			writeResults(files.results, [
				{ id: "2610.00001", outcome: "added" },
				{ id: "2610.00002", outcome: "added" },
			]);
			const output = join(files.dir, "push.txt");
			writeFileSync(
				output,
				"added arxiv:2610.00001\nrefused line 2 entry 1 arxiv:2610.00002: title is missing\nadded 1, filled 0, already there 0, refused 1\n",
			);
			const result = await addRequests(
				files.dir,
				["report", files.results, "failure", output],
				stand.base,
			);
			outcomes.refusedPush = { result: result, sent: stand.updates };
		})(),
		(async () => {
			const stand = await standIn(() => []);
			const files = setup(OLD_LINE);
			writeResults(files.results, [{ id: "2610.00001", outcome: "added" }]);
			await addRequests(
				files.dir,
				["report", files.results, "failure"],
				stand.base,
			);
			writeResults(files.results, [{ id: "2610.00001", outcome: "added" }]);
			await addRequests(
				files.dir,
				["report", files.results, "success"],
				stand.base,
			);
			outcomes.pushFailed = { sent: stand.updates };
		})(),
		(async () => {
			const stand = await standIn(() => []);
			const files = setup(OLD_LINE);
			writeResults(files.results, [{ id: "2610.00001", outcome: "added" }]);
			const output = join(files.dir, "push.txt");
			writeFileSync(output, "added arxiv:2610.00001\n");
			await addRequests(
				files.dir,
				["report", files.results, "failure", output],
				stand.base,
			);
			outcomes.cutOff = { sent: stand.updates };
		})(),
		(async () => {
			const stand = await standIn(() => []);
			const files = setup(OLD_LINE);
			const result = await addRequests(
				files.dir,
				["report", join(files.dir, "none.json"), "success"],
				stand.base,
			);
			outcomes.noResults = { result: result, sent: stand.updates };
		})(),
		(async () => {
			const sent: string[] = [];
			const base = await serve((incoming, out) => {
				const chunks: Buffer[] = [];
				incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
				incoming.on("end", () => {
					const update = JSON.parse(Buffer.concat(chunks).toString("utf8"));
					sent.push(update.id);
					out.writeHead(update.id === "r1" ? 500 : 200);
					out.end("{}");
				});
			});
			const files = setup(OLD_LINE);
			writeFileSync(
				files.results,
				JSON.stringify(
					["r1", "r2"].map((id) => ({
						id: id,
						status: "done",
						result: {
							items: [{ id: "2610.00001", outcome: "added" }],
						},
					})),
				),
			);
			const result = await addRequests(
				files.dir,
				["report", files.results, "success"],
				base,
			);
			outcomes.notAccepted = { result: result, sent: sent };
		})(),
		(async () => {
			const stand = await standIn(() => [
				{ id: "r1", kind: "papers", payload: { papers: ["1706.03762"] } },
			]);
			const files = setup(OLD_LINE);
			const result = await addRequests(
				files.dir,
				["run", files.digests, files.results],
				stand.base,
				"soon",
			);
			outcomes.badLimit = { result: result, sent: stand.updates };
		})(),
		(async () => {
			const stand = await standIn(() => []);
			outcomes.usage = await Promise.all(
				[
					["run", "digests.js"],
					["run"],
					["report", "results.json"],
					["other", "a", "b"],
				].map(async (args) => {
					const files = setup(OLD_LINE);
					return {
						args: args,
						result: await addRequests(files.dir, args, stand.base),
					};
				}),
			);
		})(),
	]);
}, 180_000);

afterAll(async () => {
	await closeServers();
	rmSync(WORK, { recursive: true, force: true });
});

describe("run", () => {
	const handled = () =>
		outcomes.handled as NonNullable<typeof outcomes.handled>;
	const request = (id: string) =>
		handled().done.find((each) => each.id === id) as Update;

	test("each queued request is marked running before it is handled, in the order queued, and the run says how many there were", () => {
		expect(handled().result.code).toBe(0);
		expect(handled().result.stdout).toContain("4 queued requests");
		expect(handled().updates).toEqual(
			["r1", "r2", "r3", "r6"].map((id) => ({
				id: id,
				status: "running",
			})),
		);
	});

	test("a request's result gives each id's outcome: already there, added, or failed as not an arXiv id", () => {
		expect(request("r1").status).toBe("done");
		expect(request("r1").result?.items).toEqual([
			{ id: "2507.11473", outcome: "already there" },
			{ id: "1706.03762", outcome: "added" },
			{ id: "--append", outcome: "failed", reason: "not an arXiv id" },
		]);
	});

	test("a request that fails is marked failed with the reason, and the requests after it go on", () => {
		expect(request("r2").status).toBe("failed");
		expect(request("r2").result?.items[0]).toMatchObject({
			id: "2507.99999",
			outcome: "failed",
			reason: "not found on arXiv",
		});
		expect(request("r3").status).toBe("done");
		expect(request("r6").status).toBe("done");
		expect(request("r6").result?.items).toEqual([
			{ id: "hep-th/9901001", outcome: "added" },
		]);
	});

	test("every entry the run appends is marked ad hoc, and a link is given the publisher's description", () => {
		const entries = appendedEntries(handled().digests);
		for (const entry of entries) {
			expect(entry.ad_hoc).toBe(true);
		}
		expect(entries.map((entry) => entry.id)).toEqual(
			expect.arrayContaining([
				"arxiv:1706.03762",
				`url:${handled().base}/page/ok`,
				"arxiv:hep-th/9901001",
			]),
		);
		const link = entries.find(
			(entry) => entry.id === `url:${handled().base}/page/ok`,
		);
		expect(link?.description).toBe(
			"Forty ocean buoys now report Java Sea temperatures every ten minutes.",
		);
	});

	test("limit: a paper that takes longer than the time limit is failed with that reason, and a later request is still added", () => {
		const limited = outcomes.paperLimit as Handled;
		const of = (id: string) => limited.done.find((each) => each.id === id);
		expect(of("r4")?.status).toBe("failed");
		expect(of("r4")?.result?.items[0]?.reason).toBe(
			"arxiv.ts took longer than its time limit and was stopped",
		);
		expect(of("r6")?.status).toBe("done");
	});

	test("limit: a link whose page does not answer within the time limit is added without a description, and a later request is still added", () => {
		const limited = outcomes.linkLimit as Handled;
		const of = (id: string) => limited.done.find((each) => each.id === id);
		expect(of("r5")?.status).toBe("done");
		expect(of("r5")?.result?.items[0]).toMatchObject({ outcome: "added" });
		const entries = appendedEntries(limited.digests);
		const entry = entries.find(
			(each) => each.id === `url:${limited.base}/page/hang`,
		);
		expect(entry).toBeDefined();
		expect(entry).not.toHaveProperty("description");
		expect(limited.result.stderr).toContain(
			`describe.ts took longer than ${LIMIT} ms and was stopped`,
		);
		expect(of("r6")?.status).toBe("done");
	});

	test("an unusable ADD_SCRIPT_TIMEOUT_MS stops the run before the queue is read, so no request is marked running", () => {
		const o = outcomes.badLimit as NonNullable<typeof outcomes.badLimit>;
		expect(o.result.code).toBe(1);
		expect(o.result.stderr).toContain("ADD_SCRIPT_TIMEOUT_MS");
		expect(o.sent).toEqual([]);
	});
});

describe("report", () => {
	test("when the push refuses one entry, the report marks the others added and the refused one failed with the site's reason", () => {
		const o = outcomes.refusedPush as NonNullable<typeof outcomes.refusedPush>;
		expect(o.result.code).toBe(0);
		expect(o.sent).toHaveLength(1);
		expect(o.sent[0]?.status).toBe("done");
		expect(o.sent[0]?.result?.items).toEqual([
			{ id: "2610.00001", outcome: "added" },
			{
				id: "2610.00002",
				outcome: "failed",
				reason: "appended, but the site refused it: title is missing",
			},
		]);
	});

	test("without a complete push output, a failed push marks the appended entries failed and a successful one keeps them added", () => {
		const o = outcomes.pushFailed as NonNullable<typeof outcomes.pushFailed>;
		expect(o.sent[0]).toMatchObject({
			status: "failed",
			result: {
				items: [
					{
						id: "2610.00001",
						outcome: "failed",
						reason: "appended, but the push to the site failed",
					},
				],
			},
		});
		expect(o.sent[1]?.status).toBe("done");
		expect(
			(outcomes.cutOff as NonNullable<typeof outcomes.cutOff>).sent[0]?.status,
		).toBe("failed");
	});

	test("without a results file, the report says no requests were handled and sends nothing", () => {
		const o = outcomes.noResults as NonNullable<typeof outcomes.noResults>;
		expect(o.result.code).toBe(0);
		expect(o.result.stdout).toContain("no requests were handled");
		expect(o.sent).toEqual([]);
	});

	test("a request the site doesn't accept is named, the others are still sent, and the exit code is 1", () => {
		const o = outcomes.notAccepted as NonNullable<typeof outcomes.notAccepted>;
		expect(o.result.code).toBe(1);
		expect(o.result.stderr).toContain(
			"add-requests.ts: request r1 not reported",
		);
		expect(o.result.stdout).toContain("reported r2 done");
		expect(o.sent).toContain("r2");
	});
});

describe("the command line", () => {
	test("a wrong command line prints the usage line and exits non-zero", () => {
		for (const { args, result } of outcomes.usage || []) {
			expect(result.code, JSON.stringify(args)).toBe(1);
			expect(result.stderr).toContain(
				"usage: node scripts/deploy/add-requests.ts",
			);
		}
	});
});

describe("papers added by DOI", () => {
	// A DOI whose characters mean something to a shell, and that Crossref doesn't know.
	const SHELL_DOI = "doi:10.1000/x;touch$IFS$9pwned&&id";
	const ALREADY = "doi:10.1234/already";
	const SSRN_DOI = "doi:10.2139/ssrn.4685553";
	const PAPER_TITLE = "Measuring Privacy Harms in Everyday Software";
	const QUOTED_TITLE = 'Say "hi" to $(touch pwned) and `id`';
	const authors = ["Yann LeCun", "Geoffrey Hinton"];

	let ran: {
		dir: string;
		digests: string;
		base: string;
		items: Item[];
		status: string;
		result: Result;
	};

	// One request holding two arXiv and DOI papers, a paper by its metadata whose DOI opens its page, one whose title
	// has shell characters in it, and one whose page holds neither its title nor its author.
	beforeAll(async () => {
		const stand = await standIn((base) => [
			{
				id: "r10",
				kind: "papers",
				payload: {
					papers: [
						"1706.03762",
						`doi:${PARROTS_DOI}`,
						"doi:10.9999/unknown",
						ALREADY,
						SHELL_DOI,
					],
					metadata: [
						{
							title: PAPER_TITLE,
							authors: authors,
							venue: "Journal of Privacy Studies 2026",
							url: `${base}/page/paper`,
							doi: SSRN_DOI.slice("doi:".length),
						},
						{
							title: QUOTED_TITLE,
							authors: ["Yann LeCun"],
							venue: "Journal of Privacy Studies 2026",
							url: `${base}/page/quoted`,
						},
						{
							title: PAPER_TITLE,
							authors: ["Yann LeCun"],
							venue: "Journal of Privacy Studies 2026",
							url: `${base}/page/other`,
						},
					],
				},
			},
		]);
		const already = `digest(${JSON.stringify({
			date: "2026-10-02",
			entries: [
				{
					id: ALREADY,
					type: "paper",
					title: "Kept DOI",
					authors: ["Ada Example"],
				},
			],
		})});\n`;
		const files = setup(OLD_LINE + already);
		const result = await addRequests(
			files.dir,
			["run", files.digests, files.results],
			stand.base,
		);
		const [request] = results(files.results);
		ran = {
			dir: files.dir,
			digests: files.digests,
			base: stand.base,
			items: request?.result?.items ?? [],
			status: request?.status ?? "",
			result: result,
		};
	}, 120_000);

	const item = (id: string) => ran.items.find((one) => one.id === id);
	const appended = () =>
		readFileSync(ran.digests, "utf8")
			.trimEnd()
			.split("\n")
			.slice(2)
			.flatMap(
				(line) =>
					JSON.parse(line.slice("digest(".length, -");".length)).entries,
			);

	test("a doi: id runs proceedings.ts --crossref with the id as an argument of its own", () => {
		expect(ran.result.code, ran.result.stderr).toBe(0);
		const entry = appended().find((one) => one.id === `doi:${PARROTS_DOI}`);
		expect(entry?.title).toBe(PARROTS_RECORD.title[0]);
		expect(entry?.ad_hoc).toBe(true);
		// A DOI full of shell characters was asked of Crossref as one name and ran nothing.
		expect(item(SHELL_DOI)?.outcome).toBe("failed");
		expect(existsSync(join(ran.dir, "pwned"))).toBe(false);
	});

	test("arXiv ids and DOIs in one request each go to their own script, and each is reported", () => {
		expect(ran.status).toBe("done");
		expect(item("1706.03762")?.outcome).toBe("added");
		expect(item(`doi:${PARROTS_DOI}`)?.outcome).toBe("added");
		expect(appended().map((one) => one.id)).toEqual(
			expect.arrayContaining(["arxiv:1706.03762", `doi:${PARROTS_DOI}`]),
		);
		expect(ran.items.map((one) => one.id)).toEqual([
			"1706.03762",
			`doi:${PARROTS_DOI}`,
			"doi:10.9999/unknown",
			ALREADY,
			SHELL_DOI,
			SSRN_DOI,
			`${ran.base}/page/quoted`,
			`${ran.base}/page/other`,
		]);
	});

	test("a DOI Crossref doesn't know is reported failed, not found on Crossref", () => {
		expect(item("doi:10.9999/unknown")).toEqual({
			id: "doi:10.9999/unknown",
			outcome: "failed",
			reason: "not found on Crossref",
		});
	});

	test("a DOI already in the digests is reported already there", () => {
		expect(item(ALREADY)).toEqual({ id: ALREADY, outcome: "already there" });
	});

	test("a paper given by its metadata runs paper.ts with the metadata in a file of its own", () => {
		expect(item(SSRN_DOI)?.outcome).toBe("added");
		expect(item(`${ran.base}/page/quoted`)?.outcome).toBe("added");
		const entries = appended();
		expect(entries.find((one) => one.id === SSRN_DOI)?.ad_hoc).toBe(true);
		// The title came through a file, as written, and ran nothing.
		expect(entries.find((one) => one.title === QUOTED_TITLE)?.id).toBe(
			`url:${ran.base}/page/quoted`,
		);
		expect(existsSync(join(ran.dir, "pwned"))).toBe(false);
		const files = readdirSync(WORK, { recursive: true, encoding: "utf8" });
		const claimFiles = files.filter((name) =>
			name.endsWith("r10-paper-1.json"),
		);
		expect(claimFiles).toHaveLength(1);
		expect(
			JSON.parse(readFileSync(join(WORK, claimFiles[0] ?? ""), "utf8")).title,
		).toBe(PAPER_TITLE);
	});

	test("a paper paper.ts refuses is reported failed with each check that failed", () => {
		const refused = item(`${ran.base}/page/other`);
		expect(refused?.outcome).toBe("failed");
		expect(refused?.reason).toContain("title check");
		expect(refused?.reason).toContain("author check");
		expect(appended().some((one) => one.url === `${ran.base}/page/other`)).toBe(
			false,
		);
	});

	test("a DOI paper Crossref gave no abstract gets Semantic Scholar's before the push", async () => {
		const workflow = readFileSync(
			new URL("../../.github/workflows/add.yml", import.meta.url),
			"utf8",
		);
		const handle = workflow.indexOf("- name: Handle the queued requests");
		const fill = workflow.indexOf("- name: Fill in the DOI papers' abstracts");
		const push = workflow.indexOf("- name: Push the added entries");
		expect(handle).toBeGreaterThan(-1);
		expect(fill).toBeGreaterThan(handle);
		expect(push).toBeGreaterThan(fill);
		const step = workflow.slice(fill, push);
		expect(step).toMatch(
			/SEMANTIC_SCHOLAR_API_KEY: \$\{\{ secrets\.SEMANTIC_SCHOLAR_API_KEY \}\}/,
		);
		// The step's command, run on the file the handle step wrote.
		const command = step.match(/run: (node \S+ site\/digests\.js)\n/)?.[1];
		expect(command).toBeDefined();
		const [, script] = (command ?? "").split(" ");
		const filled = await run(
			process.execPath,
			[new URL(`../../${script}`, import.meta.url).pathname, ran.digests],
			{
				env: {
					...process.env,
					SEMANTIC_SCHOLAR_API: `${ran.base}/s2`,
					SEMANTIC_SCHOLAR_API_KEY: "test-key",
					SEMANTIC_SCHOLAR_PAUSE_MS: "0",
					SEMANTIC_SCHOLAR_RETRY_MS: "0",
					LIMINAL_TODAY: TODAY,
					LIMINAL_ALLOW_LOCAL: new URL(ran.base).host,
				},
			},
		).catch((error) => error as { stderr: string });
		expect(filled).toBeDefined();
		const entry = appended().find((one) => one.id === `doi:${PARROTS_DOI}`);
		expect(entry?.abstract).toBe(SEMANTIC_ABSTRACT);
	});
});
