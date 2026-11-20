// Checks the Cf-Access-Jwt-Assertion header Cloudflare Access adds to every request it lets through.
// The Worker checks it again itself: Access lets an encoded slash (/owner%2F) through.
import {
	createRemoteJWKSet,
	errors,
	type JWTPayload,
	type JWTVerifyGetKey,
	jwtVerify,
} from "jose";
import type { Env } from "./env.ts";

// A token the Worker trusts, or why not. 403 for a token that fails; 503 when Access's keys can't be fetched, so a
// sender such as sync.ts retries. reason goes to the request's log line, never to the answer.
type AccessCheck =
	| { ok: true }
	| { ok: false; status: 403 | 503; reason: string };

// How long to wait before fetching Access's keys again for an unknown key id, when JWKS_COOLDOWN_SECONDS isn't set.
const DEFAULT_COOLDOWN_SECONDS = 60;

// Access's key sets, one per keys address and cooldown, kept for as long as the Worker instance lives: jose keeps the
// fetched keys inside each one, so a request after the first doesn't fetch them again.
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

// The key set for this Worker's settings, made on first use.
function keySetFor(env: Env) {
	const certsUrl = new URL(`${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
	let cooldownSeconds = DEFAULT_COOLDOWN_SECONDS;
	if (env.JWKS_COOLDOWN_SECONDS !== undefined) {
		const configured = Number(env.JWKS_COOLDOWN_SECONDS);
		if (Number.isFinite(configured) && configured >= 0) {
			cooldownSeconds = configured;
		}
	}
	const key = `${certsUrl.href} ${cooldownSeconds}`;
	let keySet = keySets.get(key);
	if (keySet === undefined) {
		keySet = createRemoteJWKSet(certsUrl, {
			cooldownDuration: cooldownSeconds * 1000,
		});
		keySets.set(key, keySet);
	}
	return keySet;
}

// Why a token failed, for the log line: jose's error code and message, which name the check (such as
// '"exp" claim timestamp check failed') and never quote the token. Any other error gives only its name.
function failureReason(error: unknown) {
	if (error instanceof errors.JOSEError) {
		return `${error.code}: ${error.message}`;
	}
	if (error instanceof Error) {
		return error.name;
	}
	return "unknown error";
}

// A token whose signature, issuer, audience and times Access vouches for: its claims, or why it was refused.
type VerifiedToken =
	| { ok: true; payload: JWTPayload }
	| { ok: false; status: 403 | 503; reason: string };

// Check the Cf-Access-Jwt-Assertion header Access adds, with verifyToken's checks.
async function verifyAccessToken(
	request: Request,
	env: Env,
	audience: string,
): Promise<VerifiedToken> {
	const token = request.headers.get("Cf-Access-Jwt-Assertion");
	if (!token) {
		return {
			ok: false,
			status: 403,
			reason: "no Cf-Access-Jwt-Assertion header",
		};
	}
	return verifyToken(token, env, audience);
}

// Check a token from Access: RS256, signed by a key Access publishes at <ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs,
// issuer ACCESS_TEAM_DOMAIN, audience `audience`, not expired and already valid. The keys are fetched once per Worker
// instance and again for an unknown key id, at most once per JWKS_COOLDOWN_SECONDS.
async function verifyToken(
	token: string,
	env: Env,
	audience: string,
): Promise<VerifiedToken> {
	// Look the token's key up in Access's keys. A key id Access doesn't publish is the token's fault (403); keys that
	// can't be fetched or read are not, so the sender is asked to try again (503).
	const keySet = keySetFor(env);
	let keysUnavailable = false;
	const getKey: JWTVerifyGetKey = async (header, flattened) => {
		try {
			return await keySet(header, flattened);
		} catch (error) {
			const noKeyForToken =
				error instanceof errors.JWKSNoMatchingKey ||
				error instanceof errors.JWKSMultipleMatchingKeys;
			if (!noKeyForToken) {
				keysUnavailable = true;
			}
			throw error;
		}
	};

	// jose checks the algorithm before looking up a key, then the signature, issuer, audience, exp and nbf.
	try {
		const verified = await jwtVerify(token, getKey, {
			algorithms: ["RS256"],
			issuer: env.ACCESS_TEAM_DOMAIN,
			audience: audience,
			requiredClaims: ["exp"],
		});
		return { ok: true, payload: verified.payload };
	} catch (error) {
		if (keysUnavailable) {
			return {
				ok: false,
				status: 503,
				reason: `Access's keys can't be fetched (${failureReason(error)})`,
			};
		}
		return { ok: false, status: 403, reason: failureReason(error) };
	}
}

// Accept only a token for Access service token "sync": verifyAccessToken's checks with audience SYNC_AUD, and
// "common_name" equal to SYNC_CLIENT_ID. A person's login token (it has "email") is refused.
export async function checkSyncToken(
	request: Request,
	env: Env,
): Promise<AccessCheck> {
	// Without both settings no token can be matched to the sync app, so nothing gets in.
	if (!env.SYNC_AUD || !env.SYNC_CLIENT_ID) {
		return {
			ok: false,
			status: 403,
			reason: "SYNC_AUD or SYNC_CLIENT_ID is not set",
		};
	}
	const verified = await verifyAccessToken(request, env, env.SYNC_AUD);
	if (!verified.ok) {
		return verified;
	}
	const payload = verified.payload;

	// A login token for a person carries their email; only the service token's own client id is the sync client.
	if (payload.email !== undefined) {
		return { ok: false, status: 403, reason: "a person's login token" };
	}
	if (payload.common_name !== env.SYNC_CLIENT_ID) {
		return {
			ok: false,
			status: 403,
			reason: "common_name is not the sync client id",
		};
	}
	return { ok: true };
}

// Why a verified token isn't the owner's own, or null when it is: a service token names its client, never a person, and a
// person's token must carry the owner's email.
function notOwnerReason(payload: JWTPayload, env: Env): string | null {
	if (payload.common_name !== undefined) {
		return "a service token";
	}
	if (payload.email !== env.OWNER_EMAIL) {
		return "email is not the owner's";
	}
	return null;
}

// A cookie's value from the request's Cookie header, or null when the request doesn't carry it.
function cookieValue(request: Request, name: string): string | null {
	const header = request.headers.get("Cookie");
	if (header === null) {
		return null;
	}
	for (const part of header.split(";")) {
		const pair = part.trim();
		const equals = pair.indexOf("=");
		if (equals > 0 && pair.slice(0, equals) === name) {
			return pair.slice(equals + 1);
		}
	}
	return null;
}

// True when a token's audience names `audience`. "aud" is one string or a list of them.
function hasAudience(payload: JWTPayload, audience: string) {
	if (Array.isArray(payload.aud)) {
		return payload.aud.includes(audience);
	}
	return payload.aud === audience;
}

// Check the CF_Authorization cookie a browser holds its Access login in, with the same checks as the owner's header.
async function checkOwnerCookie(
	request: Request,
	env: Env,
): Promise<AccessCheck> {
	const token = cookieValue(request, "CF_Authorization");
	if (!token) {
		return { ok: false, status: 403, reason: "no CF_Authorization cookie" };
	}
	const verified = await verifyToken(token, env, env.OWNER_AUD);
	if (!verified.ok) {
		return {
			ok: false,
			status: verified.status,
			reason: `CF_Authorization cookie: ${verified.reason}`,
		};
	}
	const reason = notOwnerReason(verified.payload, env);
	if (reason !== null) {
		return {
			ok: false,
			status: 403,
			reason: `CF_Authorization cookie: ${reason}`,
		};
	}
	if (isConnectorToken(verified.payload, env)) {
		return { ok: false, status: 403, reason: CONNECTOR_ON_OWNER_ROUTE };
	}
	return { ok: true };
}

// Why a token naming the mcp app is refused on an owner route.
const CONNECTOR_ON_OWNER_ROUTE = "a connector token was used on an owner route";

// True when a token also names the mcp app: a connector's, which carries the owner audience too.
function isConnectorToken(payload: JWTPayload, env: Env) {
	return Boolean(env.MCP_AUD) && hasAudience(payload, env.MCP_AUD);
}

// Accept only the owner's login token for the owner app: the same signature, issuer and time checks as checkSyncToken,
// audience OWNER_AUD, and "email" equal to OWNER_EMAIL. A service token (it has "common_name") is refused. An empty
// OWNER_AUD or OWNER_EMAIL refuses everything. A token that also names the mcp app is a connector's, refused in the
// header and in the cookie. The request's CF_Authorization cookie must also hold a token passing the same checks.
export async function checkOwnerToken(
	request: Request,
	env: Env,
): Promise<AccessCheck> {
	// Without both settings no token can be matched to the owner, so nothing gets in.
	if (!env.OWNER_AUD || !env.OWNER_EMAIL) {
		return {
			ok: false,
			status: 403,
			reason: "OWNER_AUD or OWNER_EMAIL is not set",
		};
	}
	const verified = await verifyAccessToken(request, env, env.OWNER_AUD);
	if (!verified.ok) {
		return verified;
	}
	const reason = notOwnerReason(verified.payload, env);
	if (reason !== null) {
		return { ok: false, status: 403, reason: reason };
	}
	if (isConnectorToken(verified.payload, env)) {
		return { ok: false, status: 403, reason: CONNECTOR_ON_OWNER_ROUTE };
	}

	// The header's token is the owner's; only a browser also holds it in the cookie.
	return checkOwnerCookie(request, env);
}

// Accept only a connector's token for the mcp app: the same signature, issuer and time checks, audience MCP_AUD, and
// "email" equal to OWNER_EMAIL. The caller answers 401 for a refused token, which tells the connector to sign in again.
// An empty MCP_AUD or OWNER_EMAIL refuses everything with 503: the Worker is misconfigured, and signing in again
// can't help.
export async function checkConnectorToken(
	request: Request,
	env: Env,
): Promise<AccessCheck> {
	// Without both settings no token can be matched to the owner's connector, so nothing gets in.
	if (!env.MCP_AUD || !env.OWNER_EMAIL) {
		return {
			ok: false,
			status: 503,
			reason: "misconfigured: MCP_AUD or OWNER_EMAIL is not set",
		};
	}
	const verified = await verifyAccessToken(request, env, env.MCP_AUD);
	if (!verified.ok) {
		return verified;
	}
	const reason = notOwnerReason(verified.payload, env);
	if (reason !== null) {
		return { ok: false, status: 403, reason: reason };
	}
	return { ok: true };
}
