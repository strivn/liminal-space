// Unit tests for the run and report commands of scripts/deploy/add-requests.ts, run as add.yml runs them: against stand-ins for
// the site's request routes, arXiv and a news page on 127.0.0.1, with the scout's real scripts as its children. Nothing
// here contacts a real site. One run handles four queued requests that each go their own way; the report runs and the
// refused command lines start with it and are read by the tests below.
// Requests that never answer run apart.
import { execFile } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
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
	test.todo(
		"a doi: id runs proceedings.ts --crossref with the id as an argument of its own",
	);
	test.todo(
		"arXiv ids and DOIs in one request each go to their own script, and each is reported",
	);
	test.todo(
		"a DOI Crossref doesn't know is reported failed, not found on Crossref",
	);
	test.todo("a DOI already in the digests is reported already there");
	test.todo(
		"a paper given by its metadata runs paper.ts with the metadata in a file of its own",
	);
	test.todo(
		"a paper paper.ts refuses is reported failed with each check that failed",
	);
	test.todo(
		"a DOI paper Crossref gave no abstract gets Semantic Scholar's before the push",
	);
});
