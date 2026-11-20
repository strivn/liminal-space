// The page writes no HTML strings, so the browser can be told to refuse them (Trusted Types): the page's code holds no
// innerHTML, outerHTML or insertAdjacentHTML.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "vitest";

const SITE = resolve(import.meta.dirname, "../../site");

// Every .ts file under a folder, as a path.
function sources(folder: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(folder, { withFileTypes: true })) {
		const path = join(folder, entry.name);
		if (entry.isDirectory()) {
			found.push(...sources(path));
		} else if (entry.name.endsWith(".ts")) {
			found.push(path);
		}
	}
	return found;
}

test("security: the page's code never uses innerHTML, outerHTML or insertAdjacentHTML", () => {
	const files = [...sources(join(SITE, "page")), join(SITE, "app.ts")];
	const sinks: string[] = [];
	for (const file of files) {
		const text = readFileSync(file, "utf8");
		for (const match of text.matchAll(
			/\b(innerHTML|outerHTML|insertAdjacentHTML)\b/g,
		)) {
			sinks.push(`${file}: ${match[1]}`);
		}
	}
	assert.ok(files.length > 1, "the scan reads the page's files");
	assert.deepEqual(sinks, []);
});
