// scripts/lib/http.ts connects to the address its guard checked, never to a second DNS answer.
import { afterEach, expect, test, vi } from "vitest";
import { closeServers, serveUnlisted } from "./local-server.ts";

// The guard's lookup sees "localhost" as a public address; the system resolver still says 127.0.0.1.
vi.mock("node:dns/promises", async (original) => {
	const actual = await original<typeof import("node:dns/promises")>();
	return {
		...actual,
		lookup: async (host: string, options: object) => {
			if (host === "localhost") {
				return [{ address: "203.0.113.7", family: 4 }];
			}
			return actual.lookup(host, options);
		},
	};
});

const { request } = await import("../../scripts/lib/http.ts");

afterEach(closeServers);

test("security: a name that resolves to a local address after the check is never connected to", async () => {
	let reached = 0;
	const local = await serveUnlisted((_in, out) => {
		reached += 1;
		out.end("secret");
	});
	const port = new URL(local).port;
	const result = await request(`http://localhost:${port}/`, {
		timeoutMs: 1000,
	});
	expect("problem" in result).toBe(true);
	expect(reached).toBe(0);
});
