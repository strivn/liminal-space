// Unit tests for the exports of scripts/scout/web/describe.ts: pageDescription(html) and pageDescriptions(html) on small
// hand-written pages, summaryText(text) on hand-written summaries, and fetchPage and readPageBody against http servers
// on 127.0.0.1.

import assert from "node:assert/strict";
import type {
	IncomingHttpHeaders,
	IncomingMessage,
	ServerResponse,
} from "node:http";
import http from "node:http";
import type { Readable } from "node:stream";
import { test } from "vitest";
import CONSTANTS from "../../scripts/lib/constants.json" with { type: "json" };
import type * as Describe from "../../scripts/scout/web/describe.ts";

const SCRIPT = new URL("../../scripts/scout/web/describe.ts", import.meta.url);

// A whole page with `headTags` in its head, among tags that are not descriptions.
function page(headTags: string) {
	return [
		"<!doctype html>",
		'<html lang="en">',
		"<head>",
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		"<title>Fixture page</title>",
		'<meta property="og:title" content="Fixture page">',
		headTags,
		"</head>",
		"<body><p>Body text, which is not the description.</p></body>",
		"</html>",
	].join("\n");
}

// The first description a page holds, usable or not: what the tests of reading the tags check.
async function firstDescription(html: string) {
	const { pageDescriptions }: typeof Describe = await import(SCRIPT.href);
	return pageDescriptions(html)[0] || null;
}

// og:description alone is returned as written.
test("The publisher's og:description is copied", async () => {
	const { pageDescription }: typeof Describe = await import(SCRIPT.href);
	const html = page(
		'<meta property="og:description" content="Forty ocean buoys now report Java Sea temperatures every ten minutes.">',
	);
	assert.equal(
		pageDescription(html),
		"Forty ocean buoys now report Java Sea temperatures every ten minutes.",
	);
});

// With no og:description, the meta description is returned.
test("Without og:description, the meta description is copied", async () => {
	const { pageDescription }: typeof Describe = await import(SCRIPT.href);
	const html = page(
		'<meta name="description" content="Buoys cut the rainfall outlook error by a third.">',
	);
	assert.equal(
		pageDescription(html),
		"Buoys cut the rainfall outlook error by a third.",
	);
});

// "A description too short to say anything is not copied": the first usable one wins, else null.
test("A description too short to say anything gives way to the meta description", async () => {
	const { pageDescription }: typeof Describe = await import(SCRIPT.href);
	const html = page(
		'<meta property="og:description" content="Linkpost to arXiv: https://arxiv.org/abs/2610.02557">\n<meta name="description" content="Buoys cut the rainfall outlook error by a third this year.">',
	);
	assert.equal(
		pageDescription(html),
		"Buoys cut the rainfall outlook error by a third this year.",
	);
});

test("A page whose descriptions are all too short gives null", async () => {
	const { pageDescription }: typeof Describe = await import(SCRIPT.href);
	const html = page(
		'<meta property="og:description" content="Introduction">\n<meta name="description" content="Introduction">',
	);
	assert.equal(pageDescription(html), null);
});

test("A usable og:description still wins over a usable meta description", async () => {
	const { pageDescription }: typeof Describe = await import(SCRIPT.href);
	const html = page(
		'<meta name="description" content="Buoys cut the rainfall outlook error by a third this year.">\n<meta property="og:description" content="Forty ocean buoys now report Java Sea temperatures every ten minutes.">',
	);
	assert.equal(
		pageDescription(html),
		"Forty ocean buoys now report Java Sea temperatures every ten minutes.",
	);
});

test("pageDescriptions lists og:description first, then the meta description", async () => {
	const { pageDescriptions }: typeof Describe = await import(SCRIPT.href);
	const html = page(
		'<meta name="description" content="From the meta tag.">\n<meta property="og:description" content="From the og tag.">',
	);
	assert.deepEqual(pageDescriptions(html), [
		"From the og tag.",
		"From the meta tag.",
	]);
});

// og:description wins whichever tag comes first in the head.
test("og:description wins over the meta description whichever comes first in the head", async () => {
	const ogFirst = page(
		'<meta property="og:description" content="From the og tag.">\n<meta name="description" content="From the meta tag.">',
	);
	const metaFirst = page(
		'<meta name="description" content="From the meta tag.">\n<meta property="og:description" content="From the og tag.">',
	);
	assert.equal(await firstDescription(ogFirst), "From the og tag.");
	assert.equal(await firstDescription(metaFirst), "From the og tag.");
});

// "Empty" means empty after trimming, so whitespace-only content falls back too.
test("An empty og:description falls back to the meta description", async () => {
	const empty = page(
		'<meta property="og:description" content="">\n<meta name="description" content="From the meta tag.">',
	);
	const blank = page(
		'<meta property="og:description" content="   \n ">\n<meta name="description" content="From the meta tag.">',
	);
	assert.equal(await firstDescription(empty), "From the meta tag.");
	assert.equal(await firstDescription(blank), "From the meta tag.");
});

// The feature's example: named and hex entities, a run of spaces and a line break.
test("Entities are decoded and whitespace collapsed", async () => {
	const html = page(
		'<meta property="og:description" content="Asked &quot;Which theory?&quot; they&#x27;re   consistent &amp;\n firm">',
	);
	assert.equal(
		await firstDescription(html),
		'Asked "Which theory?" they\'re consistent & firm',
	);
});

// Each entity the contract names, plus decimal and hex numeric references beyond ASCII.
test("The basic named entities and decimal and hex character references are decoded", async () => {
	const cases = [
		["&quot;", '"'],
		["&#x27;", "'"],
		["&#39;", "'"],
		["&apos;", "'"],
		["&amp;", "&"],
		["&lt;", "<"],
		["&gt;", ">"],
		["&#8212;", "—"],
		["&#x2014;", "—"],
		["&#X2014;", "—"],
	];
	for (const [entity, character] of cases) {
		const html = page(
			`<meta property="og:description" content="a ${entity} b">`,
		);
		assert.equal(
			await firstDescription(html),
			`a ${character} b`,
			`decoding ${entity}`,
		);
	}
});

// Decoding happens once: "&amp;lt;" is the text "&lt;", not "<".
test("Entities are decoded once, not twice", async () => {
	const html = page(
		'<meta property="og:description" content="Write &amp;lt;p&amp;gt; and &amp;amp;">',
	);
	assert.equal(await firstDescription(html), "Write &lt;p&gt; and &amp;");
});

// A page that escaped its text twice, as ANTARA News does: a reference left after one pass is decoded again, unless it
// stands for "<", ">" or "&", which the test above keeps as written.
test("Text escaped twice is decoded again, except references for <, > and &", async () => {
	const html = page(
		'<meta property="og:description" content="Indonesia&amp;#39;s and Indonesia&amp;rsquo;s &amp;quot;AI&amp;quot; plan &amp;#38; &amp;#60;b&amp;#62;">',
	);
	assert.equal(
		await firstDescription(html),
		'Indonesia\'s and Indonesia’s "AI" plan &#38; &#60;b&#62;',
	);
});

// Tabs, line breaks and runs of spaces become one space; the ends are trimmed.
test("Whitespace is collapsed and trimmed", async () => {
	const html = page(
		'<meta name="description" content="\n\t  One\t\ttwo \n\n three  ">',
	);
	assert.equal(await firstDescription(html), "One two three");
});

// Attribute order, quote style, letter case, extra attributes and a self-closing slash don't matter.
test("Attribute order, quote style, letter case, extra attributes and a closing slash don't change the description", async () => {
	const tags = [
		'<meta property="og:description" content="Same text.">',
		'<meta content="Same text." property="og:description">',
		"<meta property='og:description' content='Same text.'>",
		'<META PROPERTY="og:description" CONTENT="Same text.">',
		'<meta data-rh="true" property="og:description" content="Same text." />',
		'<meta content="Same text." name="description">',
		"<meta name='description' content='Same text.'>",
		'<META NAME="description" CONTENT="Same text.">',
	];
	for (const tag of tags) {
		assert.equal(await firstDescription(page(tag)), "Same text.", tag);
	}
});

// Quotes of the other kind inside the attribute value are part of the text.
test("A quote of the other kind inside the content is kept", async () => {
	assert.equal(
		await firstDescription(
			page(`<meta property="og:description" content="They're here.">`),
		),
		"They're here.",
	);
	assert.equal(
		await firstDescription(
			page(`<meta property='og:description' content='Say "yes".'>`),
		),
		'Say "yes".',
	);
});

// Neither tag with content: null, not "" or undefined.
test("A page without a description gives null", async () => {
	assert.equal(await firstDescription(page("")), null);
	assert.equal(
		await firstDescription(page('<meta property="og:description" content="">')),
		null,
	);
	assert.equal(
		await firstDescription(page('<meta name="description" content="  ">')),
		null,
	);
	assert.equal(
		await firstDescription(
			page(
				'<meta property="og:description" content="">\n<meta name="description" content="">',
			),
		),
		null,
	);
});

// Named entities beyond the basic five, from the HTML spec's full table; &nbsp; is U+00A0, which collapses to a space.
test("Named entities are decoded", async () => {
	const named = page(
		'<meta property="og:description" content="A user&rsquo;s view &mdash; it&rsquo;s here&hellip;">',
	);
	const nbsp = page(
		'<meta property="og:description" content="One&nbsp;two &nbsp; three">',
	);
	assert.equal(await firstDescription(named), "A user’s view — it’s here…");
	assert.equal(await firstDescription(nbsp), "One two three");
});

// A code point past U+10FFFF becomes U+FFFD, as the HTML spec says, instead of throwing.
test("A character reference past the last Unicode code point becomes the replacement character", async () => {
	const html = page(
		'<meta property="og:description" content="Bad &#x110000; reference">',
	);
	assert.equal(await firstDescription(html), "Bad � reference");
});

// Attribute values without quotes are read up to the next space or ">".
test("An unquoted content value is read", async () => {
	assert.equal(
		await firstDescription(page("<meta name=description content=Unquoted>")),
		"Unquoted",
	);
	assert.equal(
		await firstDescription(
			page("<meta property=og:description content=Unquoted>"),
		),
		"Unquoted",
	);
});

// In an attribute, a reference without ";" followed by "=" or a letter or digit stays as written (HTML spec).
test('A semicolon-less reference before "=" stays as written in an attribute', async () => {
	const html = page('<meta property="og:description" content="AT&T &copy=x">');
	assert.equal(await firstDescription(html), "AT&T &copy=x");
});

// "A page in another character set": once the bytes are decoded, the description comes back with its accents, dashes
// and curly quotes as written.
test("A page in another character set: non-ASCII text comes back as written", async () => {
	const html = page(
		'<meta property="og:description" content="Café crème — l’été, naïve">',
	);
	assert.equal(await firstDescription(html), "Café crème — l’été, naïve");
});

// "A page in another character set" declares it with tags that also have a content attribute; neither is a description.
test("A page in another character set: the charset tags are not descriptions", async () => {
	const httpEquiv =
		'<meta http-equiv="Content-Type" content="text/html; charset=windows-1252">';
	const charset = '<meta charset="windows-1252">';
	assert.equal(await firstDescription(page(`${httpEquiv}\n${charset}`)), null);
	assert.equal(
		await firstDescription(
			page(
				`${httpEquiv}\n<meta property="og:description" content="Same text.">`,
			),
		),
		"Same text.",
	);
	assert.equal(
		await firstDescription(
			page(`${httpEquiv}\n<meta name="description" content="Same text.">`),
		),
		"Same text.",
	);
});

// summaryText(text): the description describe.ts --summary writes for the scout's own summary, or null when empty.

test("A summary gets the [AI Summarized] label in front", async () => {
	const { summaryText }: typeof Describe = await import(SCRIPT.href);
	assert.equal(
		summaryText("The council voted to fund forty buoys."),
		"[AI Summarized] The council voted to fund forty buoys.",
	);
});

test("A summary that already carries the label isn't labelled twice", async () => {
	const { summaryText }: typeof Describe = await import(SCRIPT.href);
	assert.equal(
		summaryText("[AI Summarized] Forty buoys."),
		"[AI Summarized] Forty buoys.",
	);
});

test("Line breaks and runs of spaces in a summary become single spaces", async () => {
	const { summaryText }: typeof Describe = await import(SCRIPT.href);
	const spaced =
		"Forty buoys now report\nJava Sea temperatures   every ten minutes.";
	assert.equal(
		summaryText(spaced),
		"[AI Summarized] Forty buoys now report Java Sea temperatures every ten minutes.",
	);
});

// Every kind of whitespace run counts, Windows line breaks and tabs included.
test("Tabs and Windows line breaks in a summary become single spaces", async () => {
	const { summaryText }: typeof Describe = await import(SCRIPT.href);
	assert.equal(
		summaryText("One\r\ntwo\t\tthree"),
		"[AI Summarized] One two three",
	);
});

test("Whitespace at the ends of a summary is trimmed", async () => {
	const { summaryText }: typeof Describe = await import(SCRIPT.href);
	assert.equal(summaryText("  \n Kept. \n"), "[AI Summarized] Kept.");
});

// The contract collapses whitespace first, then checks for the label, so a label followed by a line break counts.
test("The label is recognised after whitespace is collapsed", async () => {
	const { summaryText }: typeof Describe = await import(SCRIPT.href);
	assert.equal(
		summaryText(" [AI Summarized]\n  Forty buoys."),
		"[AI Summarized] Forty buoys.",
	);
});

// "Unless it already starts with exactly that": another spelling of the label is text, and gets the label in front.
test("Only the exact label counts as the label", async () => {
	const { summaryText }: typeof Describe = await import(SCRIPT.href);
	assert.equal(
		summaryText("[ai summarized] Forty buoys."),
		"[AI Summarized] [ai summarized] Forty buoys.",
	);
});

// Empty after collapsing and trimming: null, not "" and not the label alone.
test("An empty summary gives null", async () => {
	const { summaryText }: typeof Describe = await import(SCRIPT.href);
	assert.equal(summaryText(""), null);
	assert.equal(summaryText("   \n\t  "), null);
});

// fetchPage(address, checked, signal) and readPageBody(response): one hop of a page fetch, pinned to the address
// publicAddress checked, and its body read up to 2 MB ("The page is fetched at the address checked, over http or
// https, up to 2 MB", 2026-11-05). Each test serves its page from its own http server on 127.0.0.1 and closes it.

// The largest page read whole, as describe.ts has it.
const MAX_PAGE_BYTES = 2 * 1024 * 1024;

// What one test's server saw and does: the request headers in arrival order, and how to stop it (its connections too).
type Served = {
	port: number;
	headers: IncomingHttpHeaders[];
	close: () => Promise<void>;
};

// Serve requests on 127.0.0.1 at a free port with `answer`, which writes the whole response (or holds it open).
async function serve(
	answer: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<Served> {
	const headers: IncomingHttpHeaders[] = [];
	const server = http.createServer((request, response) => {
		headers.push(request.headers);
		answer(request, response);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("the server has no port");
	}
	return {
		port: address.port,
		headers: headers,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

// The page the small answers serve.
const SMALL_PAGE = page(
	'<meta property="og:description" content="Forty ocean buoys now report Java Sea temperatures every ten minutes.">',
);

// Serve one small page at every path.
function servePage(): Promise<Served> {
	return serve((_request, response) => {
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		response.end(SMALL_PAGE);
	});
}

// `promise`, or a failure after `ms`: a fetch or a read that hangs fails on its own, with its name, instead of waiting
// out vitest's limit.
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`${what} took longer than ${ms} ms`)),
			ms,
		);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

// Every byte a body stream yields, once it ends.
async function bytesOf(body: Readable): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of body) {
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}

// The one request a server got; fails on none or several.
function onlyRequest(served: Served): IncomingHttpHeaders {
	assert.equal(served.headers.length, 1, "requests the server got");
	const headers = served.headers[0];
	if (headers === undefined) {
		throw new Error("no request");
	}
	return headers;
}

// The pin: pinned.test resolves nowhere (.test is reserved, RFC 6761), so the page arrives only through the address
// given, and the server sees the URL's host, not the address, as Host.
test("security: fetchPage connects to the address that passed the public-internet check and sends the URL's host name", async () => {
	const { fetchPage }: typeof Describe = await import(SCRIPT.href);
	const served = await servePage();
	try {
		const answer = await within(
			fetchPage(
				`http://pinned.test:${served.port}/page`,
				{ address: "127.0.0.1", port: String(served.port) },
				AbortSignal.timeout(5000),
			),
			5000,
			"fetchPage",
		);
		assert.equal(answer.status, 200);
		assert.equal(onlyRequest(served).host, `pinned.test:${served.port}`);
		assert.equal(
			(await within(bytesOf(answer.body), 5000, "the body")).toString("utf8"),
			SMALL_PAGE,
		);
		answer.close();
	} finally {
		await served.close();
	}
});

// close() drops the connection, body unread: the body stream ends (closes) and the server's socket goes away.
test("fetchPage's close() ends the body and drops the connection", async () => {
	const { fetchPage }: typeof Describe = await import(SCRIPT.href);
	let socketClosed: Promise<void> | null = null;
	// Headers and the start of a body, which never ends: only close() can end this answer.
	const served = await serve((request, response) => {
		socketClosed = new Promise<void>((resolve) =>
			request.socket.once("close", () => resolve()),
		);
		response.writeHead(200, { "content-type": "text/html" });
		response.write("<!doctype html><html><head>");
	});
	try {
		const answer = await within(
			fetchPage(
				`http://pinned.test:${served.port}/held`,
				{ address: "127.0.0.1", port: String(served.port) },
				AbortSignal.timeout(5000),
			),
			5000,
			"fetchPage",
		);
		assert.equal(answer.status, 200);
		const bodyClosed = new Promise<void>((resolve) =>
			answer.body.once("close", () => resolve()),
		);
		answer.body.on("error", () => {
			// A dropped connection may surface as an error on the body too; the close is what counts.
		});
		answer.close();
		await within(bodyClosed, 5000, "the body's close");
		if (socketClosed === null) {
			throw new Error("the server got no request");
		}
		await within(socketClosed, 5000, "the server's socket close");
	} finally {
		await served.close();
	}
});

// A null `checked` (the local stand-in LIMINAL_ALLOW_LOCAL names) resolves the name as usual.
test("fetchPage with no checked address fetches the URL as given", async () => {
	const { fetchPage }: typeof Describe = await import(SCRIPT.href);
	const served = await servePage();
	try {
		const answer = await within(
			fetchPage(
				`http://127.0.0.1:${served.port}/page`,
				null,
				AbortSignal.timeout(5000),
			),
			5000,
			"fetchPage",
		);
		assert.equal(answer.status, 200);
		assert.equal(answer.headers["content-type"], "text/html; charset=utf-8");
		assert.equal(onlyRequest(served).host, `127.0.0.1:${served.port}`);
		assert.equal(
			(await within(bytesOf(answer.body), 5000, "the body")).toString("utf8"),
			SMALL_PAGE,
		);
		answer.close();
	} finally {
		await served.close();
	}
});

// The shared user agent (constants.json), and no Accept-Encoding, so the body arrives as it is.
test("fetchPage sends the shared user agent and no Accept-Encoding", async () => {
	const { fetchPage }: typeof Describe = await import(SCRIPT.href);
	const served = await servePage();
	try {
		const answer = await within(
			fetchPage(
				`http://127.0.0.1:${served.port}/page`,
				null,
				AbortSignal.timeout(5000),
			),
			5000,
			"fetchPage",
		);
		const headers = onlyRequest(served);
		assert.equal(headers["user-agent"], CONSTANTS.userAgent);
		assert.equal(headers["accept-encoding"], undefined);
		answer.close();
	} finally {
		await served.close();
	}
});

// The signal ends a request the server never answers.
test("limit: fetchPage's signal ends a request that gets no answer", async () => {
	const { fetchPage }: typeof Describe = await import(SCRIPT.href);
	const served = await serve(() => {
		// Never answered: the signal must end it.
	});
	try {
		// AbortError (http.request) or TimeoutError (fetch): either way the signal's own failure, not another's.
		await assert.rejects(
			within(
				fetchPage(
					`http://127.0.0.1:${served.port}/never`,
					null,
					AbortSignal.timeout(300),
				),
				5000,
				"fetchPage",
			),
			(error: unknown) =>
				error instanceof Error &&
				(error.name === "AbortError" || error.name === "TimeoutError"),
		);
	} finally {
		await served.close();
	}
});

// readPageBody: the whole body of a small answer.
test("readPageBody returns the whole body of a small page", async () => {
	const { fetchPage, readPageBody }: typeof Describe = await import(
		SCRIPT.href
	);
	const served = await servePage();
	try {
		const answer = await fetchPage(
			`http://127.0.0.1:${served.port}/page`,
			null,
			AbortSignal.timeout(5000),
		);
		const bytes = await within(readPageBody(answer), 5000, "readPageBody");
		assert.notEqual(bytes, null);
		assert.equal(bytes?.toString("utf8"), SMALL_PAGE);
	} finally {
		await served.close();
	}
});

// Exactly 2 MB is not larger than 2 MB: read whole.
test("security: readPageBody reads a page of exactly 2 MB", async () => {
	const { fetchPage, readPageBody }: typeof Describe = await import(
		SCRIPT.href
	);
	const body = Buffer.alloc(MAX_PAGE_BYTES, "x");
	const served = await serve((_request, response) => {
		response.writeHead(200, {
			"content-type": "text/html",
			"content-length": String(body.length),
		});
		response.end(body);
	});
	try {
		const answer = await fetchPage(
			`http://127.0.0.1:${served.port}/exact`,
			null,
			AbortSignal.timeout(5000),
		);
		const bytes = await within(readPageBody(answer), 10000, "readPageBody");
		assert.notEqual(bytes, null);
		assert.equal(bytes?.length, MAX_PAGE_BYTES);
	} finally {
		await served.close();
	}
});

// A Content-Length past the limit is refused on the headers alone: the server sends no body byte and never ends, so a
// read that waited for the body would hang past the guard.
test("security: readPageBody returns null for a Content-Length of 3 MB without reading the body, and closes the connection", async () => {
	const { fetchPage, readPageBody }: typeof Describe = await import(
		SCRIPT.href
	);
	let socketClosed: Promise<void> | null = null;
	const served = await serve((request, response) => {
		socketClosed = new Promise<void>((resolve) =>
			request.socket.once("close", () => resolve()),
		);
		response.writeHead(200, {
			"content-type": "text/html",
			"content-length": String(3 * 1024 * 1024),
		});
		response.flushHeaders();
	});
	try {
		const answer = await fetchPage(
			`http://127.0.0.1:${served.port}/declared`,
			null,
			AbortSignal.timeout(10000),
		);
		assert.equal(answer.headers["content-length"], String(3 * 1024 * 1024));
		const bytes = await within(readPageBody(answer), 3000, "readPageBody");
		assert.equal(bytes, null);
		// The connection is closed, not left for the server to end.
		if (socketClosed === null) {
			throw new Error("the server got no request");
		}
		await within(socketClosed, 5000, "the server's socket close");
	} finally {
		await served.close();
	}
});

// Without a Content-Length, the limit holds by the bytes that arrive: the server streams 3 MB in chunks and never ends,
// so only a read that stops past 2 MB returns.
test("security: readPageBody returns null once more than 2 MB arrive without a Content-Length", async () => {
	const { fetchPage, readPageBody }: typeof Describe = await import(
		SCRIPT.href
	);
	let socketClosed: Promise<void> | null = null;
	const chunk = Buffer.alloc(64 * 1024, "x");
	const served = await serve((request, response) => {
		socketClosed = new Promise<void>((resolve) =>
			request.socket.once("close", () => resolve()),
		);
		response.writeHead(200, { "content-type": "text/html" });
		for (let sent = 0; sent < 3 * 1024 * 1024; sent += chunk.length) {
			response.write(chunk);
		}
	});
	try {
		const answer = await fetchPage(
			`http://127.0.0.1:${served.port}/chunked`,
			null,
			AbortSignal.timeout(10000),
		);
		assert.equal(answer.headers["content-length"], undefined);
		const bytes = await within(readPageBody(answer), 10000, "readPageBody");
		assert.equal(bytes, null);
		if (socketClosed === null) {
			throw new Error("the server got no request");
		}
		await within(socketClosed, 5000, "the server's socket close");
	} finally {
		await served.close();
	}
});
