// Unit tests for sync.ts push-study and pull-study, run as the workflows run it, against stand-ins for the hosted site
// and Cloudflare's API on 127.0.0.1. Nothing here contacts a real site.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, test } from "vitest";
import { isJsonObject } from "../../shared/narrow.ts";
import { closeServers, serve } from "./local-server.ts";

const SCRIPT = new URL("../../scripts/deploy/sync.ts", import.meta.url);
const run = promisify(execFile);
const SECRET = "test-secret-value-9f3a";
const WORK = mkdtempSync(join(tmpdir(), "liminal-unit-sync-study-"));
const DATABASE_ENV = {
	CLOUDFLARE_API_TOKEN: "api-token-1",
	CLOUDFLARE_ACCOUNT_ID: "account-1",
	D1_DATABASE_ID: "database-1",
};

afterAll(async () => {
	await closeServers();
	rmSync(WORK, { recursive: true, force: true });
});

type Result = { code: number; stdout: string; stderr: string };

async function sync(
	dir: string,
	args: string[],
	env: Record<string, string> = {},
): Promise<Result> {
	try {
		const done = await run(process.execPath, [SCRIPT.pathname, ...args], {
			cwd: dir,
			env: {
				...process.env,
				ACCESS_SYNC_ID: "test-id",
				ACCESS_SYNC_SECRET: SECRET,
				SYNC_RETRY_SECOND_MS: "1",
				...env,
			},
			timeout: 60_000,
		});
		return { code: 0, stdout: done.stdout, stderr: done.stderr };
	} catch (error) {
		const failed = error as { code: number; stdout: string; stderr: string };
		return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
	}
}

function folderFor(): string {
	return mkdtempSync(join(WORK, "run-"));
}

// A study as the job writes it: a title of one word.
function study(id: string, meaning = "apple") {
	return {
		id: id,
		title: [
			{
				text: "苹果",
				syllables: ["píng", "guǒ"],
				meaning: meaning,
				meaningFrom: "dictionary",
				name: false,
				inDictionary: true,
				pinyinChecked: true,
			},
		],
		description: [],
	};
}

const linesOf = (studies: unknown[]) =>
	studies.map((one) => `${JSON.stringify(one)}\n`).join("");

type Sent = { id: string; secret: string; study: { id: string } };

// A stand-in for the site's study route: what it was sent, in order; it refuses the ids in `refuse`.
async function studySite(refuse: string[] = []) {
	const sent: Sent[] = [];
	const url = await serve((incoming, out) => {
		const chunks: Buffer[] = [];
		incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
		incoming.on("end", () => {
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			sent.push({
				id: String(incoming.headers["cf-access-client-id"]),
				secret: String(incoming.headers["cf-access-client-secret"]),
				study: body.study,
			});
			out.writeHead(200, { "content-type": "application/json" });
			if (refuse.includes(body.study.id)) {
				out.end(
					JSON.stringify({
						id: body.study.id,
						outcome: "refused",
						problems: [
							"the pieces of title do not join into the entry's title",
						],
					}),
				);
				return;
			}
			out.end(JSON.stringify({ id: body.study.id, outcome: "stored" }));
		});
	});
	return { url: url, sent: sent };
}

test("push-study sends only the studies that changed since the last pull-study", async () => {
	const dir = folderFor();
	const [a, b, c] = ["url:a", "url:b", "url:c"].map((id) => study(id));
	const file = join(dir, "study.jsonl");
	writeFileSync(file, linesOf([a, b, c]));
	writeFileSync(join(dir, "study.pulled.jsonl"), linesOf([a, b]));
	const site = await studySite();

	const first = await sync(dir, ["push-study", file], {
		LIMINAL_URL: site.url,
	});
	expect(first.code).toBe(0);
	expect(site.sent.map((one) => one.study.id)).toEqual(["url:c"]);
	expect(site.sent[0]?.id).toBe("test-id");
	expect(site.sent[0]?.secret).toBe(SECRET);
	expect(readFileSync(join(dir, "study.pulled.jsonl"), "utf8")).toBe(
		linesOf([a, b, c]),
	);

	// A study written again with a corrected meaning is sent again, and nothing else.
	writeFileSync(file, linesOf([a, study("url:b", "pear"), c]));
	const second = await sync(dir, ["push-study", file], {
		LIMINAL_URL: site.url,
	});
	expect(second.code).toBe(0);
	expect(site.sent.map((one) => one.study.id)).toEqual(["url:c", "url:b"]);
});

test("a refused study is reported with its problems, and the other studies are still sent", async () => {
	const dir = folderFor();
	const all = ["url:a", "url:b", "url:c"].map((id) => study(id));
	const file = join(dir, "study.jsonl");
	writeFileSync(file, linesOf(all));
	const site = await studySite(["url:b"]);

	const result = await sync(dir, ["push-study", file], {
		LIMINAL_URL: site.url,
	});
	expect(site.sent.map((one) => one.study.id)).toEqual([
		"url:a",
		"url:b",
		"url:c",
	]);
	expect(result.code).toBe(1);
	expect(result.stdout).toContain(
		"refused url:b: the pieces of title do not join into the entry's title",
	);
	expect(result.stdout).toContain("stored 2, refused 1");
	// The refused study is sent again next time: the pulled copy was not made.
	const next = await sync(dir, ["push-study", file], { LIMINAL_URL: site.url });
	expect(next.code).toBe(1);
	expect(site.sent).toHaveLength(6);
});

// A stand-in for Cloudflare's D1 query API holding these studies: it answers "WHERE id > ?" with at most the LIMIT.
async function studyDatabase(studies: { id: string }[]) {
	const asked: { authorization: string | undefined; sql: string }[] = [];
	const base = await serve((incoming, out) => {
		const chunks: Buffer[] = [];
		incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
		incoming.on("end", () => {
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			asked.push({
				authorization: incoming.headers.authorization,
				sql: body.sql,
			});
			const limit = Number(/LIMIT (\d+)/.exec(body.sql)?.[1]);
			const rows = studies
				.filter((one) => one.id > body.params[0])
				.sort((x, y) => (x.id < y.id ? -1 : 1))
				.slice(0, limit)
				.map((one) => ({ json: JSON.stringify(one) }));
			out.writeHead(200, { "content-type": "application/json" });
			out.end(JSON.stringify({ success: true, result: [{ results: rows }] }));
		});
	});
	return { base: base, asked: asked };
}

test("pull-study --database writes every stored study to the study file, one per line", async () => {
	const dir = folderFor();
	// More studies than one query's page, so the pull has to ask again where the first answer ended.
	const stored = Array.from({ length: 205 }, (_, k) =>
		study(`url:${String(k).padStart(3, "0")}`),
	);
	const database = await studyDatabase(stored);
	const file = join(dir, "study.jsonl");
	writeFileSync(file, linesOf([study("url:old")]));

	const result = await sync(dir, ["pull-study", "--database", file], {
		...DATABASE_ENV,
		CLOUDFLARE_API_BASE: database.base,
	});
	expect(result.code).toBe(0);
	expect(readFileSync(file, "utf8")).toBe(linesOf(stored));
	expect(readFileSync(join(dir, "study.pulled.jsonl"), "utf8")).toBe(
		linesOf(stored),
	);
	expect(database.asked).toHaveLength(2);
	expect(
		database.asked.every((one) => one.authorization === "Bearer api-token-1"),
	).toBe(true);
});

test("pull-study without --database reads the public site's study files, so staging can show them", async () => {
	const dir = folderFor();
	const files: Record<string, unknown> = {
		"/study/0123456789abcdef.json": study("url:b"),
		"/study/fedcba9876543210.json": study("url:a"),
	};
	const index = {
		days: [
			{
				date: "2026-11-21",
				month: "2026-11",
				entries: [
					{ id: "url:b", type: "news", study: "study/0123456789abcdef.json" },
					{ id: "arxiv:2611.00001", type: "paper" },
					{ id: "url:a", type: "news", study: "study/fedcba9876543210.json" },
				],
			},
		],
		months: {},
	};
	const asked: string[] = [];
	const url = await serve((incoming, out) => {
		const path = String(incoming.url);
		asked.push(path);
		const body = path === "/data/index.json" ? index : files[path];
		if (!isJsonObject(body)) {
			out.writeHead(404);
			out.end();
			return;
		}
		out.end(JSON.stringify(body));
	});
	const file = join(dir, "study.jsonl");

	const result = await sync(dir, ["pull-study", file], { LIMINAL_URL: url });
	expect(result.code).toBe(0);
	expect(readFileSync(file, "utf8")).toBe(
		linesOf([study("url:a"), study("url:b")]),
	);
	expect(asked.sort()).toEqual([
		"/data/index.json",
		"/study/0123456789abcdef.json",
		"/study/fedcba9876543210.json",
	]);
});
