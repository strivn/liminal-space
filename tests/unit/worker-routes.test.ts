// Unit test for wrangler.jsonc against worker/src/index.ts: assets.run_worker_first names every path the Worker answers
// (WORKER_PATHS) and no other, so a request to a route never goes to the static files instead. The "!" patterns send
// paths with a dot or a trailing "/" to the files; they aren't routes.
import assert from "node:assert/strict";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	type MockInstance,
	test,
	vi,
} from "vitest";
import { unstable_readConfig } from "wrangler";
import {
	type Key,
	type KeyServer,
	nowSeconds,
	signedBy,
	startKeyServer,
} from "../fixtures/access-keys.ts";
import {
	type Access,
	loadWorker,
	migratedDatabase,
	OWNER_AUD,
	OWNER_EMAIL,
	startAccess,
	workerEnv,
} from "../fixtures/worker-in-node.ts";
import { postToSite, readSiteState } from "../support/owner.ts";
import { startOwnerWorker } from "./owner-worker.ts";

const ROOT = path.join(import.meta.dirname, "..", "..");

// The Worker's entry module, loaded by its path at run time: a static import would make the tests' type check read the
// Worker's files, which use Cloudflare's runtime types (as sync-script.steps.ts loads push.ts). Loading it under Node
// touches no Cloudflare-only global.
const INDEX_MODULE = pathToFileURL(
	path.join(ROOT, "worker", "src", "index.ts"),
).href;

// WORKER_PATHS as worker/src/index.ts exports it: a list of paths.
async function workerPaths(): Promise<string[]> {
	const loaded: { WORKER_PATHS?: unknown } = await import(INDEX_MODULE);
	const paths = loaded.WORKER_PATHS;
	if (
		!Array.isArray(paths) ||
		!paths.every((each) => typeof each === "string")
	) {
		throw new Error(
			"worker/src/index.ts exports no WORKER_PATHS list of paths",
		);
	}
	return paths;
}

// The routes wrangler.jsonc runs the Worker first for, at the top level or in `environment`: run_worker_first without
// its "!" patterns.
function runWorkerFirstRoutes(environment?: string): string[] {
	const args: { config: string; env?: string } = {
		config: path.join(ROOT, "wrangler.jsonc"),
	};
	if (environment !== undefined) args.env = environment;
	const config = unstable_readConfig(args);
	const first = config.assets?.run_worker_first;
	if (!Array.isArray(first)) {
		throw new Error(
			`wrangler.jsonc's run_worker_first is ${JSON.stringify(first)}, not a list`,
		);
	}
	return first.filter((pattern) => !pattern.startsWith("!"));
}

test("run_worker_first lists every path in WORKER_PATHS, and no other path", async () => {
	const paths = await workerPaths();
	assert.ok(paths.length > 0, "WORKER_PATHS names at least one path");
	assert.deepEqual(runWorkerFirstRoutes().slice().sort(), paths.slice().sort());
});

// Staging runs the same Worker, so its environment repeats the same routes.
test("staging's run_worker_first lists every path in WORKER_PATHS too", async () => {
	const paths = await workerPaths();
	assert.deepEqual(
		runWorkerFirstRoutes("staging").slice().sort(),
		paths.slice().sort(),
	);
});

test("every path in WORKER_PATHS is spelled as a route: under /liminal-space, no wildcard, no dot, no trailing slash", async () => {
	for (const each of await workerPaths()) {
		assert.match(each, /^\/liminal-space\/[^*.]+[^*./]$/);
	}
});

// The import route the old page used to carry its state over was removed on 2026-11-03: the Worker answers an owner's
// POST to it with 404, and the saved state stays as it was.
test("the old import route is not a Worker path, so a POST to it answers 404 and changes nothing", async () => {
	const worker = await startOwnerWorker();
	try {
		const before = await readSiteState(worker.cloud);
		const route = "/liminal-space/api/owner/import";
		assert.ok(!(await workerPaths()).includes(route));
		const answer = await postToSite(worker.cloud, route, {
			read: { "arxiv:2601.00001": { depth: "read", date: "2026-11-01" } },
		});
		assert.equal(answer.status, 404);
		assert.deepEqual(await readSiteState(worker.cloud), before);
	} finally {
		await worker.stop();
	}
});

// ---- The Worker's answers to requests that are spelled, signed or sent wrongly, through its entry module ----

let keys: KeyServer;
let signingKey: Key;
let siteDb: DatabaseSync;
let workerEntry: Awaited<ReturnType<typeof loadWorker>>;
let siteEnv: ReturnType<typeof workerEnv>;
let loggedLines: string[];
let logSpy: MockInstance;

let access: Access;

beforeAll(async () => {
	keys = await startKeyServer();
	signingKey = await keys.newKey("signing");
	keys.publish(signingKey);
	access = await startAccess();
	workerEntry = await loadWorker();
});

afterAll(async () => {
	await keys.close();
	await access.close();
});

beforeEach(() => {
	siteDb = migratedDatabase();
	siteEnv = {
		...workerEnv(access, siteDb),
		ACCESS_TEAM_DOMAIN: keys.origin,
	};
	loggedLines = [];
	logSpy = vi.spyOn(console, "log").mockImplementation((line: string) => {
		loggedLines.push(line);
	});
});

afterEach(() => {
	logSpy.mockRestore();
});

const SITE = "https://ivan.wiryadi.com";

// A signed token valid for an hour for these audiences, as Access issues it for `who`.
function token(
	audience: string,
	who: { email: string } | { common_name: string },
) {
	const now = nowSeconds();
	return signedBy(signingKey, {
		aud: [audience],
		iss: keys.origin,
		iat: now,
		nbf: now,
		exp: now + 3600,
		...who,
	});
}

const syncToken = () =>
	token("test-sync-audience", { common_name: "test-sync-client.access" });
const ownerToken = () => token(OWNER_AUD, { email: OWNER_EMAIL });

// A push body holding one new paper.
const PUSH_BODY = JSON.stringify({
	entries: [
		{
			date: "2026-10-20",
			entry: {
				id: "arxiv:2610.00001",
				type: "paper",
				title: "A paper",
				authors: ["A. Author"],
				published: "2026-10-20",
				source: "arXiv",
				url: "https://arxiv.org/abs/2610.00001",
				abstract: "An abstract.",
			},
		},
	],
});

function entryCount(): number {
	return Number(siteDb.prepare("SELECT COUNT(*) AS n FROM entries").get()?.n);
}

test("a valid sync token reaches the push route and the entry is stored", async () => {
	const answer = await workerEntry.fetch(
		new Request(`${SITE}/liminal-space/api/sync/push`, {
			method: "POST",
			headers: { "Cf-Access-Jwt-Assertion": await syncToken() },
			body: PUSH_BODY,
		}),
		siteEnv,
	);
	assert.equal(answer.status, 200);
	assert.equal(entryCount(), 1);
});

test("a path not spelled exactly like a route answers 404 even with a valid sync token, and stores nothing", async () => {
	const spellings = [
		"/liminal-space/API/sync/push",
		"/liminal-space/api%2Fsync/push",
		"/liminal-space/api/sync%2Fpush",
		"/liminal-space//api/sync/push",
		"/liminal-space/api/sync/push/",
		"/liminal-space/api/sync/%70ush",
		"/liminal-spacex/api/sync/push",
		"/liminal-space/api/sync/pull",
		"/liminal-space/api/anything",
	];
	const signed = await syncToken();
	for (const path of spellings) {
		const answer = await workerEntry.fetch(
			new Request(`${SITE}${path}`, {
				method: "POST",
				headers: { "Cf-Access-Jwt-Assertion": signed },
				body: PUSH_BODY,
			}),
			siteEnv,
		);
		assert.equal(answer.status, 404, path);
	}
	assert.equal(entryCount(), 0);
});

test("security: the owner's login token on the sync push route is refused with 403, stores nothing, and the log line names the reason", async () => {
	const answer = await workerEntry.fetch(
		new Request(`${SITE}/liminal-space/api/sync/push`, {
			method: "POST",
			headers: { "Cf-Access-Jwt-Assertion": await ownerToken() },
			body: PUSH_BODY,
		}),
		siteEnv,
	);
	assert.equal(answer.status, 403);
	assert.equal(await answer.text(), "forbidden");
	assert.equal(entryCount(), 0);
	const line = JSON.parse(loggedLines[loggedLines.length - 1] ?? "{}");
	assert.equal(line.status, 403);
	assert.ok(line.reason.length > 0);
});

test("security: every Worker answer, accepted or refused, carries X-Content-Type-Options: nosniff", async () => {
	const owner = await ownerToken();
	const requests = [
		new Request(`${SITE}/liminal-space/api/owner/state`, {
			headers: {
				"Cf-Access-Jwt-Assertion": owner,
				Cookie: `CF_Authorization=${owner}`,
			},
		}),
		new Request(`${SITE}/liminal-space/mcp`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Cf-Access-Jwt-Assertion": await token("test-mcp-audience", {
					email: OWNER_EMAIL,
				}),
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		}),
		new Request(`${SITE}/liminal-space/api/sync/push`, {
			method: "POST",
			body: "{}",
		}),
		new Request(`${SITE}/liminal-space/not-a-route`),
	];
	const statuses: number[] = [];
	for (const request of requests) {
		const answer = await workerEntry.fetch(request, siteEnv);
		statuses.push(answer.status);
		assert.equal(
			answer.headers.get("X-Content-Type-Options"),
			"nosniff",
			request.url,
		);
	}
	assert.deepEqual(statuses, [200, 200, 403, 404]);
});

test("security: an owner POST with another site's Origin, the site's http Origin, a lookalike domain or no Origin is refused with 403", async () => {
	const owner = await ownerToken();
	const body = JSON.stringify({
		id: "arxiv:2610.00001",
		depth: "paper",
		date: "2026-10-20",
	});
	const origins: (string | null)[] = [
		"https://example.com",
		"http://ivan.wiryadi.com",
		"https://ivan.wiryadi.com.example.com",
		null,
	];
	for (const origin of origins) {
		const headers: Record<string, string> = {
			"Cf-Access-Jwt-Assertion": owner,
			Cookie: `CF_Authorization=${owner}`,
			"X-Liminal": "1",
		};
		if (origin !== null) {
			headers.Origin = origin;
		}
		const answer = await workerEntry.fetch(
			new Request(`${SITE}/liminal-space/api/owner/read`, {
				method: "POST",
				headers: headers,
				body: body,
			}),
			siteEnv,
		);
		assert.equal(answer.status, 403, String(origin));
	}
	const marks = siteDb.prepare("SELECT COUNT(*) AS n FROM read_state").get();
	assert.equal(marks?.n, 0);
});

test("security: an owner comment of 10,000 characters is saved and one of 10,001 is refused with 400 naming the text", async () => {
	const owner = await ownerToken();
	const send = async (length: number) => {
		const change = {
			entryId: "arxiv:2610.00001",
			thread: {
				id: `t${length}`,
				field: null,
				passage: null,
				occurrence: null,
			},
			save: [
				{
					id: `c${length}`,
					text: "x".repeat(length),
					created: "2026-10-20T08:00:00.000Z",
					edited: null,
				},
			],
			delete: [],
		};
		return workerEntry.fetch(
			new Request(`${SITE}/liminal-space/api/owner/comments`, {
				method: "POST",
				headers: {
					"Cf-Access-Jwt-Assertion": owner,
					Cookie: `CF_Authorization=${owner}`,
					"X-Liminal": "1",
					Origin: SITE,
				},
				body: JSON.stringify(change),
			}),
			siteEnv,
		);
	};
	assert.equal((await send(10_000)).status, 200);
	const over = await send(10_001);
	assert.equal(over.status, 400);
	assert.match(await over.text(), /text is too long/);
	const saved = siteDb.prepare("SELECT COUNT(*) AS n FROM comments").get();
	assert.equal(saved?.n, 1);
});
