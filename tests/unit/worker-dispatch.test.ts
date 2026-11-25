// The Worker's routing: the order of dispatch's checks on made-up routes, and which methods each real route takes,
// which token it needs, and which owner POSTs need the site's own headers, read from the real Worker's answers.
import assert from "node:assert/strict";
import type http from "node:http";
import { afterAll, beforeAll, test, vi } from "vitest";
import {
	type Access,
	loadWorker,
	migratedDatabase,
	ownerRequest,
	SITE_ORIGIN,
	startAccess,
	workerEnv,
} from "../fixtures/worker-in-node.ts";
import {
	browserHeaders,
	type Cloud,
	connectorToken,
	firstKey,
	requestLogs,
	signToken,
	startCloud,
	startWorker,
	stopCloud,
	syncClaims,
} from "../support/cloud.ts";
import { ownerToken } from "../support/owner.ts";
import { workerModule } from "./owner-worker.ts";

// The request's log line, as worker/src/env.ts's RequestLog states it.
type Log = {
	method: string;
	path: string;
	status: number;
	reason?: string;
	queries: number;
	rowsRead: number;
	rowsWritten: number;
};

// worker/src/routes.ts as these tests call it, typed here so the tests' type check doesn't read Cloudflare's types.
type TestHandler = (
	request: Request,
	env: unknown,
	ctx: unknown,
	log: Log,
) => Response;
type TestRoute = {
	path: string;
	auth: "sync" | "owner" | "connector";
	methods: Partial<Record<"GET" | "POST", { handler: TestHandler }>>;
};
type RoutesModule = {
	dispatch(
		routes: TestRoute[],
		request: Request,
		env: unknown,
		ctx: unknown,
		log: Log,
	): Promise<Response>;
};

const SYNC_ROUTE = "/test/sync";
const CONNECTOR_ROUTE = "/test/mcp";
const OWNER_ROUTE = "/test/owner";

// Every request that reached a made-up route's handler, as "METHOD path".
const handled: string[] = [];
const record: TestHandler = (request, _env, _ctx, log) => {
	handled.push(`${request.method} ${log.path}`);
	return new Response("handled");
};

// Three made-up routes, one per token, the owner's with a GET and a POST.
const TEST_ROUTES: TestRoute[] = [
	{ path: SYNC_ROUTE, auth: "sync", methods: { POST: { handler: record } } },
	{
		path: CONNECTOR_ROUTE,
		auth: "connector",
		methods: { POST: { handler: record } },
	},
	{
		path: OWNER_ROUTE,
		auth: "owner",
		methods: {
			GET: { handler: record },
			POST: { handler: record },
		},
	},
];

let routes: RoutesModule;
let access: Access;
let testEnv: ReturnType<typeof workerEnv>;

beforeAll(async () => {
	routes = await workerModule<RoutesModule>("routes.ts");
	access = await startAccess();
	testEnv = workerEnv(access, migratedDatabase());
});

afterAll(async () => {
	await access.close();
});

// Dispatch one request over the made-up routes: the answer, and the log line dispatch filled in.
async function dispatched(
	request: Request,
): Promise<{ answer: Response; log: Log }> {
	const log: Log = {
		method: request.method,
		path: new URL(request.url).pathname,
		status: 0,
		queries: 0,
		rowsRead: 0,
		rowsWritten: 0,
	};
	const answer = await routes.dispatch(TEST_ROUTES, request, testEnv, {}, log);
	return { answer: answer, log: log };
}

// A request with no token at all.
function bare(path: string, method: string): Request {
	return new Request(`https://ivan.wiryadi.com${path}`, { method: method });
}

// The refusals dispatch gives before a handler runs, each as a request to send.
function refusedRequests(): Promise<Request>[] {
	return [
		Promise.resolve(bare("/test/nowhere", "POST")),
		Promise.resolve(bare(OWNER_ROUTE, "PUT")),
		Promise.resolve(bare(SYNC_ROUTE, "POST")),
		ownerRequest(access, SYNC_ROUTE),
		Promise.resolve(bare(CONNECTOR_ROUTE, "POST")),
		ownerRequest(access, CONNECTOR_ROUTE),
		ownerRequest(access, OWNER_ROUTE, { email: "someone@example.com" }),
		ownerRequest(access, OWNER_ROUTE, { liminal: null }),
		ownerRequest(access, OWNER_ROUTE, { origin: "https://example.com" }),
	];
}

test("an unknown path answers 404 and checks no token", async () => {
	const { answer, log } = await dispatched(bare("/test/nowhere", "POST"));
	assert.equal(answer.status, 404);
	assert.equal(await answer.text(), "not found");
	assert.equal(log.reason, "no such route");
});

test("a wrong method answers 405 with Allow listing the route's methods", async () => {
	const { answer, log } = await dispatched(bare(OWNER_ROUTE, "PUT"));
	assert.equal(answer.status, 405);
	assert.equal(answer.headers.get("Allow"), "GET, POST");
	assert.equal(log.reason, "this route takes only GET and POST");
});

test("security: a sync route without a valid token answers 403", async () => {
	for (const request of [
		bare(SYNC_ROUTE, "POST"),
		await ownerRequest(access, SYNC_ROUTE),
	]) {
		const { answer } = await dispatched(request);
		assert.equal(answer.status, 403);
		assert.equal(await answer.text(), "forbidden");
	}
});

test("security: the connector route without a valid token answers 401 with WWW-Authenticate", async () => {
	for (const request of [
		bare(CONNECTOR_ROUTE, "POST"),
		await ownerRequest(access, CONNECTOR_ROUTE),
	]) {
		const { answer } = await dispatched(request);
		assert.equal(answer.status, 401);
		assert.equal(
			answer.headers.get("WWW-Authenticate"),
			'Bearer realm="liminal-space", error="invalid_token"',
		);
	}
});

test("security: an owner POST without the X-Liminal: 1 header is refused with 403", async () => {
	const { answer, log } = await dispatched(
		await ownerRequest(access, OWNER_ROUTE, { liminal: null }),
	);
	assert.equal(answer.status, 403);
	assert.equal(await answer.text(), "forbidden");
	assert.equal(log.reason, 'no "X-Liminal: 1" header');
});

test("security: an owner POST with another site's Origin is refused with 403", async () => {
	const { answer, log } = await dispatched(
		await ownerRequest(access, OWNER_ROUTE, { origin: "https://example.com" }),
	);
	assert.equal(answer.status, 403);
	assert.equal(await answer.text(), "forbidden");
	assert.equal(log.reason, "Origin is not the site's");
});

test("security: with SITE_ORIGIN unset or empty, an owner POST with an empty Origin or none is refused with 403", async () => {
	handled.length = 0;
	const cases: [unknown, string | null][] = [
		["", ""],
		["", null],
		[undefined, null],
	];
	for (const [siteOrigin, origin] of cases) {
		const env = { ...testEnv, SITE_ORIGIN: siteOrigin };
		const log: Log = {
			method: "POST",
			path: OWNER_ROUTE,
			status: 0,
			queries: 0,
			rowsRead: 0,
			rowsWritten: 0,
		};
		const request = await ownerRequest(access, OWNER_ROUTE, { origin });
		const answer = await routes.dispatch(TEST_ROUTES, request, env, {}, log);
		const what = `SITE_ORIGIN ${JSON.stringify(siteOrigin)}, Origin ${JSON.stringify(origin)}`;
		assert.equal(answer.status, 403, what);
		assert.equal(log.reason, "Origin is not the site's", what);
	}
	assert.deepEqual(handled, []);
});

test("security: while Access's keys can't be fetched, a sync or owner request is refused with 503 and its handler never runs", async () => {
	handled.length = 0;
	// Nothing listens on port 9, so fetching Access's keys fails.
	const env = { ...testEnv, ACCESS_TEAM_DOMAIN: "http://127.0.0.1:9" };
	for (const path of [SYNC_ROUTE, OWNER_ROUTE]) {
		const log: Log = {
			method: "POST",
			path: path,
			status: 0,
			queries: 0,
			rowsRead: 0,
			rowsWritten: 0,
		};
		const request = await ownerRequest(access, path);
		const answer = await routes.dispatch(TEST_ROUTES, request, env, {}, log);
		assert.equal(answer.status, 503, path);
	}
	assert.deepEqual(handled, []);
});

test("security: a request that makes the Worker throw is refused with 500 internal error, and the log line holds the error's name only", async () => {
	const worker = await loadWorker();
	// Access's address is not an address, so building the URL of its keys throws.
	const env = workerEnv(access, migratedDatabase(), {
		ACCESS_TEAM_DOMAIN: "not an address",
	});
	const logged: string[] = [];
	const spy = vi.spyOn(console, "log").mockImplementation((...parts) => {
		logged.push(parts.map(String).join(" "));
	});
	const request = await ownerRequest(access, "/liminal-space/api/owner/state", {
		method: "GET",
	});
	const answer = await worker.fetch(request, env);
	spy.mockRestore();
	assert.equal(answer.status, 500);
	assert.equal(await answer.text(), "internal error");
	assert.equal(logged.length, 1);
	assert.equal(
		JSON.parse(logged[0] ?? "").reason,
		"the Worker failed: TypeError",
	);
});

test("security: an owner GET on the same path needs neither header", async () => {
	const { answer } = await dispatched(
		await ownerRequest(access, OWNER_ROUTE, {
			method: "GET",
			liminal: null,
			origin: null,
		}),
	);
	assert.equal(answer.status, 200);
	assert.equal(await answer.text(), "handled");
});

test("security: a route runs only after the path, method, token and same-site checks all pass", async () => {
	handled.length = 0;
	for (const request of await Promise.all(refusedRequests())) {
		const { answer } = await dispatched(request);
		assert.notEqual(answer.status, 200, `${request.method} ${request.url}`);
	}
	assert.deepEqual(handled, []);
	const { answer } = await dispatched(await ownerRequest(access, OWNER_ROUTE));
	assert.equal(answer.status, 200);
	assert.deepEqual(handled, [`POST ${OWNER_ROUTE}`]);
});

// The methods a probe tries on every path.
const METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"];

// Who a token is for: the sync service token, the owner's browser login, or the claude.ai connector.
type Caller = "sync" | "owner" | "connector";
const CALLERS: Caller[] = ["sync", "owner", "connector"];

// The X-Liminal and Origin headers that mark a request as sent by the site's own page.
const SAME_SITE = { "X-Liminal": "1", Origin: SITE_ORIGIN };
const NO_LIMINAL_REASON = 'no "X-Liminal: 1" header';
const WRONG_ORIGIN_REASON = "Origin is not the site's";

// One route's policy as its answers show it: the methods it takes and the Allow header a wrong method gets, how it
// answers a request with no token, the callers whose token it takes, and the methods that refuse a request without
// "X-Liminal: 1" or with another site's Origin.
type Policy = {
	path: string;
	methods: string[];
	allow: string | null;
	noToken: string;
	takes: Caller[];
	needsLiminal: string[];
	needsOrigin: string[];
};

const FORBIDDEN = "403 forbidden";
const UNAUTHORIZED =
	'401 unauthorized, Bearer realm="liminal-space", error="invalid_token"';

// A route that takes only POST from one caller, with no same-site check.
function postFrom(path: string, caller: Caller, noToken: string): Policy {
	return {
		path: path,
		methods: ["POST"],
		allow: "POST",
		noToken: noToken,
		takes: [caller],
		needsLiminal: [],
		needsOrigin: [],
	};
}

// An owner change route: POST from the owner's page only.
function ownerChange(name: string): Policy {
	return {
		path: `/liminal-space/api/owner/${name}`,
		methods: ["POST"],
		allow: "POST",
		noToken: FORBIDDEN,
		takes: ["owner"],
		needsLiminal: ["POST"],
		needsOrigin: ["POST"],
	};
}

// An owner read route: GET from the owner's browser, with no same-site check.
function ownerRead(name: string): Policy {
	return {
		path: `/liminal-space/api/owner/${name}`,
		methods: ["GET"],
		allow: "GET",
		noToken: FORBIDDEN,
		takes: ["owner"],
		needsLiminal: [],
		needsOrigin: [],
	};
}

// The 14 routes as the Worker answers them today.
const POLICIES: Policy[] = [
	postFrom("/liminal-space/api/sync/push", "sync", FORBIDDEN),
	{
		path: "/liminal-space/api/sync/requests",
		methods: ["GET", "POST"],
		allow: "GET, POST",
		noToken: FORBIDDEN,
		takes: ["sync"],
		needsLiminal: [],
		needsOrigin: [],
	},
	postFrom("/liminal-space/api/sync/logs", "sync", FORBIDDEN),
	postFrom("/liminal-space/api/sync/study", "sync", FORBIDDEN),
	postFrom("/liminal-space/mcp", "connector", UNAUTHORIZED),
	ownerRead("state"),
	ownerRead("logs"),
	ownerChange("takeaways"),
	ownerChange("read"),
	ownerChange("tags"),
	ownerChange("feedback"),
	ownerChange("standouts"),
	ownerChange("comments"),
	ownerChange("ask"),
	{
		path: "/liminal-space/api/owner/push",
		methods: ["GET", "POST"],
		allow: "GET, POST",
		noToken: FORBIDDEN,
		takes: ["owner"],
		needsLiminal: ["POST"],
		needsOrigin: ["POST"],
	},
];

let cloud: Cloud;
let server: http.Server;

beforeAll(async () => {
	const started = await startCloud();
	cloud = started.cloud;
	server = started.server;
	await startWorker(cloud);
});

afterAll(async () => {
	await stopCloud(cloud, server);
});

// The headers a caller's token travels in: the owner's browser sends its login twice, the others once.
async function tokenHeaders(caller: Caller): Promise<Record<string, string>> {
	if (caller === "owner") {
		return browserHeaders(await ownerToken(cloud));
	}
	if (caller === "connector") {
		return { "Cf-Access-Jwt-Assertion": await connectorToken(cloud) };
	}
	return {
		"Cf-Access-Jwt-Assertion": await signToken(
			firstKey(cloud),
			syncClaims(cloud),
		),
	};
}

// What one request was answered: its status, Allow and WWW-Authenticate headers, body, and the log line's reason.
type Probe = {
	status: number;
	allow: string | null;
	wwwAuthenticate: string | null;
	body: string;
	reason: string | undefined;
};

// Send one request to the Worker, with a JSON body "{}" on a method that may carry one.
async function probe(
	path: string,
	method: string,
	headers: Record<string, string>,
): Promise<Probe> {
	if (cloud.workerUrl === null) {
		throw new Error("the Worker has no URL");
	}
	const init: RequestInit = {
		method: method,
		headers: { "Content-Type": "application/json", ...headers },
	};
	if (method !== "GET" && method !== "HEAD") {
		init.body = "{}";
	}
	const logsBefore = requestLogs(cloud).length;
	const answer = await fetch(cloud.workerUrl + path, init);
	const body = await answer.text();
	const line = requestLogs(cloud).slice(logsBefore)[0];
	let reason: string | undefined;
	if (line !== undefined) {
		reason = line.reason;
	}
	return {
		status: answer.status,
		allow: answer.headers.get("allow"),
		wwwAuthenticate: answer.headers.get("www-authenticate"),
		body: body,
		reason: reason,
	};
}

// Whether the token check refused a request: 401 or 403, unless the 403 is the same-site check that runs after it.
function tokenRefused(answer: Probe): boolean {
	if (answer.status === 401) {
		return true;
	}
	return answer.status === 403 && answer.reason !== NO_LIMINAL_REASON;
}

// A route's policy, read from its answers one request at a time, since each probe reads its own log line.
async function policyOf(path: string): Promise<Policy> {
	const policy: Policy = {
		path: path,
		methods: [],
		allow: null,
		noToken: "",
		takes: [],
		needsLiminal: [],
		needsOrigin: [],
	};
	// Which methods the route takes: every other one answers 405 with Allow before any token is checked.
	for (const method of METHODS) {
		const answer = await probe(path, method, {});
		if (answer.status === 405) {
			policy.allow = answer.allow;
			continue;
		}
		policy.methods.push(method);
		let refusal = `${answer.status} ${answer.body}`;
		if (answer.wwwAuthenticate !== null) {
			refusal += `, ${answer.wwwAuthenticate}`;
		}
		policy.noToken = refusal;
	}
	// Whose token it takes, on every method it takes, with no same-site headers.
	for (const caller of CALLERS) {
		let takes = true;
		for (const method of policy.methods) {
			const answer = await probe(path, method, await tokenHeaders(caller));
			if (tokenRefused(answer)) {
				takes = false;
			}
		}
		if (takes) {
			policy.takes.push(caller);
		}
	}
	// Which methods refuse a taken token without X-Liminal, or with another site's Origin.
	const caller = policy.takes[0];
	if (caller === undefined) {
		return policy;
	}
	for (const method of policy.methods) {
		const token = await tokenHeaders(caller);
		const noLiminal = await probe(path, method, {
			...token,
			Origin: SITE_ORIGIN,
		});
		if (noLiminal.status === 403 && noLiminal.reason === NO_LIMINAL_REASON) {
			policy.needsLiminal.push(method);
		}
		const otherOrigin = await probe(path, method, {
			...token,
			...SAME_SITE,
			Origin: "https://example.com",
		});
		if (
			otherOrigin.status === 403 &&
			otherOrigin.reason === WRONG_ORIGIN_REASON
		) {
			policy.needsOrigin.push(method);
		}
	}
	return policy;
}

test("each of the 14 routes answers with the methods, the caller's token and the owner POST headers listed for it", async () => {
	const policies: Policy[] = [];
	for (const each of POLICIES) {
		policies.push(await policyOf(each.path));
	}
	assert.deepEqual(policies, POLICIES);
});

test("the listed routes are every route the Worker has, so a new route can't go unchecked", async () => {
	const index = await workerModule<{ WORKER_PATHS: string[] }>("index.ts");
	assert.deepEqual(
		POLICIES.map((each) => each.path),
		index.WORKER_PATHS,
	);
});
