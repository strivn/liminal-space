// The real Worker under Node for unit tests: a SQLite database behind D1's interface, a stand-in for the keys Cloudflare
// Access publishes, and requests the way the owner's page sends them. The Worker's modules are loaded by their path at
// run time: a static import would make the tests' type check read the Worker's files, which use Cloudflare's runtime
// types.

import { readdirSync, readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const ROOT = join(import.meta.dirname, "..", "..");
const MIGRATIONS = join(ROOT, "worker", "migrations");

export const OWNER_AUD = "test-owner-audience";
export const OWNER_EMAIL = "owner@example.com";
export const SITE_ORIGIN = "https://ivan.wiryadi.com";

type SqlValue = string | number | null;

// One D1 statement over SQLite: the part of D1's binding the Worker's statements use.
type Statement = {
	sql: string;
	values: SqlValue[];
	bind(...values: SqlValue[]): Statement;
	run(): Promise<StatementResult>;
	all(): Promise<StatementResult>;
	first(): Promise<Record<string, unknown> | null>;
};
type StatementResult = {
	results: Record<string, unknown>[];
	meta: { rows_read: number; rows_written: number; changes: number };
};

// A D1 binding over a SQLite database: prepare, bind, run, all, first and batch (one transaction) with the real SQL.
export function d1Over(db: DatabaseSync) {
	function runStatement(statement: Statement): StatementResult {
		const prepared = db.prepare(statement.sql);
		const results = prepared.all(...statement.values);
		// all() on a write statement returns no rows; its change count comes from run's own result.
		let changes = 0;
		if (!/^\s*select/i.test(statement.sql)) {
			changes = Number(db.prepare("SELECT changes() AS n").get()?.n ?? 0);
		}
		return {
			results: results,
			meta: { rows_read: results.length, rows_written: changes, changes },
		};
	}
	function prepare(sql: string): Statement {
		const statement: Statement = {
			sql: sql,
			values: [],
			bind(...values) {
				statement.values = values;
				return statement;
			},
			async run() {
				return runStatement(statement);
			},
			async all() {
				return runStatement(statement);
			},
			async first() {
				return runStatement(statement).results[0] ?? null;
			},
		};
		return statement;
	}
	return {
		prepare,
		async batch(statements: Statement[]) {
			db.exec("BEGIN");
			try {
				const answers = statements.map(runStatement);
				db.exec("COMMIT");
				return answers;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		},
	};
}

// An empty database with every migration applied in order, as `wrangler d1 migrations apply` does.
export function migratedDatabase(): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	for (const name of readdirSync(MIGRATIONS).sort()) {
		db.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
	}
	return db;
}

// A stand-in for Cloudflare Access: it publishes a signing key at /cdn-cgi/access/certs, where the Worker fetches it,
// and signs login tokens.
export type Access = {
	origin: string;
	token(claims: { email: string }): Promise<string>;
	close(): Promise<void>;
};

export async function startAccess(): Promise<Access> {
	const { publicKey, privateKey } = await generateKeyPair("RS256");
	const jwk = {
		...(await exportJWK(publicKey)),
		kid: "test-key",
		alg: "RS256",
	};
	const server = http.createServer((_request, response) => {
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify({ keys: [jwk] }));
	});
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return {
		origin: origin,
		token: (claims) =>
			new SignJWT(claims)
				.setProtectedHeader({ alg: "RS256", kid: "test-key" })
				.setIssuer(origin)
				.setAudience(OWNER_AUD)
				.setExpirationTime("1h")
				.sign(privateKey),
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
			}),
	};
}

// What the Worker is given, as wrangler.jsonc and its secrets give it, with `extra` overriding any setting.
export function workerEnv(
	access: Access,
	db: DatabaseSync,
	extra: Record<string, unknown> = {},
) {
	return {
		DB: d1Over(db),
		ACCESS_TEAM_DOMAIN: access.origin,
		SYNC_AUD: "test-sync-audience",
		SYNC_CLIENT_ID: "test-sync-client.access",
		OWNER_AUD: OWNER_AUD,
		OWNER_EMAIL: OWNER_EMAIL,
		SITE_ORIGIN: SITE_ORIGIN,
		GITHUB_DISPATCH_TOKEN: "test-dispatch-token",
		GITHUB_REPOSITORY: "strivn/liminal-space",
		GITHUB_API: "http://127.0.0.1:9",
		MCP_AUD: "test-mcp-audience",
		JWKS_COOLDOWN_SECONDS: "0",
		...extra,
	};
}

// How the owner's page sends a request to an owner route: Access's token in the header and in the CF_Authorization
// cookie, the site's Origin and X-Liminal on a POST. Each can be left out or changed to see the Worker refuse it.
export type OwnerRequest = {
	method?: "GET" | "POST";
	body?: string;
	email?: string | null;
	origin?: string | null;
	liminal?: string | null;
};

export async function ownerRequest(
	access: Access,
	path: string,
	options: OwnerRequest = {},
): Promise<Request> {
	const method = options.method ?? "POST";
	const headers: Record<string, string> = {};
	const email = options.email === undefined ? OWNER_EMAIL : options.email;
	if (email !== null) {
		const token = await access.token({ email: email });
		headers["Cf-Access-Jwt-Assertion"] = token;
		headers.Cookie = `CF_Authorization=${token}`;
	}
	const origin = options.origin === undefined ? SITE_ORIGIN : options.origin;
	if (origin !== null) {
		headers.Origin = origin;
	}
	const liminal = options.liminal === undefined ? "1" : options.liminal;
	if (liminal !== null) {
		headers["X-Liminal"] = liminal;
	}
	return new Request(`${SITE_ORIGIN}${path}`, {
		method: method,
		headers: headers,
		body: method === "POST" ? (options.body ?? "{}") : null,
	});
}

// The Worker's entry module: fetch answers a request, scheduled runs a cron.
export type WorkerModule = {
	default: {
		fetch(request: Request, env: unknown): Promise<Response>;
		scheduled(
			controller: { cron: string; scheduledTime: number },
			env: unknown,
		): Promise<void>;
	};
};

// The Worker's notification module: the lines it can send, and the one it picks for a Jakarta date.
export type NotifyModule = {
	DIGEST_LINES: string[];
	REMINDER_LINES: string[];
	lineOfDay(kind: "digest" | "reminder", date: string): string;
};

export async function loadNotify(): Promise<NotifyModule> {
	return await import(
		pathToFileURL(join(ROOT, "worker", "src", "notify.ts")).href
	);
}

export async function loadWorker(): Promise<WorkerModule["default"]> {
	const loaded: WorkerModule = await import(
		pathToFileURL(join(ROOT, "worker", "src", "index.ts")).href
	);
	return loaded.default;
}
