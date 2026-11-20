// Unit tests for the program scripts/deploy/sync.ts (push, pull, pull --database, count), run as the scout and the workflows
// run it, against stand-ins for the hosted site and Cloudflare's API on 127.0.0.1. Nothing here contacts a real site.
// The runs are independent, so they all start together before the tests that read their outcomes.
import { execFile } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MAX_LOG_BYTES } from "../../shared/log-protocol.ts";
import type { PushResult } from "../../shared/push-protocol.ts";
import { allowLocal, closeServers, serve } from "./local-server.ts";

const SCRIPT = new URL("../../scripts/deploy/sync.ts", import.meta.url);
const run = promisify(execFile);
const SECRET = "test-secret-value-9f3a";
const TODAY = "2026-10-20";
const WORK = mkdtempSync(join(tmpdir(), "liminal-unit-sync-script-"));

type Result = { code: number; stdout: string; stderr: string };

// sync.ts with the given arguments in `dir`; `env` adds to (or, with undefined, removes from) the variables that give
// it a token and a short retry second.
async function sync(
	dir: string,
	args: string[],
	env: Record<string, string | undefined> = {},
): Promise<Result> {
	const variables: Record<string, string | undefined> = {
		...process.env,
		ACCESS_SYNC_ID: "test-id",
		ACCESS_SYNC_SECRET: SECRET,
		SYNC_RETRY_SECOND_MS: "1",
		LIMINAL_TODAY: TODAY,
		LIMINAL_CACHE: join(dir, "cache"),
		...env,
	};
	for (const name of Object.keys(variables)) {
		if (variables[name] === undefined) {
			delete variables[name];
		}
	}
	try {
		const done = await run(process.execPath, [SCRIPT.pathname, ...args], {
			cwd: dir,
			env: variables as NodeJS.ProcessEnv,
			timeout: 60_000,
		});
		return { code: 0, stdout: done.stdout, stderr: done.stderr };
	} catch (error) {
		const failed = error as { code: number; stdout: string; stderr: string };
		return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
	}
}

// A paper as the scripts write it; n picks its id.
function paper(n: number) {
	const id = `2610.${String(n).padStart(5, "0")}`;
	return {
		id: `arxiv:${id}`,
		type: "paper",
		title: `Test paper ${n}`,
		authors: ["Ada Example"],
		published: "2026-10-01",
		source: "arXiv Machine Learning",
		url: `https://arxiv.org/abs/${id}`,
		links: [{ label: "PDF", url: `https://arxiv.org/pdf/${id}` }],
		abstract: "We report what we measured.",
	};
}

// One digest line as the scripts write it, ending in a line break.
function line(date: string, entries: unknown[]) {
	return `digest(${JSON.stringify({ date: date, entries: entries })});\n`;
}

type Push = {
	id: string | undefined;
	secret: string | undefined;
	entries: { date: string; entry: { id: string } }[];
};

// A stand-in for the site's push route; `answer` gives the results (or a status) for each request, counting from 1.
async function pushSite(
	answer: (
		entries: Push["entries"],
		number: number,
	) => PushResult[] | { status: number; body?: string },
) {
	const pushes: Push[] = [];
	const base = await serve((incoming, out) => {
		const chunks: Buffer[] = [];
		incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
		incoming.on("end", () => {
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			pushes.push({
				id: incoming.headers["cf-access-client-id"] as string | undefined,
				secret: incoming.headers["cf-access-client-secret"] as
					| string
					| undefined,
				entries: body.entries,
			});
			const reply = answer(body.entries, pushes.length);
			if (Array.isArray(reply)) {
				out.writeHead(200, { "content-type": "application/json" });
				out.end(JSON.stringify({ results: reply }));
				return;
			}
			out.writeHead(reply.status);
			out.end(reply.body || "");
		});
	});
	return { url: base, pushes: pushes };
}

// A stand-in for the site's log route: every body it was sent, each answered 200.
async function logSite() {
	const sent: { id: string; date: string; log: string }[] = [];
	const url = await serve((incoming, out) => {
		const chunks: Buffer[] = [];
		incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
		incoming.on("end", () => {
			sent.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			out.writeHead(200);
			out.end();
		});
	});
	return { url: url, sent: sent };
}

const allAdded = (entries: Push["entries"]): PushResult[] =>
	entries.map((each) => ({ id: each.entry.id, outcome: "added" }));

const sentIds = (pushes: Push[]) =>
	pushes.flatMap((push) => push.entries.map((each) => each.entry.id));

// The hosted site's static files, by path under /data/, and what it was asked; a number answers every request with it.
type Hosted = { index: unknown; months: Record<string, unknown> };

async function dataSite(files: Hosted | number) {
	const asked: string[] = [];
	const base = await serve((incoming, out) => {
		asked.push(incoming.url as string);
		if (typeof files === "number") {
			out.writeHead(files);
			out.end();
			return;
		}
		if (incoming.url === "/data/index.json") {
			out.end(JSON.stringify(files.index));
			return;
		}
		const name = (incoming.url as string).replace("/data/", "");
		if (name in files.months) {
			out.end(JSON.stringify(files.months[name]));
			return;
		}
		out.writeHead(404);
		out.end();
	});
	return { url: base, asked: asked };
}

function hostedOf(
	months: Record<string, { date: string; entries: unknown[] }[]>,
) {
	const index: Record<string, string> = {};
	const files: Record<string, unknown> = {};
	for (const [month, lines] of Object.entries(months)) {
		index[month] = `months/${month}.abc123.json`;
		files[`months/${month}.abc123.json`] = { lines: lines };
	}
	return { index: { months: index }, months: files };
}

// A stand-in for Cloudflare's D1 query API: the rows of `database` by the statement asked; what it was asked.
type Database = {
	entries: { id: string; date: string; json: string }[];
	reads?: string[];
};
type Asked = {
	path: string;
	authorization: string | undefined;
	sql: string;
};

async function d1(database: Database, failWith?: number) {
	const asked: Asked[] = [];
	const base = await serve((incoming, out) => {
		const chunks: Buffer[] = [];
		incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
		incoming.on("end", () => {
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			asked.push({
				path: incoming.url as string,
				authorization: incoming.headers.authorization,
				sql: body.sql,
			});
			if (failWith !== undefined) {
				out.writeHead(failWith);
				out.end();
				return;
			}
			let rows: unknown[] = [];
			const dates = database.entries.map((entry) => entry.date).sort();
			if (body.sql.includes("MIN(date)")) {
				rows = [{ date: dates[0] }];
			} else if (body.sql.includes("MAX(date)")) {
				rows = [{ date: dates.at(-1) }];
			} else if (body.sql.includes("date >= ? AND date < ?")) {
				rows = database.entries.filter(
					(entry) =>
						entry.date >= `${body.params[0]}-01` &&
						entry.date < `${body.params[1]}-01`,
				);
			} else if (body.sql.includes("FROM read_state")) {
				rows = (database.reads || []).map((id) => ({ entry_id: id }));
			} else if (body.sql.includes("WHERE date = ?")) {
				rows = database.entries.filter(
					(entry) => entry.date === body.params[0],
				);
			}
			out.writeHead(200, { "content-type": "application/json" });
			out.end(JSON.stringify({ success: true, result: [{ results: rows }] }));
		});
	});
	return { base: base, asked: asked };
}

const row = (entry: Record<string, unknown>, date: string) => ({
	id: entry.id as string,
	date: date,
	json: JSON.stringify(entry),
});

const DATABASE_ENV = {
	CLOUDFLARE_API_TOKEN: "api-token-1",
	CLOUDFLARE_ACCOUNT_ID: "account-1",
	D1_DATABASE_ID: "database-1",
};

// Five papers dated today, one added ad hoc and one the surprise pick, three news items, and papers dated yesterday.
const COUNTED = [
	row(paper(1), TODAY),
	row(paper(2), TODAY),
	row(paper(3), TODAY),
	row({ ...paper(4), ad_hoc: true }, TODAY),
	row({ ...paper(5), pick: "surprise" }, TODAY),
	...[6, 7, 8].map((n) =>
		row(
			{
				id: `url:https://example.com/news/${n}`,
				type: "news",
				title: "News",
				authors: [],
				published: TODAY,
				source: "Fixture Times",
				url: `https://example.com/news/${n}`,
			},
			TODAY,
		),
	),
	...[9, 10, 11, 12].map((n) => row(paper(n), "2026-10-19")),
];

// ---- The runs: each makes its own folder and stand-ins, and returns what the tests below check ----

const OLD = line("2026-10-06", [paper(9)]);
let nextDir = 0;
function folderFor() {
	nextDir += 1;
	const dir = join(WORK, `run-${nextDir}`);
	mkdirSync(dir);
	return dir;
}

type Scenario = () => Promise<Record<string, unknown>>;

const SCENARIOS: Record<string, Scenario> = {
	// Two lines of 45 entries; the site judges four of them in its own ways and adds the rest.
	async mixedPush() {
		const dir = folderFor();
		const control = { ...paper(5), id: "arxiv:2610.1\u001b[2J" };
		const entries = [
			paper(1),
			paper(2),
			paper(3),
			paper(4),
			control,
			...Array.from({ length: 40 }, (_unused, k) => paper(k + 10)),
		];
		const site = await pushSite((sent) =>
			sent.map((each): PushResult => {
				const id = each.entry.id;
				if (id === "arxiv:2610.00001") {
					return { id: id, outcome: "filled", fields: ["figure", "links"] };
				}
				if (id === "arxiv:2610.00002") {
					return { id: id, outcome: "already there" };
				}
				if (id === "arxiv:2610.00003") {
					return { id: id, outcome: "refused", problems: ["title is missing"] };
				}
				if (id === control.id) {
					return {
						id: null,
						outcome: "refused",
						problems: ["id holds a control character"],
					};
				}
				return { id: id, outcome: "added" };
			}),
		);
		const file = join(dir, "digests.js");
		writeFileSync(
			file,
			line("2026-10-18", entries.slice(0, 3)) +
				line("2026-10-20", entries.slice(3)),
		);
		const result = await sync(dir, ["push", file], { LIMINAL_URL: site.url });
		return {
			result: result,
			pushes: site.pushes,
			entries: entries,
			pulled: existsSync(join(dir, "digests.pulled.js")),
		};
	},
	// A push that succeeds, then the same push again.
	async repeatedPush() {
		const dir = folderFor();
		const site = await pushSite(allAdded);
		const file = join(dir, "digests.js");
		const text =
			line("2026-10-18", [paper(1)]) + line("2026-10-20", [paper(2)]);
		writeFileSync(file, text);
		const first = await sync(dir, ["push", file], { LIMINAL_URL: site.url });
		const sentAfterFirst = site.pushes.length;
		const second = await sync(dir, ["push", file], { LIMINAL_URL: site.url });
		return {
			first: first,
			second: second,
			sentAfterFirst: sentAfterFirst,
			sentAfterSecond: site.pushes.length,
			dates: site.pushes[0]?.entries.map((each) => each.date),
			pulled: readFileSync(join(dir, "digests.pulled.js"), "utf8"),
			text: text,
			token: [site.pushes[0]?.id, site.pushes[0]?.secret],
		};
	},
	async retries() {
		const dir = folderFor();
		const site = await pushSite((entries, number) => {
			if (number <= 3) {
				return { status: 404 };
			}
			return allAdded(entries);
		});
		const file = join(dir, "digests.js");
		writeFileSync(file, line("2026-10-20", [paper(1), paper(2)]));
		return {
			result: await sync(dir, ["push", file], { LIMINAL_URL: site.url }),
			requests: site.pushes.length,
		};
	},
	async refusedForGood() {
		const dir = folderFor();
		const site = await pushSite(() => ({ status: 403, body: "denied" }));
		const file = join(dir, "digests.js");
		writeFileSync(file, line("2026-10-20", [paper(1)]));
		return {
			result: await sync(dir, ["push", file], { LIMINAL_URL: site.url }),
			requests: site.pushes.length,
			pulled: existsSync(join(dir, "digests.pulled.js")),
		};
	},
	// A log at the site's limit, and logs one byte over it in ASCII and in two-byte characters.
	async logSizes() {
		const site = await logSite();
		const logs = {
			atLimit: "a".repeat(MAX_LOG_BYTES),
			overInAscii: "a".repeat(MAX_LOG_BYTES + 1),
			overInBytes: "é".repeat(MAX_LOG_BYTES / 2 + 1),
		};
		const results = await Promise.all(
			Object.entries(logs).map(async ([name, log]) => {
				const dir = folderFor();
				writeFileSync(join(dir, "2026-10-20.md"), log);
				const result = await sync(dir, ["log", "run-1", "2026-10-20.md"], {
					LIMINAL_URL: site.url,
				});
				return [name, result] as const;
			}),
		);
		return { results: Object.fromEntries(results), sent: site.sent };
	},
	// Run ids that aren't a run's own and file names that aren't a log's, each with its file in place.
	async logCommandLines() {
		const site = await logSite();
		const commandLines = [
			["../run-1", "2026-10-20.md"],
			["run 1", "2026-10-20.md"],
			["run-1;id", "2026-10-20.md"],
			["", "2026-10-20.md"],
			["a".repeat(65), "2026-10-20.md"],
			["run-1", "2026-10-20.txt"],
			["run-1", "x2026-10-20.md"],
			["run-1", "2026-10-20.md.bak"],
			["run-1", "20261020.md"],
		];
		const results = await Promise.all(
			commandLines.map(async ([runId = "", name = ""]) => {
				const dir = folderFor();
				writeFileSync(join(dir, name), "a log\n");
				return sync(dir, ["log", runId, name], { LIMINAL_URL: site.url });
			}),
		);
		return { results: results, sent: site.sent };
	},
	async noConnection() {
		const dir = folderFor();
		// A port nothing answers on: a server that listened there is closed again.
		const closed = http.createServer();
		await new Promise<void>((resolve) =>
			closed.listen(0, "127.0.0.1", resolve),
		);
		const port = (closed.address() as AddressInfo).port;
		const url = `http://127.0.0.1:${port}`;
		allowLocal(port);
		await new Promise((resolve) => closed.close(resolve));
		const file = join(dir, "digests.js");
		writeFileSync(file, line("2026-10-20", [paper(1)]));
		return { result: await sync(dir, ["push", file], { LIMINAL_URL: url }) };
	},
	async wrongAnswer() {
		const dir = folderFor();
		const site = await pushSite(() => []);
		const file = join(dir, "digests.js");
		writeFileSync(file, line("2026-10-20", [paper(1), paper(2)]));
		return {
			result: await sync(dir, ["push", file], { LIMINAL_URL: site.url }),
			pulled: existsSync(join(dir, "digests.pulled.js")),
		};
	},
	// Before anything is sent: a line that doesn't load, and each missing token variable.
	async beforeSending() {
		const dir = folderFor();
		const site = await pushSite(allAdded);
		const broken = join(dir, "broken.js");
		writeFileSync(
			broken,
			`${line("2026-10-20", [paper(1)])}this is not a digest line\n`,
		);
		const unloaded = await sync(dir, ["push", broken], {
			LIMINAL_URL: site.url,
		});
		const withoutId = await sync(dir, ["push", broken], {
			LIMINAL_URL: site.url,
			ACCESS_SYNC_ID: undefined,
		});
		const withoutSecret = await sync(dir, ["push", broken], {
			LIMINAL_URL: site.url,
			ACCESS_SYNC_SECRET: undefined,
		});
		return {
			unloaded: unloaded,
			withoutId: withoutId,
			withoutSecret: withoutSecret,
			requests: site.pushes.length,
		};
	},
	async hostedPull() {
		const dir = folderFor();
		const site = await dataSite(
			hostedOf({
				"2026-10": [
					{ date: "2026-10-05", entries: [paper(3)] },
					{ date: "2026-10-04", entries: [paper(2)] },
					{ date: "2026-10-05", entries: [paper(4)] },
				],
				"2026-09": [{ date: "2026-09-30", entries: [paper(1)] }],
			}),
		);
		const file = join(dir, "digests.js");
		writeFileSync(file, OLD);
		const result = await sync(dir, ["pull", file], {
			LIMINAL_URL: site.url,
			ACCESS_SYNC_ID: undefined,
			ACCESS_SYNC_SECRET: undefined,
		});
		return {
			result: result,
			file: readFileSync(file, "utf8"),
			pulled: readFileSync(join(dir, "digests.pulled.js"), "utf8"),
		};
	},
	async hostedPullNotFound() {
		const dir = folderFor();
		const site = await dataSite(404);
		const file = join(dir, "digests.js");
		writeFileSync(file, OLD);
		writeFileSync(join(dir, "digests.pulled.js"), OLD);
		return {
			result: await sync(dir, ["pull", file], { LIMINAL_URL: site.url }),
			asked: site.asked.length,
			file: readFileSync(file, "utf8"),
			pulled: readFileSync(join(dir, "digests.pulled.js"), "utf8"),
		};
	},
	// An index that names a file the build never writes, or a month file of the wrong shape.
	async hostedPullBadData() {
		const bad: Record<string, Hosted> = {
			"a month file that leaves the data folder": {
				index: { months: { "2026-10": "months/../../secret.json" } },
				months: {},
			},
			"a month file outside months/": {
				index: { months: { "2026-10": "secret.json" } },
				months: {},
			},
			"a month file given as an address": {
				index: { months: { "2026-10": "http://127.0.0.1:1/x.json" } },
				months: {},
			},
			"a month file of the wrong shape": {
				index: { months: { "2026-10": "months/2026-10.abc.json" } },
				months: {
					"months/2026-10.abc.json": { lines: [{ date: 5, entries: [] }] },
				},
			},
		};
		const outcomes: Record<string, unknown> = {};
		await Promise.all(
			Object.entries(bad).map(async ([name, hosted]) => {
				const dir = folderFor();
				const site = await dataSite(hosted);
				const file = join(dir, "digests.js");
				const result = await sync(dir, ["pull", file], {
					LIMINAL_URL: site.url,
				});
				outcomes[name] = {
					result: result,
					asked: site.asked,
					written: existsSync(file),
				};
			}),
		);
		return outcomes;
	},
	async databasePull() {
		const dir = folderFor();
		const stand = await d1({
			entries: [
				row(paper(1), "2026-09-30"),
				row(paper(2), "2026-10-04"),
				row(paper(3), "2026-10-04"),
			],
			reads: ["arxiv:2610.00003", "arxiv:2610.00001"],
		});
		const file = join(dir, "digests.js");
		const result = await sync(dir, ["pull", "--database", file], {
			...DATABASE_ENV,
			CLOUDFLARE_API_BASE: stand.base,
		});
		return {
			result: result,
			file: readFileSync(file, "utf8"),
			pulled: readFileSync(join(dir, "digests.pulled.js"), "utf8"),
			reads: JSON.parse(readFileSync(join(dir, "digests.read.json"), "utf8")),
			asked: stand.asked,
		};
	},
	async databaseWithoutVariables() {
		const dir = folderFor();
		const stand = await d1({ entries: COUNTED });
		const file = join(dir, "digests.js");
		writeFileSync(file, OLD);
		const outcomes: Record<string, Result> = {};
		for (const name of Object.keys(DATABASE_ENV)) {
			outcomes[`pull ${name}`] = await sync(dir, ["pull", "--database", file], {
				...DATABASE_ENV,
				CLOUDFLARE_API_BASE: stand.base,
				[name]: undefined,
			});
		}
		outcomes.count = await sync(dir, ["count", "--database"], {
			...DATABASE_ENV,
			CLOUDFLARE_API_BASE: stand.base,
			D1_DATABASE_ID: undefined,
		});
		for (const args of [
			["count"],
			["count", "--database", "digests.js"],
			["count", "digests.js"],
		]) {
			outcomes[`usage ${args.join(" ")}`] = await sync(dir, args, {
				...DATABASE_ENV,
				CLOUDFLARE_API_BASE: stand.base,
			});
		}
		return {
			outcomes: outcomes,
			asked: stand.asked.length,
			file: readFileSync(file, "utf8"),
		};
	},
	async count() {
		const dir = folderFor();
		const stand = await d1({ entries: COUNTED });
		const result = await sync(dir, ["count", "--database"], {
			...DATABASE_ENV,
			CLOUDFLARE_API_BASE: stand.base,
		});
		const broken = await d1({ entries: [] }, 500);
		const failed = await sync(dir, ["count", "--database"], {
			...DATABASE_ENV,
			CLOUDFLARE_API_BASE: broken.base,
		});
		return {
			result: result,
			asked: stand.asked.length,
			failed: failed,
			failedAsked: broken.asked.length,
		};
	},
};

// biome-ignore lint/suspicious/noExplicitAny: each run returns its own shape, read by the tests that follow it
const outcomes: Record<string, any> = {};

beforeAll(async () => {
	await Promise.all(
		Object.entries(SCENARIOS).map(async ([name, scenario]) => {
			outcomes[name] = await scenario();
		}),
	);
}, 120_000);
afterAll(async () => {
	await closeServers();
	rmSync(WORK, { recursive: true, force: true });
});

describe("push", () => {
	test("push prints each entry's outcome in file order and a summary count, and exits non-zero when an entry is refused", () => {
		const { result } = outcomes.mixedPush;
		expect(result.code).toBe(1);
		const lines = result.stdout.trimEnd().split("\n");
		expect(lines.slice(0, 5)).toEqual([
			"filled arxiv:2610.00001 figure, links",
			"already there arxiv:2610.00002",
			"refused line 1 entry 3 arxiv:2610.00003: title is missing",
			"added arxiv:2610.00004",
			"refused line 2 entry 2: id holds a control character",
		]);
		expect(lines.at(-1)).toBe("added 41, filled 1, already there 1, refused 2");
	});

	test("privacy: 45 entries go in requests of at most 24, every entry once, in file order, with the token in the headers only; a refusal leaves no pulled copy", () => {
		const { pushes, entries, pulled, result } = outcomes.mixedPush;
		expect(pushes).toHaveLength(2);
		for (const push of pushes) {
			expect(push.entries.length).toBeLessThanOrEqual(24);
			expect(push.id).toBe("test-id");
			expect(push.secret).toBe(SECRET);
		}
		expect(sentIds(pushes)).toEqual(
			entries.map((entry: { id: string }) => entry.id),
		);
		expect(pulled).toBe(false);
		expect(result.stdout + result.stderr).not.toContain(SECRET);
	});

	test("a first push keeps the file as its pulled copy, and a push right after it sends nothing", () => {
		const o = outcomes.repeatedPush;
		expect(o.first.code).toBe(0);
		expect(o.first.stdout).toBe(
			"added arxiv:2610.00001\nadded arxiv:2610.00002\nadded 2, filled 0, already there 0, refused 0\n",
		);
		expect(o.dates).toEqual(["2026-10-18", "2026-10-20"]);
		expect(o.pulled).toBe(o.text);
		expect(o.second.code).toBe(0);
		expect(o.second.stdout).toBe(
			"added 0, filled 0, already there 0, refused 0\n",
		);
		expect(o.sentAfterSecond).toBe(o.sentAfterFirst);
	});

	test("limit: a site that answers 404 at first is asked again after 1, 2 and 4 seconds, each retry named, until it answers", () => {
		const o = outcomes.retries;
		expect(o.result.code).toBe(0);
		expect(o.result.stdout).toContain(
			"the site answered 404; trying again in 1 s\n" +
				"the site answered 404; trying again in 2 s\n" +
				"the site answered 404; trying again in 4 s\n",
		);
		expect(o.result.stdout.trimEnd().split("\n").at(-1)).toBe(
			"added 2, filled 0, already there 0, refused 0",
		);
		expect(o.requests).toBe(4);
	});

	test("limit: a site that answers 403 to every request makes push stop after six tries, with no token printed and no pulled copy", () => {
		const o = outcomes.refusedForGood;
		expect(o.result.code).toBe(1);
		expect(o.result.stderr).toContain(
			"push failed: the site answered 403 six times",
		);
		expect(o.requests).toBe(6);
		expect(o.result.stdout + o.result.stderr).not.toContain(SECRET);
		expect(o.pulled).toBe(false);
	});

	test("limit: a failed connection counts as a try, and six of them end the push", () => {
		const { result } = outcomes.noConnection;
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			"push failed: couldn't connect to the site six times",
		);
		expect(result.stdout.match(/couldn't connect; trying again/g)).toHaveLength(
			5,
		);
	});

	test("an answer that doesn't hold one result per entry stops the push without a pulled copy", () => {
		const o = outcomes.wrongAnswer;
		expect(o.result.code).toBe(1);
		expect(o.result.stderr).toContain(
			"the site's answer doesn't hold one result per entry",
		);
		expect(o.pulled).toBe(false);
	});

	test("a line that doesn't load and a missing token variable each stop the push before anything is read or sent", () => {
		const o = outcomes.beforeSending;
		expect(o.unloaded.code).toBe(1);
		expect(o.unloaded.stderr).toMatch(/line 2 of .*broken\.js doesn't load/);
		for (const missing of [o.withoutId, o.withoutSecret]) {
			expect(missing.code).toBe(1);
			expect(missing.stderr).toContain(
				"ACCESS_SYNC_ID and ACCESS_SYNC_SECRET must both be set",
			);
			// The file doesn't load either: had it been read first, that would have been said.
			expect(missing.stderr).not.toContain("doesn't load");
		}
		expect(o.requests).toBe(0);
	});
});

describe("log", () => {
	test("security: a log larger than the site's limit is refused with 'is larger than' and nothing is sent, while a log at the limit is sent", () => {
		const o = outcomes.logSizes;
		expect(o.results.atLimit.code).toBe(0);
		expect(o.results.atLimit.stdout).toBe(
			"sent the log of run run-1, dated 2026-10-20\n",
		);
		for (const over of [o.results.overInAscii, o.results.overInBytes]) {
			expect(over.code).toBe(1);
			expect(over.stderr).toContain(
				`2026-10-20.md is larger than ${MAX_LOG_BYTES} bytes`,
			);
		}
		expect(o.sent.map((body: { log: string }) => body.log.length)).toEqual([
			MAX_LOG_BYTES,
		]);
	});

	test("security: a log command with a run id that is not a run's own, or a file not named as a day's log, is refused with the usage line and nothing is sent", () => {
		const o = outcomes.logCommandLines;
		for (const result of o.results) {
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("usage: node scripts/deploy/sync.ts");
		}
		expect(o.sent).toEqual([]);
	});
});

describe("pull", () => {
	test("pull replaces the file with every hosted entry, one line per day, oldest day first, without a token, and says how many", () => {
		const o = outcomes.hostedPull;
		expect(o.result.code).toBe(0);
		expect(o.result.stdout).toBe("pulled 4 entries over 3 days\n");
		const expected =
			line("2026-09-30", [paper(1)]) +
			line("2026-10-04", [paper(2)]) +
			line("2026-10-05", [paper(3), paper(4)]);
		expect(o.file).toBe(expected);
		expect(o.pulled).toBe(expected);
	});

	test("limit: pull stops after six tries when the site's index can't be read, leaving the digests file and its pulled copy as they were", () => {
		const o = outcomes.hostedPullNotFound;
		expect(o.result.code).toBe(1);
		expect(o.result.stderr).toContain(
			"pull failed: the site answered 404 six times",
		);
		expect(o.asked).toBe(6);
		expect(o.file).toBe(OLD);
		expect(o.pulled).toBe(OLD);
	});

	test.each([
		"a month file that leaves the data folder",
		"a month file outside months/",
		"a month file given as an address",
		"a month file of the wrong shape",
	])(
		"security: an index with %s is refused, that file is never requested, and nothing is written",
		(name) => {
			const o = outcomes.hostedPullBadData[name];
			expect(o.result.code).toBe(1);
			expect(o.result.stderr).toContain(
				"pull failed: the site's data can't be read",
			);
			expect(o.written).toBe(false);
			expect(o.asked).not.toContain("/data/secret.json");
			if (name !== "a month file of the wrong shape") {
				expect(o.asked).toEqual(["/data/index.json"]);
			}
		},
	);
});

describe("pull --database and count --database", () => {
	test("pull --database writes the entries and the read marks of the named database, using the API token", () => {
		const o = outcomes.databasePull;
		expect(o.result.code).toBe(0);
		expect(o.result.stdout).toBe("pulled 3 entries over 2 days\n");
		const expected =
			line("2026-09-30", [paper(1)]) + line("2026-10-04", [paper(2), paper(3)]);
		expect(o.file).toBe(expected);
		expect(o.pulled).toBe(expected);
		expect(o.reads).toEqual(["arxiv:2610.00001", "arxiv:2610.00003"]);
		for (const asked of o.asked) {
			expect(asked.path).toBe(
				"/accounts/account-1/d1/database/database-1/query",
			);
			expect(asked.authorization).toBe("Bearer api-token-1");
		}
	});

	test("a missing Cloudflare variable is named before any request, and a wrong count command line prints the usage line", () => {
		const o = outcomes.databaseWithoutVariables;
		for (const name of Object.keys(DATABASE_ENV)) {
			const missing = o.outcomes[`pull ${name}`];
			expect(missing.code).toBe(1);
			expect(missing.stderr).toContain(`${name} must be set`);
		}
		expect(o.outcomes.count.stderr).toContain("D1_DATABASE_ID must be set");
		for (const usage of [
			"usage count",
			"usage count --database digests.js",
			"usage count digests.js",
		]) {
			expect(o.outcomes[usage].code).toBe(1);
			expect(o.outcomes[usage].stderr).toContain(
				"usage: node scripts/deploy/sync.ts",
			);
		}
		expect(o.asked).toBe(0);
		expect(o.file).toBe(OLD);
	});

	test("count prints the scout's papers dated today with one query, leaving out ad hoc and surprise papers, news and yesterday's", () => {
		const o = outcomes.count;
		expect(o.result.code).toBe(0);
		expect(o.result.stdout).toBe("papers today: 3\n");
		expect(o.asked).toBe(1);
	});

	test("limit: count tries six times when the database answers 500, then stops without printing a count", () => {
		const o = outcomes.count;
		expect(o.failed.code).toBe(1);
		expect(o.failed.stdout).not.toContain("papers today");
		expect(o.failedAsked).toBe(6);
	});
});
