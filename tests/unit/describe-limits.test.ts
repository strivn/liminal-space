// Unit tests for what one fetched page can cost describe.ts and where its fetches may go: the description is read from
// the head only, in time proportional to the page, with no control character; a link to the cloud host's own address
// is never fetched.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "vitest";
import type * as Describe from "../../scripts/scout/web/describe.ts";

const SCRIPT = new URL("../../scripts/scout/web/describe.ts", import.meta.url);
const NO_NETWORK = new URL("../fixtures/no-network.ts", import.meta.url);
const run = promisify(execFile);

// A whole page with `headTags` in its head, among tags that are not descriptions.
function page(headTags: string) {
	return [
		"<!doctype html>",
		'<html lang="en">',
		"<head>",
		'<meta charset="utf-8">',
		"<title>Fixture page</title>",
		headTags,
		"</head>",
		"<body><p>Body text, which is not the description.</p></body>",
		"</html>",
	].join("\n");
}

test("security: A description is read from the head only: a tag planted in the body is ignored", async () => {
	const { pageDescription }: typeof Describe = await import(SCRIPT.href);
	const html = page("").replace(
		"<p>Body text",
		'<p><meta property="og:description" content="Planted in a comment box by a reader of this page.">Body text',
	);
	assert.equal(pageDescription(html), null);
});

test("A description after 300 KB of inline style in the head is still found", async () => {
	const { pageDescription }: typeof Describe = await import(SCRIPT.href);
	const html = page(
		`<style>${"a { color: red; } ".repeat(18_000)}</style>` +
			'<meta property="og:description" content="Forty ocean buoys now report Java Sea temperatures every ten minutes.">',
	);
	assert.equal(
		pageDescription(html),
		"Forty ocean buoys now report Java Sea temperatures every ten minutes.",
	);
});

test("security: A page of 2 MB that repeats an unclosed <meta tag gives no description in under a second", async () => {
	const { pageDescription }: typeof Describe = await import(SCRIPT.href);
	const html = `<html><head>${"<meta ".repeat(350_000)}`;
	const started = performance.now();
	assert.equal(pageDescription(html), null);
	assert.ok(performance.now() - started < 1000, "read in under 1 second");
});

test("security: Control characters in a description are dropped: an escape sequence, a null and a lone carriage return", async () => {
	const { pageDescription }: typeof Describe = await import(SCRIPT.href);
	const html = page(
		'<meta property="og:description" content="Buoys cut the\u001b[2J rainfall\u0000 outlook error by a third\r today.">',
	);
	assert.equal(
		pageDescription(html),
		"Buoys cut the rainfall outlook error by a third today.",
	);
});

test("security: A link to the cloud host's own address is never fetched, and the run fails with the entry left unchanged", async () => {
	const folder = mkdtempSync(join(tmpdir(), "liminal-unit-describe-limits-"));
	try {
		const url = "http://168.63.129.16/machine?comp=goalstate";
		const file = join(folder, "digests.js");
		const text = `digest(${JSON.stringify({
			date: "2026-10-04",
			entries: [
				{
					id: `url:${url}`,
					type: "news",
					title: "Fixture news",
					authors: [],
					published: "2026-10-04",
					source: "Fixture Times",
					url: url,
				},
			],
		})});\n`;
		writeFileSync(file, text);
		let failed = { code: 0, stdout: "", stderr: "" };
		try {
			await run(
				process.execPath,
				["--import", NO_NETWORK.pathname, SCRIPT.pathname, file, url],
				{ timeout: 60_000 },
			);
		} catch (error) {
			failed = error as typeof failed;
		}
		assert.equal(failed.code, 1);
		assert.match(
			failed.stderr,
			/"168\.63\.129\.16" is not on the public internet/,
		);
		assert.ok(
			!failed.stderr.includes("no-network.ts: blocked"),
			"no connection was even tried",
		);
		assert.equal(readFileSync(file, "utf8"), text);
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
});
