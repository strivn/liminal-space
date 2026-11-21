// Tests of scripts/scout/web/describe.ts run as the scout runs it: a digests file in a temp folder, pages on 127.0.0.1 stand-ins,
// the exit code and what it prints. Nothing here reaches another host.

import assert from "node:assert/strict";
import {
	chmodSync,
	readdirSync,
	readFileSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { afterAll, afterEach, test } from "vitest";
import { closeServers, serve } from "./local-server.ts";
import {
	digestText,
	entriesOfLine,
	removeTempFolders,
	runScript,
	scriptPath,
	tempFolder,
} from "./run-script.ts";

const DESCRIBE = scriptPath("scout/web/describe.ts");

afterEach(closeServers);
afterAll(removeTempFolders);

function head(tags: string): string {
	return `<!doctype html><html><head><meta charset="utf-8">${tags}</head><body>Body.</body></html>`;
}

function og(text: string): string {
	return head(`<meta property="og:description" content="${text}">`);
}

// A news, article or report entry for a page address.
function item(type: string, url: string, extra: Record<string, unknown> = {}) {
	return {
		id: `url:${url}`,
		type: type,
		title: `Story at ${url}`,
		authors: ["Ada Example"],
		published: "2026-10-04",
		source: "Fixture Times",
		url: url,
		links: [],
		...extra,
	};
}

function paperEntry(url: string) {
	return {
		id: "arxiv:2507.11473",
		type: "paper",
		title: "A paper whose page is the same address",
		authors: ["Ada Example"],
		published: "2026-10-04",
		source: "arXiv",
		url: url,
		links: [],
		abstract: "Measurements across several benchmarks.",
	};
}

// The local server's "host:port", which LIMINAL_ALLOW_LOCAL lets describe.ts reach.
function allowed(base: string): Record<string, string> {
	return { LIMINAL_ALLOW_LOCAL: base.replace("http://", "") };
}

// A server that serves the pages of `pages` by path, counts its requests, and answers anything else with HTTP 404.
async function servePages(
	pages: Record<string, (response: ServerResponse) => void>,
) {
	const requests: string[] = [];
	const base = await serve(
		(incoming: IncomingMessage, response: ServerResponse) => {
			const path = String(incoming.url);
			requests.push(path);
			const answer = Object.hasOwn(pages, path) ? pages[path] : undefined;
			if (answer === undefined) {
				response.writeHead(404);
				response.end();
				return;
			}
			answer(response);
		},
	);
	return { base: base, requests: requests };
}

function html(text: string): (response: ServerResponse) => void {
	return (response) => {
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		response.end(text);
	};
}

function redirect(
	status: number,
	location: string,
): (response: ServerResponse) => void {
	return (response) => {
		response.writeHead(status, { location: location });
		response.end();
	};
}

// A digests file in a fresh folder holding these lines.
function digestsFile(lines: string[]): { file: string; folder: string } {
	const folder = tempFolder("liminal-unit-describe-");
	const file = join(folder, "digests.js");
	writeFileSync(file, `${lines.join("\n")}\n`);
	return { file: file, folder: folder };
}

function linesOf(file: string): string[] {
	return readFileSync(file, "utf8").split("\n");
}

test("News, article and report entries are described, a redirect is followed, and other lines and fields stay as they were", async () => {
	const sentence =
		"The same sentence describes a news story, an article and a report.";
	const { base, requests } = await servePages({
		"/news": html(og(sentence)),
		"/article": html(og(sentence)),
		"/report": html(og(sentence)),
		"/moved": redirect(301, "/news"),
	});
	const untouched = digestText("2026-10-01", [
		item("news", "https://example.com/x"),
	]);
	const { file } = digestsFile([
		untouched,
		digestText("2026-10-04", [
			item("news", `${base}/news`),
			item("article", `${base}/article`),
			item("report", `${base}/report`),
			item("news", `${base}/moved`),
			paperEntry(`${base}/news`),
		]),
		untouched,
	]);
	const ran = await runScript(
		DESCRIBE,
		[
			file,
			`${base}/news`,
			`${base}/article`,
			`${base}/report`,
			`${base}/moved`,
		],
		allowed(base),
	);
	assert.equal(ran.code, 0, ran.stderr);
	assert.equal(ran.stdout, `added 4 descriptions to ${file}\n`);
	const lines = linesOf(file);
	assert.equal(lines.length, 4, "three lines and the file's last line break");
	assert.equal(lines[0], untouched);
	assert.equal(lines[2], untouched);
	const [news, article, report, moved, paper] = entriesOfLine(lines[1] ?? "");
	assert.deepEqual(
		news,
		item("news", `${base}/news`, { description: sentence }),
	);
	assert.deepEqual(
		article,
		item("article", `${base}/article`, { description: sentence }),
	);
	assert.deepEqual(
		report,
		item("report", `${base}/report`, { description: sentence }),
	);
	assert.deepEqual(
		moved,
		item("news", `${base}/moved`, { description: sentence }),
	);
	assert.deepEqual(
		paper,
		paperEntry(`${base}/news`),
		"a paper entry is not described",
	);
	assert.ok(requests.includes("/news"));
});

test("An entry whose description is empty counts as having none", async () => {
	const { base } = await servePages({
		"/a": html(
			og("An empty description is filled in with the publisher's own text."),
		),
	});
	const { file } = digestsFile([
		digestText("2026-10-04", [item("news", `${base}/a`, { description: "" })]),
	]);
	const ran = await runScript(DESCRIBE, [file, `${base}/a`], allowed(base));
	assert.equal(ran.stdout, `added 1 description to ${file}\n`);
	const [entry] = entriesOfLine(linesOf(file)[0] ?? "");
	assert.equal(
		entry?.description,
		"An empty description is filled in with the publisher's own text.",
	);
});

test("A page that fails is named with its reason and its entry gets no description, while the other pages are still described", async () => {
	const { base } = await servePages({
		"/good": html(
			og("This page's description is still added when another URL fails."),
		),
		"/forbidden": (response) => {
			response.writeHead(403);
			response.end();
		},
	});
	const refused = "http://127.0.0.1:1/never";
	const before = [
		item("news", `${base}/good`),
		item("news", `${base}/forbidden`),
		item("news", `${base}/missing`),
		item("news", refused),
	];
	const { file } = digestsFile([digestText("2026-10-04", before)]);
	const ran = await runScript(
		DESCRIBE,
		[file, `${base}/good`, `${base}/forbidden`, `${base}/missing`, refused],
		allowed(base),
	);
	assert.notEqual(ran.code, 0);
	assert.match(ran.stderr, new RegExp(`${base}/forbidden: HTTP 403`));
	assert.match(ran.stderr, new RegExp(`${base}/missing: HTTP 404`));
	assert.match(ran.stderr, /http:\/\/127\.0\.0\.1:1\/never/);
	const entries = entriesOfLine(linesOf(file)[0] ?? "");
	assert.equal(
		entries[0]?.description,
		"This page's description is still added when another URL fails.",
	);
	for (const entry of entries.slice(1)) {
		assert.equal("description" in entry, false, String(entry.url));
	}
});

test("A page with no description, or only too short ones, leaves the file unchanged and is named", async () => {
	const { base } = await servePages({
		"/none": html(head("")),
		"/short": html(og("Introduction")),
	});
	const { file } = digestsFile([
		digestText("2026-10-04", [
			item("news", `${base}/none`),
			item("article", `${base}/short`),
		]),
	]);
	const before = readFileSync(file, "utf8");
	const ran = await runScript(
		DESCRIBE,
		[file, `${base}/none`, `${base}/short`],
		allowed(base),
	);
	assert.notEqual(ran.code, 0);
	assert.match(
		ran.stderr,
		new RegExp(`no description on the page: ${base}/none`),
	);
	assert.match(
		ran.stderr,
		new RegExp(`no usable description on the page: ${base}/short`),
	);
	assert.equal(readFileSync(file, "utf8"), before);
});

test("An entry that already has a description is skipped without a request, and the run exits 0", async () => {
	const { base, requests } = await servePages({
		"/a": html(og("Never read.")),
	});
	const { file } = digestsFile([
		digestText("2026-10-04", [
			item("news", `${base}/a`, {
				description: "[AI Summarized] Written by the scout.",
			}),
		]),
	]);
	const before = readFileSync(file, "utf8");
	const ran = await runScript(DESCRIBE, [file, `${base}/a`], allowed(base));
	assert.equal(ran.code, 0, ran.stderr);
	assert.match(ran.stderr, new RegExp(`already described, skipped: ${base}/a`));
	assert.deepEqual(requests, []);
	assert.equal(readFileSync(file, "utf8"), before);
});

test("A URL with no news, article or report entry is named and never requested", async () => {
	const { base, requests } = await servePages({
		"/p": html(og("Never read.")),
	});
	const { file } = digestsFile([
		digestText("2026-10-04", [paperEntry(`${base}/p`)]),
	]);
	const before = readFileSync(file, "utf8");
	const ran = await runScript(
		DESCRIBE,
		[file, `${base}/p`, `${base}/other`],
		allowed(base),
	);
	assert.notEqual(ran.code, 0);
	assert.match(
		ran.stderr,
		new RegExp(`no news, article or report entry: ${base}/p`),
	);
	assert.match(
		ran.stderr,
		new RegExp(`no news, article or report entry: ${base}/other`),
	);
	assert.deepEqual(requests, []);
	assert.equal(readFileSync(file, "utf8"), before);
});

test("privacy: A digests line that doesn't load stops the run before any request, is named by number and is never quoted", async () => {
	const { base, requests } = await servePages({
		"/a": html(og("Never read.")),
	});
	const { file } = digestsFile([
		digestText("2026-10-04", [item("news", `${base}/a`)]),
		"SECRET-7f3a(not a digest)",
	]);
	const before = readFileSync(file, "utf8");
	const ran = await runScript(DESCRIBE, [file, `${base}/a`], allowed(base));
	assert.notEqual(ran.code, 0);
	assert.match(ran.stderr, /line 2 of /);
	assert.equal((ran.stdout + ran.stderr).includes("SECRET-7f3a"), false);
	assert.deepEqual(requests, []);
	assert.equal(readFileSync(file, "utf8"), before);
});

test("Missing arguments print the usage line, and a digests file that doesn't exist is named and not created", async () => {
	const folder = tempFolder("liminal-unit-describe-");
	const missing = join(folder, "digests.js");
	for (const args of [[], [missing]]) {
		const ran = await runScript(DESCRIBE, args);
		assert.notEqual(ran.code, 0);
		assert.match(ran.stderr, /usage/i);
	}
	const ran = await runScript(DESCRIBE, [missing, "https://example.com/a"]);
	assert.notEqual(ran.code, 0);
	assert.match(ran.stderr, /doesn't exist/);
	assert.deepEqual(readdirSync(folder), []);
});

test("security: A redirect that leads off the web, or loops, is named and nothing is described", async () => {
	const { base } = await servePages({
		"/ftp": redirect(302, "ftp://example.com/page"),
		"/file": redirect(302, "file:///etc/passwd"),
		"/js": redirect(302, "javascript:alert(1)"),
		"/loop": redirect(302, "/loop"),
	});
	const paths = ["/ftp", "/file", "/js", "/loop"];
	const { file } = digestsFile([
		digestText(
			"2026-10-04",
			paths.map((path) => item("news", `${base}${path}`)),
		),
	]);
	const before = readFileSync(file, "utf8");
	const ran = await runScript(
		DESCRIBE,
		[file, ...paths.map((path) => `${base}${path}`)],
		allowed(base),
	);
	assert.notEqual(ran.code, 0);
	for (const target of [
		"ftp://example.com/page",
		"file:///etc/passwd",
		"javascript:alert(1)",
	]) {
		assert.ok(ran.stderr.includes(`redirect to ${target}: not http or https`));
	}
	assert.match(
		ran.stderr,
		new RegExp(`${base}/loop: more than \\d+ redirects`),
	);
	assert.equal(readFileSync(file, "utf8"), before);
});

test("security: A link on this machine or a private network is never fetched, and a redirect to one is refused", async () => {
	const inner = await servePages({
		"/admin": html(og("Secret admin page text that must not be read.")),
	});
	const outer = await servePages({
		"/go": redirect(302, `${inner.base}/admin`),
	});
	const links = [
		`${inner.base}/admin`,
		"http://localhost:1/page.html",
		"http://169.254.169.254/latest/meta-data/",
		`${outer.base}/go`,
	];
	const { file } = digestsFile([
		digestText(
			"2026-10-04",
			links.map((url) => item("news", url)),
		),
	]);
	const before = readFileSync(file, "utf8");
	// Only the outer stand-in is let through; the inner one is another port on this machine.
	const ran = await runScript(DESCRIBE, [file, ...links], allowed(outer.base));
	assert.notEqual(ran.code, 0);
	assert.deepEqual(
		inner.requests,
		[],
		"nothing reached the service on this machine",
	);
	assert.match(ran.stderr, /"127\.0\.0\.1" is not on the public internet/);
	assert.match(ran.stderr, /"localhost" is not on the public internet/);
	assert.match(
		ran.stderr,
		/"169\.254\.169\.254" is not on the public internet/,
	);
	assert.match(
		ran.stderr,
		new RegExp(`${outer.base}/go: redirect to ${inner.base}/admin: `),
	);
	assert.equal(readFileSync(file, "utf8"), before);
});

// Text as windows-1252 holds it: Latin-1 for the letters used here, 0x97 for the em dash and 0x92 for the apostrophe.
function windows1252(text: string): Buffer {
	const special: Record<string, number> = { "—": 0x97, "’": 0x92 };
	return Buffer.from(
		[...text].map((character) => {
			const code = special[character] ?? character.charCodeAt(0);
			assert.ok(code < 256, `${character} is not in windows-1252`);
			return code;
		}),
	);
}

test("A page's windows-1252 character set is read from the HTTP header or either meta tag, and the header wins over a meta tag", async () => {
	const french = "Café crème — l’été, naïve, une soirée au bord de la mer";
	const tag = `<meta property="og:description" content="${french}">`;
	const bytes = (tags: string) =>
		windows1252(
			`<!doctype html><html><head>${tags}${tag}</head><body>x</body></html>`,
		);
	const served = (type: string, body: Buffer) => (response: ServerResponse) => {
		response.writeHead(200, { "content-type": type });
		response.end(body);
	};
	const { base } = await servePages({
		"/header": served("text/html; charset=windows-1252", bytes("")),
		"/meta": served("text/html", bytes('<meta charset="windows-1252">')),
		"/equiv": served(
			"text/html",
			bytes(
				'<meta http-equiv="Content-Type" content="text/html; charset=windows-1252">',
			),
		),
		"/both": served(
			"text/html; charset=windows-1252",
			bytes('<meta charset="UTF-8">'),
		),
		"/utf8": served(
			"text/html",
			Buffer.from(`<!doctype html><html><head>${tag}</head></html>`),
		),
	});
	const paths = ["/header", "/meta", "/equiv", "/both", "/utf8"];
	const { file } = digestsFile([
		digestText(
			"2026-10-04",
			paths.map((path) => item("news", `${base}${path}`)),
		),
	]);
	const ran = await runScript(
		DESCRIBE,
		[file, ...paths.map((path) => `${base}${path}`)],
		allowed(base),
	);
	assert.equal(ran.code, 0, ran.stderr);
	for (const entry of entriesOfLine(linesOf(file)[0] ?? "")) {
		assert.equal(entry.description, french, String(entry.url));
	}
});

test("A line appended while a page loads is kept, as the file's last line", async () => {
	let requestArrived = () => {};
	const arrived = new Promise<void>((resolve) => {
		requestArrived = resolve;
	});
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const slow = await serve((_incoming, response) => {
		requestArrived();
		void gate.then(() => {
			response.writeHead(200, { "content-type": "text/html" });
			response.end(
				og("This slow page answers only after the file has grown by a line."),
			);
		});
	});
	const { file } = digestsFile([
		digestText("2026-10-04", [item("news", `${slow}/slow`)]),
	]);
	const running = runScript(DESCRIBE, [file, `${slow}/slow`], allowed(slow));
	// The page is answered only once the other line is in the file, after the script has read the file once.
	await arrived;
	const late = digestText("2026-10-05", [
		item("news", "https://example.com/late"),
	]);
	writeFileSync(file, `${readFileSync(file, "utf8")}${late}\n`);
	release();
	const ran = await running;
	assert.equal(ran.code, 0, ran.stderr);
	const lines = linesOf(file);
	assert.equal(lines[1], late);
	assert.equal(lines.length, 3);
	assert.equal(
		entriesOfLine(lines[0] ?? "")[0]?.description,
		"This slow page answers only after the file has grown by a line.",
	);
});

test("A copied description of 500 characters is kept whole, and a longer one is cut at a word and ends in …", async () => {
	const words = (count: number) =>
		Array.from({ length: count }, () => "abcdefghi").join(" ");
	const long = words(80);
	// 99 words of 4 letters, then one of 5: 99 * 5 + 5 = 500 characters.
	const exact = `${Array.from({ length: 99 }, () => "abcd").join(" ")} abcde`;
	assert.equal(exact.length, 500);
	const { base } = await servePages({
		"/long": html(og(long)),
		"/exact": html(og(exact)),
	});
	const { file } = digestsFile([
		digestText("2026-10-04", [
			item("news", `${base}/long`),
			item("news", `${base}/exact`),
		]),
	]);
	const ran = await runScript(
		DESCRIBE,
		[file, `${base}/long`, `${base}/exact`],
		allowed(base),
	);
	assert.equal(ran.code, 0, ran.stderr);
	const [cut, whole] = entriesOfLine(linesOf(file)[0] ?? "");
	assert.equal(cut?.description, `${words(49)}…`);
	assert.equal(String(cut?.description).length, 49 * 9 + 48 + 1);
	assert.equal(whole?.description, exact);
});

// ---- the --summary form ----

const SUMMARY_URL = "https://example.com/news/1";

test("--summary adds the labelled summary without a request, and the file keeps its permissions", async () => {
	const { file, folder } = digestsFile([
		digestText("2026-10-04", [item("news", SUMMARY_URL)]),
	]);
	chmodSync(file, 0o600);
	const ran = await runScript(DESCRIBE, [
		file,
		"--summary",
		SUMMARY_URL,
		"The council voted to fund forty buoys.",
	]);
	assert.equal(ran.code, 0, ran.stderr);
	const [entry] = entriesOfLine(linesOf(file)[0] ?? "");
	assert.equal(
		entry?.description,
		"[AI Summarized] The council voted to fund forty buoys.",
	);
	assert.equal(statSync(file).mode & 0o777, 0o600);
	assert.deepEqual(readdirSync(folder), ["digests.js"]);
});

test("A summary that can't be added is refused with its reason and the file is unchanged", async () => {
	const { file } = digestsFile([
		digestText("2026-10-04", [
			item("news", SUMMARY_URL),
			item("news", "https://example.com/news/2", {
				description: "Publisher text.",
			}),
			paperEntry("https://arxiv.org/abs/2507.11473"),
		]),
	]);
	const before = readFileSync(file, "utf8");
	const cases: [string[], RegExp][] = [
		[
			["--summary", "https://example.com/news/9", "Some text."],
			/no news, article or report has the URL/,
		],
		[
			["--summary", "https://arxiv.org/abs/2507.11473", "Some text."],
			/only news, articles and reports take a summary/,
		],
		[["--summary", SUMMARY_URL, ""], /the summary is empty/],
		[["--summary", SUMMARY_URL, "[AI Summarized]"], /the summary is empty/],
		[
			["--summary", "https://example.com/news/2", "Model text."],
			/already has a description; a summary never replaces it/,
		],
		[["--summary", SUMMARY_URL], /--summary needs a URL and a summary/],
	];
	for (const [args, reason] of cases) {
		const ran = await runScript(DESCRIBE, [file, ...args]);
		assert.notEqual(ran.code, 0, args.join(" "));
		assert.match(ran.stderr, reason, args.join(" "));
		assert.equal(readFileSync(file, "utf8"), before, args.join(" "));
	}
});

test("The script runs when it is called through a symlink to it", async () => {
	const { base } = await servePages({
		"/a": html(
			og("The script still runs when it is called through a symlink."),
		),
	});
	const { file, folder } = digestsFile([
		digestText("2026-10-04", [item("news", `${base}/a`)]),
	]);
	const link = join(folder, "describe-link.ts");
	symlinkSync(DESCRIBE, link);
	const ran = await runScript(link, [file, `${base}/a`], allowed(base));
	assert.equal(ran.code, 0, ran.stderr);
	assert.equal(ran.stdout, `added 1 description to ${file}\n`);
});
