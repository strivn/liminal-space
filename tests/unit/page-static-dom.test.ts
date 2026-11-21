// @vitest-environment jsdom
// index.html's script policy.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";

const SITE = join(import.meta.dirname, "..", "..", "site");

test("security: index.html holds no inline script and no inline event handler attribute such as onclick, which the content security policy would refuse", () => {
	const document = new DOMParser().parseFromString(
		readFileSync(join(SITE, "index.html"), "utf8"),
		"text/html",
	);
	assert.equal(document.querySelectorAll("script:not([src])").length, 0);
	for (const element of document.querySelectorAll("*")) {
		for (const name of element.getAttributeNames()) {
			assert.ok(!name.startsWith("on"), `${element.tagName} has ${name}`);
		}
	}
});
