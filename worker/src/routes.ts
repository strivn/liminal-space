// The Worker's routing: a route table, and the checks every request passes in order before its handler runs.
import {
	checkConnectorToken,
	checkOwnerToken,
	checkSyncToken,
} from "./access.ts";
import type { Env, RequestLog } from "./env.ts";
import { refuse, refuseToken } from "./respond.ts";

type Method = "GET" | "POST";

export type Handler = (
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	log: RequestLog,
) => Promise<Response> | Response;

export type Route = {
	path: string;
	auth: "sync" | "owner" | "connector";
	methods: Partial<Record<Method, { handler: Handler }>>;
};

// The route's token check: null when it passed, else the refusal. A refused connector is 401, which tells it to sign in
// again; a refusal because Access's keys can't be fetched is 503 "try again" for every route.
async function refuseAccess(
	route: Route,
	request: Request,
	env: Env,
	log: RequestLog,
): Promise<Response | null> {
	if (route.auth === "connector") {
		const access = await checkConnectorToken(request, env);
		if (!access.ok && access.status === 503) {
			return refuseToken(log, 503, access.reason);
		}
		if (!access.ok) {
			return refuse(log, 401, "unauthorized", access.reason, {
				"WWW-Authenticate":
					'Bearer realm="liminal-space", error="invalid_token"',
			});
		}
		return null;
	}
	let check = checkSyncToken;
	if (route.auth === "owner") {
		check = checkOwnerToken;
	}
	const access = await check(request, env);
	if (!access.ok) {
		return refuseToken(log, access.status, access.reason);
	}
	return null;
}

// Answer a request through its route, checking in order: the exact path (404, so no token is checked for an unknown
// one), the method (405 with Allow), the route's token, then for every owner POST the header "X-Liminal: 1" and the
// site's Origin, which a form or script on another site can't both send. The handler runs only after all of them.
export async function dispatch(
	routes: Route[],
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	log: RequestLog,
): Promise<Response> {
	const route = routes.find((each) => each.path === log.path);
	if (route === undefined) {
		return refuse(log, 404, "not found", "no such route");
	}
	let entry: { handler: Handler } | undefined;
	if (request.method === "GET" || request.method === "POST") {
		entry = route.methods[request.method];
	}
	if (entry === undefined) {
		const methods = Object.keys(route.methods);
		return refuse(
			log,
			405,
			"method not allowed",
			`this route takes only ${methods.join(" and ")}`,
			{ Allow: methods.join(", ") },
		);
	}
	const refused = await refuseAccess(route, request, env, log);
	if (refused !== null) {
		return refused;
	}
	if (route.auth === "owner" && request.method === "POST") {
		if (request.headers.get("X-Liminal") !== "1") {
			return refuse(log, 403, "forbidden", 'no "X-Liminal: 1" header');
		}
		const origin = request.headers.get("Origin");
		if (!env.SITE_ORIGIN || origin !== env.SITE_ORIGIN) {
			return refuse(log, 403, "forbidden", "Origin is not the site's");
		}
	}
	return entry.handler(request, env, ctx, log);
}
