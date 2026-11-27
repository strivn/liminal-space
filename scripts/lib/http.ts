// One HTTP request for the programs that read public sites or call an API: no pacing, no retries, never throws.
// Public addresses only, each connection pinned to the checked one; bodies capped.
import { isIP } from "node:net";
import { Agent } from "undici";
import CONSTANTS from "./constants.json" with { type: "json" };
import { fetchProblem } from "./fetch-problem.ts";
import { FetchRefused, publicAddress } from "./public-address.ts";

const MAX_REDIRECTS = 5;
// Headers kept across origins.
const SHARED_HEADERS = ["user-agent", "accept"];

// An answer of any status; the body is read whole.
export type HttpAnswer = {
	url: string;
	finalUrl: string; // after any redirect
	status: number;
	ok: boolean;
	headers: Headers;
	bytes: Buffer;
	text(): string;
};

// No answer came; problem finishes "<source> ..." (fetchProblem's words) and error is what fetch rejected with.
export type HttpFailure = { url: string; problem: string; error: unknown };

export type HttpOptions = {
	method?: string;
	headers?: Record<string, string>;
	body?: string | null;
	timeoutMs?: number; // default: constants.json requestTimeoutMs
	maxBytes?: number; // default: maxBodyBytes
	userAgent?: string | null; // default: constants.json userAgent; null sends none
	redirect?: "follow" | "manual";
};

// Connects only to the checked address.
function pinnedTo(address: string): Agent {
	const family = isIP(address);
	return new Agent({
		connect: {
			lookup: (_host, options, callback) => {
				if (options.all) {
					callback(null, [{ address: address, family: family }]);
				} else {
					callback(null, address, family);
				}
			},
		},
	});
}

// Redirect target, or null.
function redirectTarget(response: Response, from: string): string | null {
	const location = response.headers.get("location");
	if (response.status < 300 || response.status >= 400 || location === null) {
		return null;
	}
	return new URL(location, from).href;
}

// The size limit of a conference's list or proceedings file, given its name with or without the year ("NeurIPS 2026").
export function sourceLimit(venue: string): number {
	const limits: Record<string, number> = CONSTANTS.sourceBytes;
	return limits[venue.replace(/\s+\d{4}$/, "")] ?? CONSTANTS.maxBodyBytes;
}

// The body, or null over the cap.
async function readBody(
	response: Response,
	maxBytes: number,
): Promise<Buffer | null> {
	if (Number(response.headers.get("content-length")) > maxBytes) {
		await response.body?.cancel();
		return null;
	}
	const parts: Buffer[] = [];
	let total = 0;
	if (response.body === null) {
		return Buffer.alloc(0);
	}
	for await (const part of response.body) {
		total += part.length;
		if (total > maxBytes) {
			return null;
		}
		parts.push(Buffer.from(part));
	}
	return Buffer.concat(parts);
}

// One request; an HTTP error status is an answer. The body is read inside the same try, so the time limit and a
// dropped connection cover it too.
export async function request(
	url: string,
	options: HttpOptions = {},
): Promise<HttpAnswer | HttpFailure> {
	let timeoutMs = CONSTANTS.requestTimeoutMs;
	if (options.timeoutMs !== undefined) {
		timeoutMs = options.timeoutMs;
	}
	let maxBytes = CONSTANTS.maxBodyBytes;
	if (options.maxBytes !== undefined) {
		maxBytes = options.maxBytes;
	}
	const headers: Record<string, string> = {};
	let userAgent: string | null = CONSTANTS.userAgent;
	if (options.userAgent !== undefined) {
		userAgent = options.userAgent;
	}
	if (userAgent !== null) {
		headers["user-agent"] = userAgent;
	}
	Object.assign(headers, options.headers);
	const init: RequestInit = {
		headers: headers,
		signal: AbortSignal.timeout(timeoutMs),
		redirect: "manual",
	};
	if (options.method !== undefined) {
		init.method = options.method;
	}
	if (options.body !== undefined) {
		init.body = options.body;
	}
	let address = url;
	const agents: Agent[] = [];
	try {
		for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
			const protocol = new URL(address).protocol;
			if (protocol !== "http:" && protocol !== "https:") {
				throw new FetchRefused(`"${address}" is not http or https`);
			}
			// biome-ignore lint/performance/noAwaitInLoops: each hop's address comes from the answer before it
			const checked = await publicAddress(address);
			const hop: RequestInit = { ...init };
			if (checked !== null) {
				const agent = pinnedTo(checked.address);
				agents.push(agent);
				// Node's fetch takes undici's dispatcher
				Object.assign(hop, { dispatcher: agent });
			}
			const response = await fetch(address, hop);
			const next = redirectTarget(response, address);
			if (options.redirect === "manual" || next === null) {
				const bytes = await readBody(response, maxBytes);
				if (bytes === null) {
					return {
						url: url,
						problem: `sent more than ${maxBytes} bytes`,
						error: new Error(`body over ${maxBytes} bytes`),
					};
				}
				return {
					url: url,
					finalUrl: address,
					status: response.status,
					ok: response.ok,
					headers: response.headers,
					bytes: bytes,
					text: () => new TextDecoder().decode(bytes),
				};
			}
			await response.body?.cancel();
			const leavesOrigin = new URL(next).origin !== new URL(address).origin;
			if (leavesOrigin) {
				for (const name of Object.keys(headers)) {
					if (!SHARED_HEADERS.includes(name.toLowerCase())) {
						delete headers[name];
					}
				}
			}
			// These hops become bodiless GETs.
			if (
				leavesOrigin ||
				response.status === 303 ||
				((response.status === 301 || response.status === 302) &&
					init.method === "POST")
			) {
				init.method = "GET";
				delete init.body;
			}
			address = next;
		}
		return {
			url: url,
			problem: `was sent through more than ${MAX_REDIRECTS} redirects`,
			error: new Error(`more than ${MAX_REDIRECTS} redirects`),
		};
	} catch (error) {
		if (error instanceof FetchRefused) {
			return {
				url: url,
				problem: `was refused: ${error.message}`,
				error: error,
			};
		}
		return {
			url: url,
			problem: fetchProblem(error, timeoutMs),
			error: error,
		};
	} finally {
		await Promise.all(agents.map((agent) => agent.destroy()));
	}
}
