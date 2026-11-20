// Which tokens the Worker trusts (worker/src/access.ts): what each of the three checks accepts and refuses, and how it
// fetches Access's keys, run against a local stand-in for Access's key list.
import assert from "node:assert/strict";
import type { JWTPayload } from "jose";
import { afterEach, beforeAll, beforeEach, test } from "vitest";
import {
	hmacToken,
	type Key,
	type KeyServer,
	nowSeconds,
	signedBy,
	startKeyServer,
	unsignedToken,
} from "../fixtures/access-keys.ts";
import { workerModule } from "./owner-worker.ts";

// A check's answer: accepted, or the status and the reason the request's log line keeps.
type Check = { ok: true } | { ok: false; status: 403 | 503; reason: string };
type AccessModule = {
	checkSyncToken(request: Request, env: unknown): Promise<Check>;
	checkOwnerToken(request: Request, env: unknown): Promise<Check>;
	checkConnectorToken(request: Request, env: unknown): Promise<Check>;
};

const SYNC_AUD = "sync-audience";
const OWNER_AUD = "owner-audience";
const MCP_AUD = "mcp-audience";
const CLIENT_ID = "sync-client.access";
const OWNER_EMAIL = "owner@example.com";

let access: AccessModule;
let keys: KeyServer;
let key: Key;

beforeAll(async () => {
	access = await workerModule<AccessModule>("access.ts");
});

// A fresh key list with one published key, for each test: the Worker keeps the keys it fetched per address.
beforeEach(async () => {
	keys = await startKeyServer();
	key = await keys.newKey("published");
	keys.publish(key);
});

afterEach(async () => {
	await keys.close();
});

// What the Worker is given, with the key list at the stand-in and no wait before fetching it again.
function env(extra: Record<string, string> = {}) {
	return {
		ACCESS_TEAM_DOMAIN: keys.origin,
		SYNC_AUD: SYNC_AUD,
		SYNC_CLIENT_ID: CLIENT_ID,
		OWNER_AUD: OWNER_AUD,
		OWNER_EMAIL: OWNER_EMAIL,
		MCP_AUD: MCP_AUD,
		JWKS_COOLDOWN_SECONDS: "0",
		...extra,
	};
}

// The claims Access signs, valid for an hour; `claims` changes any of them.
function claims(audience: string[], more: JWTPayload): JWTPayload {
	const now = nowSeconds();
	return {
		aud: audience,
		iss: keys.origin,
		iat: now,
		nbf: now,
		exp: now + 3600,
		...more,
	};
}

// The service token "sync" as Access signs it, and a person's login token.
function syncClaims(more: JWTPayload = {}): JWTPayload {
	return claims([SYNC_AUD], { common_name: CLIENT_ID, ...more });
}
function loginClaims(audience: string[], more: JWTPayload = {}): JWTPayload {
	return claims(audience, { email: OWNER_EMAIL, ...more });
}

// A request carrying a token in the header and, when given, in the browser's cookie.
function carrying(token: string | null, cookie: string | null = null): Request {
	const headers: Record<string, string> = {};
	if (token !== null) {
		headers["Cf-Access-Jwt-Assertion"] = token;
	}
	if (cookie !== null) {
		headers.Cookie = `CF_Authorization=${cookie}`;
	}
	return new Request("https://ivan.wiryadi.com/liminal-space/api", { headers });
}

function reasonOf(answer: Check): string {
	assert.equal(answer.ok, false);
	if (answer.ok) {
		return "";
	}
	return answer.reason;
}

// A refused token's status and reason, and that the reason never quotes the token.
async function refusal(
	check: Promise<Check>,
	token: string | null,
): Promise<{ status: number; reason: string }> {
	const answer = await check;
	assert.equal(answer.ok, false, "the token was refused");
	if (answer.ok) {
		return { status: 0, reason: "" };
	}
	assert.ok(answer.reason.length > 0, "the refusal names a reason");
	if (token !== null) {
		assert.equal(answer.reason.includes(token), false);
	}
	return { status: answer.status, reason: answer.reason };
}

test("security: a sync token signed by a published key is accepted", async () => {
	const token = await signedBy(key, syncClaims());
	assert.deepEqual(await access.checkSyncToken(carrying(token), env()), {
		ok: true,
	});
});

test("security: a sync token the Worker can't trust is refused with 403 and a reason", async () => {
	const stranger = await keys.newKey("not-published", "other");
	const forged = await keys.newKey("published", "other");
	const refused: Record<string, string | null> = {
		"no header": null,
		"a header that isn't a token": "not.a.token",
		"a token naming a published key but signed by another": await signedBy(
			forged,
			syncClaims(),
		),
		"a token signed by a key Access doesn't publish": await signedBy(
			stranger,
			syncClaims(),
		),
		'a token whose algorithm is "none"': unsignedToken(
			syncClaims(),
			"published",
		),
		"a token signed with HS256": await hmacToken(syncClaims(), "published"),
		"a token from another Access team": await signedBy(
			key,
			syncClaims({ iss: "https://another.cloudflareaccess.com" }),
		),
		"a token that expired a minute ago": await signedBy(
			key,
			syncClaims({ exp: nowSeconds() - 60 }),
		),
		"a token not valid until an hour from now": await signedBy(
			key,
			syncClaims({ nbf: nowSeconds() + 3600 }),
		),
		"a token for the owner app's audience only": await signedBy(
			key,
			claims([OWNER_AUD], { common_name: CLIENT_ID }),
		),
		"a token with no expiry": await signedBy(key, {
			aud: [SYNC_AUD],
			iss: keys.origin,
			common_name: CLIENT_ID,
		}),
		"a person's login token with the sync audience and the client id":
			await signedBy(key, syncClaims({ email: OWNER_EMAIL })),
		"a service token for another client id": await signedBy(
			key,
			syncClaims({ common_name: "another-client.access" }),
		),
	};
	for (const [name, token] of Object.entries(refused)) {
		const answer = await refusal(
			access.checkSyncToken(carrying(token), env()),
			token,
		);
		assert.equal(answer.status, 403, name);
	}
});

test("security: without SYNC_AUD or SYNC_CLIENT_ID no sync token is accepted", async () => {
	const token = await signedBy(key, syncClaims());
	for (const missing of ["SYNC_AUD", "SYNC_CLIENT_ID"]) {
		const answer = await refusal(
			access.checkSyncToken(carrying(token), env({ [missing]: "" })),
			token,
		);
		assert.equal(answer.status, 403, missing);
	}
});

test("security: a token signed by a key Access published after the Worker last fetched its keys is accepted, after one more fetch", async () => {
	const first = await signedBy(key, syncClaims());
	assert.equal((await access.checkSyncToken(carrying(first), env())).ok, true);
	assert.equal(keys.fetches(), 1);
	const later = await keys.newKey("published-later", "other");
	keys.publish(later);
	const token = await signedBy(later, syncClaims());
	assert.equal((await access.checkSyncToken(carrying(token), env())).ok, true);
	assert.equal(keys.fetches(), 2);
});

test("limit: tokens with unknown key ids fetch Access's keys at most once a minute", async () => {
	for (let k = 0; k < 20; k++) {
		const stranger = await keys.newKey(`unknown-${k}`, "other");
		const token = await signedBy(stranger, syncClaims());
		const answer = await refusal(
			access.checkSyncToken(
				carrying(token),
				env({ JWKS_COOLDOWN_SECONDS: "60" }),
			),
			token,
		);
		assert.equal(answer.status, 403);
	}
	assert.equal(keys.fetches(), 1);
});

test("security: when Access's keys can't be fetched the answer is 503, not 403, so the sender tries again", async () => {
	keys.answerWith(500);
	const token = await signedBy(key, syncClaims());
	const answer = await refusal(
		access.checkSyncToken(carrying(token), env()),
		token,
	);
	assert.equal(answer.status, 503);
});

test("security: the owner's login token is accepted on the owner routes when the browser's cookie holds it too", async () => {
	const token = await signedBy(key, loginClaims([OWNER_AUD]));
	assert.deepEqual(
		await access.checkOwnerToken(carrying(token, token), env()),
		{ ok: true },
	);
});

test("security: an owner token the Worker can't trust is refused with 403 and a reason", async () => {
	const refused: Record<string, string | null> = {
		"no header": null,
		"another person's login token": await signedBy(
			key,
			loginClaims([OWNER_AUD], { email: "someone@example.com" }),
		),
		"a sync token": await signedBy(key, syncClaims()),
		"the owner's login token with only the sync audience": await signedBy(
			key,
			loginClaims([SYNC_AUD]),
		),
		"the owner's login token that expired a minute ago": await signedBy(
			key,
			loginClaims([OWNER_AUD], { exp: nowSeconds() - 60 }),
		),
		"a service token whose claims name the owner's email": await signedBy(
			key,
			loginClaims([OWNER_AUD], { common_name: CLIENT_ID }),
		),
	};
	for (const [name, token] of Object.entries(refused)) {
		const answer = await refusal(
			access.checkOwnerToken(carrying(token, token), env()),
			token,
		);
		assert.equal(answer.status, 403, name);
	}
});

test("security: an owner route needs the browser's cookie to hold a valid owner token as well as the header", async () => {
	const token = await signedBy(key, loginClaims([OWNER_AUD]));
	const expired = await signedBy(
		key,
		loginClaims([OWNER_AUD], { exp: nowSeconds() - 60 }),
	);
	const someoneElse = await signedBy(
		key,
		loginClaims([OWNER_AUD], { email: "someone@example.com" }),
	);
	const cookies: Record<string, string | null> = {
		"no cookie": null,
		"a cookie holding an expired owner token": expired,
		"a cookie holding another person's token": someoneElse,
	};
	for (const [name, cookie] of Object.entries(cookies)) {
		const answer = await refusal(
			access.checkOwnerToken(carrying(token, cookie), env()),
			token,
		);
		assert.equal(answer.status, 403, name);
	}
});

test("security: a connector's token is refused on the owner routes even when it carries the owner audience, and the reason says so", async () => {
	const token = await signedBy(key, loginClaims([MCP_AUD, OWNER_AUD]));
	const answer = await refusal(
		access.checkOwnerToken(carrying(token), env()),
		token,
	);
	assert.equal(answer.status, 403);
	assert.equal(answer.reason, "a connector token was used on an owner route");
});

test("security: a connector's token is refused on the owner routes when it is also sent as the browser's cookie", async () => {
	const token = await signedBy(key, loginClaims([MCP_AUD, OWNER_AUD]));
	const owner = await signedBy(key, loginClaims([OWNER_AUD]));
	const requests: Record<string, Request> = {
		"the connector token in the header and the cookie": carrying(token, token),
		"the owner's token in the header, the connector's in the cookie": carrying(
			owner,
			token,
		),
	};
	for (const [name, request] of Object.entries(requests)) {
		const answer = await refusal(access.checkOwnerToken(request, env()), token);
		assert.equal(answer.status, 403, name);
		assert.equal(
			answer.reason,
			"a connector token was used on an owner route",
			name,
		);
	}
});

test("security: without OWNER_AUD or OWNER_EMAIL no owner token is accepted", async () => {
	const token = await signedBy(key, loginClaims([OWNER_AUD]));
	for (const missing of ["OWNER_AUD", "OWNER_EMAIL"]) {
		const answer = await refusal(
			access.checkOwnerToken(carrying(token, token), env({ [missing]: "" })),
			token,
		);
		assert.equal(answer.status, 403, missing);
	}
});

test("security: a connector token for the owner's email and the mcp audience is accepted", async () => {
	const token = await signedBy(key, loginClaims([MCP_AUD]));
	assert.deepEqual(await access.checkConnectorToken(carrying(token), env()), {
		ok: true,
	});
});

test("security: a connector token the Worker can't trust is refused with 403 and a reason", async () => {
	const refused: Record<string, string | null> = {
		"no header": null,
		"another person's token": await signedBy(
			key,
			loginClaims([MCP_AUD], { email: "someone@example.com" }),
		),
		"a sync token": await signedBy(key, syncClaims()),
		"the owner's browser token with only the owner audience": await signedBy(
			key,
			loginClaims([OWNER_AUD]),
		),
		"a service token carrying the mcp audience": await signedBy(
			key,
			loginClaims([MCP_AUD], { common_name: CLIENT_ID }),
		),
	};
	for (const [name, token] of Object.entries(refused)) {
		const answer = await refusal(
			access.checkConnectorToken(carrying(token), env()),
			token,
		);
		assert.equal(answer.status, 403, name);
	}
});

test("security: without MCP_AUD or OWNER_EMAIL the connector check answers 503, since signing in again can't help", async () => {
	const token = await signedBy(key, loginClaims([MCP_AUD]));
	for (const missing of ["MCP_AUD", "OWNER_EMAIL"]) {
		const answer = await access.checkConnectorToken(
			carrying(token),
			env({ [missing]: "" }),
		);
		assert.equal(answer.ok, false, missing);
		assert.match(reasonOf(answer), /misconfigured/);
		if (!answer.ok) {
			assert.equal(answer.status, 503, missing);
		}
	}
});
