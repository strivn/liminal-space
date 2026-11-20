// Unit tests for scripts/lib/http.ts, against servers on 127.0.0.1 only.
import assert from "node:assert/strict";
import { afterEach, expect, test, vi } from "vitest";
import CONSTANTS from "../../scripts/lib/constants.json" with { type: "json" };
import { request } from "../../scripts/lib/http.ts";
import { closeServers, serve, serveUnlisted } from "./local-server.ts";

afterEach(closeServers);

// What `request` gave, as an answer; fails the test when it was a failure.
function answerOf(result: Awaited<ReturnType<typeof request>>) {
	if ("problem" in result) {
		throw new Error(`expected an answer, got: ${result.problem}`);
	}
	return result;
}

test("a 200 carries its status, headers, bytes and text", async () => {
	const base = await serve((_in, out) => {
		out.writeHead(200, { "x-demo": "yes", "content-type": "text/plain" });
		out.end("héllo");
	});
	const answer = answerOf(await request(`${base}/page`));
	expect(answer.url).toBe(`${base}/page`);
	expect(answer.status).toBe(200);
	expect(answer.ok).toBe(true);
	expect(answer.headers.get("x-demo")).toBe("yes");
	expect(answer.bytes).toEqual(Buffer.from("héllo"));
	expect(answer.text()).toBe("héllo");
});

test("text() drops a leading UTF-8 byte order mark, as Response.text() does", async () => {
	const base = await serve((_in, out) => {
		out.end(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("x")]));
	});
	const answer = answerOf(await request(base));
	expect(answer.bytes.length).toBe(4);
	expect(answer.text()).toBe("x");
});

test("an HTTP 503 is an answer with ok false", async () => {
	const base = await serve((_in, out) => {
		out.writeHead(503);
		out.end("busy");
	});
	const answer = answerOf(await request(base));
	expect(answer.status).toBe(503);
	expect(answer.ok).toBe(false);
	expect(answer.text()).toBe("busy");
});

test("finalUrl is the address after redirects", async () => {
	const base = await serve((incoming, out) => {
		if (incoming.url === "/old") {
			out.writeHead(302, { location: "/new" });
			out.end();
			return;
		}
		out.end("moved here");
	});
	const answer = answerOf(await request(`${base}/old`));
	expect(answer.url).toBe(`${base}/old`);
	expect(answer.finalUrl).toBe(`${base}/new`);
	expect(answer.text()).toBe("moved here");
});

test("limit: no answer within timeoutMs is a failure that gives the wait in seconds", async () => {
	const base = await serve(() => {
		// never answers
	});
	const result = await request(base, { timeoutMs: 100 });
	assert.ok("problem" in result);
	expect(result.url).toBe(base);
	expect(result.problem).toBe("gave no answer within 0.1 seconds");
});

test("a connection dropped mid-body is a failure", async () => {
	const base = await serve((_in, out) => {
		out.writeHead(200, { "content-length": "100" });
		out.write("only a start");
		setTimeout(() => out.destroy(), 20);
	});
	const result = await request(base);
	assert.ok("problem" in result);
	expect(result.problem).toMatch(/^could not be reached \(/);
});

test("a request sends the user agent from constants.json unless it is given another one or null", async () => {
	const base = await serve((incoming, out) => {
		out.end(String(incoming.headers["user-agent"]));
	});
	const byDefault = answerOf(await request(base));
	expect(byDefault.text()).toBe(CONSTANTS.userAgent);
	const named = answerOf(await request(base, { userAgent: "a-test/1" }));
	expect(named.text()).toBe("a-test/1");
	const none = answerOf(await request(base, { userAgent: null }));
	expect(none.text()).not.toBe(CONSTANTS.userAgent);
});

test("redirect manual returns the 3xx with its Location", async () => {
	const base = await serve((_in, out) => {
		out.writeHead(302, { location: "/elsewhere" });
		out.end();
	});
	const answer = answerOf(await request(base, { redirect: "manual" }));
	expect(answer.status).toBe(302);
	expect(answer.headers.get("location")).toBe("/elsewhere");
});

test("a POST sends its method, headers and body", async () => {
	const base = await serve((incoming, out) => {
		const parts: Buffer[] = [];
		incoming.on("data", (part: Buffer) => parts.push(part));
		incoming.on("end", () => {
			out.end(
				JSON.stringify({
					method: incoming.method,
					type: incoming.headers["content-type"],
					body: Buffer.concat(parts).toString(),
				}),
			);
		});
	});
	const answer = answerOf(
		await request(base, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: '{"a":1}',
		}),
	);
	expect(JSON.parse(answer.text())).toEqual({
		method: "POST",
		type: "application/json",
		body: '{"a":1}',
	});
});

test("a refused connection is a failure, not a thrown error", async () => {
	const base = await serve((_in, out) => out.end());
	await closeServers();
	const result = await request(base);
	assert.ok("problem" in result);
	expect(result.problem).toBe("could not be reached (ECONNREFUSED)");
});

test("a redirect to a private address is refused", async () => {
	let reached = 0;
	const unlisted = await serveUnlisted((_in, out) => {
		reached += 1;
		out.end("secret");
	});
	const targets = [
		{ target: `${unlisted}/admin`, host: "127.0.0.1" },
		{
			target: "http://169.254.169.254/latest/meta-data/",
			host: "169.254.169.254",
		},
		{ target: "http://[::1]:9/", host: "::1" },
	];
	for (const { target, host } of targets) {
		const base = await serve((_in, out) => {
			out.writeHead(302, { location: target });
			out.end();
		});
		const result = await request(`${base}/start`);
		assert.ok("problem" in result, target);
		expect(result.problem).toBe(
			`was refused: "${host}" is not on the public internet`,
		);
	}
	expect(reached).toBe(0);
});

test("a redirect to an address that is not http or https is refused", async () => {
	const base = await serve((_in, out) => {
		out.writeHead(302, { location: "ftp://example.com/file" });
		out.end();
	});
	const result = await request(base);
	assert.ok("problem" in result);
	expect(result.problem).toBe(
		'was refused: "ftp://example.com/file" is not http or https',
	);
});

test("a redirect to another origin sends on only the user agent and accept headers, and no body", async () => {
	const sent = {
		authorization: "Bearer secret",
		"x-api-key": "secret",
		"cf-access-client-id": "secret",
		accept: "application/json",
	};
	const echo = await serve((incoming, out) => {
		const parts: Buffer[] = [];
		incoming.on("data", (part: Buffer) => parts.push(part));
		incoming.on("end", () => {
			out.end(
				JSON.stringify({
					headers: Object.keys(incoming.headers).sort(),
					body: Buffer.concat(parts).toString(),
				}),
			);
		});
	});
	const sameOrigin = await serve((incoming, out) => {
		if (incoming.url === "/start") {
			out.writeHead(307, { location: "/echo" });
			out.end();
			return;
		}
		out.end(JSON.stringify({ headers: Object.keys(incoming.headers).sort() }));
	});
	const options = { method: "POST", headers: sent, body: "private" };
	const crossing = await serve((_in, out) => {
		out.writeHead(307, { location: `${echo}/echo` });
		out.end();
	});
	const crossed = JSON.parse(answerOf(await request(crossing, options)).text());
	expect(crossed.headers).toContain("user-agent");
	expect(crossed.headers).toContain("accept");
	for (const name of Object.keys(sent)) {
		if (name !== "accept") {
			expect(crossed.headers).not.toContain(name);
		}
	}
	expect(crossed.body).toBe("");
	const same = JSON.parse(
		answerOf(await request(`${sameOrigin}/start`, options)).text(),
	);
	expect(same.headers).toContain("x-api-key");
});

test("a chain of more than 5 redirects is a failure", async () => {
	const base = await serve((incoming, out) => {
		const step = Number(incoming.url?.slice(1));
		out.writeHead(302, { location: `/${step + 1}` });
		out.end();
	});
	const result = await request(`${base}/0`);
	assert.ok("problem" in result);
	expect(result.problem).toBe("was sent through more than 5 redirects");
});

test("a request to a private address is refused before any connection", async () => {
	let reached = 0;
	const unlisted = await serveUnlisted((_in, out) => {
		reached += 1;
		out.end("secret");
	});
	const result = await request(unlisted);
	assert.ok("problem" in result);
	expect(result.problem).toBe(
		'was refused: "127.0.0.1" is not on the public internet',
	);
	expect(reached).toBe(0);
});

test("a body over the cap is cut off", async () => {
	const cap = 10_000;
	let sentAll = false;
	let closed = false;
	const base = await serve((_in, out) => {
		out.writeHead(200, { "content-type": "text/plain" });
		out.on("close", () => {
			closed = true;
		});
		let sent = 0;
		const pump = () => {
			while (sent < 50_000_000 && !closed) {
				sent += 5000;
				if (!out.write("x".repeat(5000))) {
					out.once("drain", pump);
					return;
				}
			}
			if (!closed) {
				sentAll = true;
				out.end();
			}
		};
		pump();
	});
	const result = await request(base, { maxBytes: cap });
	assert.ok("problem" in result);
	expect(result.problem).toBe(`sent more than ${cap} bytes`);
	await vi.waitFor(() => expect(closed).toBe(true));
	expect(sentAll).toBe(false);
});

test("a body that declares a length over the cap is refused without being read", async () => {
	const base = await serve((_in, out) => {
		out.writeHead(200, { "content-length": "5000" });
		out.end("x".repeat(5000));
	});
	const result = await request(base, { maxBytes: 4999 });
	assert.ok("problem" in result);
	expect(result.problem).toBe("sent more than 4999 bytes");
	const atCap = answerOf(await request(base, { maxBytes: 5000 }));
	expect(atCap.bytes.length).toBe(5000);
});
