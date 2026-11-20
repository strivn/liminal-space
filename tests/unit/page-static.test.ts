// index.html's script policy and the preload of the newest month.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { preloadLinks } from "../../scripts/deploy/build-site.ts";

const SITE = join(import.meta.dirname, "..", "..", "site");

test("security: index.html holds no inline script and no inline event handler attribute such as onclick, which the content security policy would refuse", () => {
	const html = readFileSync(join(SITE, "index.html"), "utf8").replace(
		/<!--[\s\S]*?-->/g,
		"",
	);
	for (const script of html.match(/<script\b[^>]*>/g) ?? []) {
		assert.match(script, /\bsrc="/, `an inline script: ${script}`);
	}
	assert.equal(html.match(/\son[a-z]+\s*=/gi), null);
});

test("the newest month's file is preloaded as a fetch with crossorigin, and a site with no days preloads none", () => {
	const index = {
		days: [
			{ date: "2026-10-16", month: "2026-10", entries: [] },
			{ date: "2026-09-20", month: "2026-09", entries: [] },
		],
		months: {
			"2026-10": "months/2026-10.3f9a1c2b7d4e.json",
			"2026-09": "months/2026-09.aaaaaaaaaaaa.json",
		},
	};
	assert.equal(
		preloadLinks(index),
		'  <link rel="preload" href="data/months/2026-10.3f9a1c2b7d4e.json" as="fetch" crossorigin>\n',
	);
	assert.equal(preloadLinks({ days: [], months: {} }), "");
	assert.equal(preloadLinks({ days: index.days, months: {} }), "");
});
