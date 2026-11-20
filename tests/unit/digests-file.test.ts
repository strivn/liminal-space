// Unit tests for what scripts/digests/digests-file.ts writes and reads of a digests file, in a temporary folder.
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import {
	appendDigestLine,
	digestLine,
	idsInText,
	readDigestsText,
} from "../../scripts/digests/digests-file.ts";

const FOLDER = mkdtempSync(join(tmpdir(), "liminal-unit-digests-file-"));
afterAll(() => {
	rmSync(FOLDER, { recursive: true, force: true });
});

const ENTRIES = [{ id: "arxiv:2507.11473", title: "A" }];
const LINE = `digest({"date":"2026-11-17","entries":[{"id":"arxiv:2507.11473","title":"A"}]});`;

test("A digest line holds the date before the entries and ends without a line break", () => {
	expect(digestLine("2026-11-17", ENTRIES)).toBe(LINE);
});

test("Appending to a file whose last line has no line break adds one first", () => {
	const file = join(FOLDER, "no-break.js");
	writeFileSync(file, "digest({});");
	appendDigestLine(file, "2026-11-17", ENTRIES);
	expect(readFileSync(file, "utf8")).toBe(`digest({});\n${LINE}\n`);
});

test("Appending to a file that ends with a line break adds no second one", () => {
	const file = join(FOLDER, "with-break.js");
	writeFileSync(file, "digest({});\n");
	appendDigestLine(file, "2026-11-17", ENTRIES);
	expect(readFileSync(file, "utf8")).toBe(`digest({});\n${LINE}\n`);
});

test("Appending to a missing file creates it", () => {
	const file = join(FOLDER, "missing.js");
	expect(existsSync(file)).toBe(false);
	appendDigestLine(file, "2026-11-17", ENTRIES);
	expect(readFileSync(file, "utf8")).toBe(`${LINE}\n`);
});

test("Reading a missing digests file gives empty text, and reading a folder throws", () => {
	expect(readDigestsText(join(FOLDER, "nothing-here.js"))).toBe("");
	const folder = join(FOLDER, "a-folder");
	mkdirSync(folder);
	expect(() => readDigestsText(folder)).toThrow();
});

test("The ids in a digests text drop an arXiv id's prefix and version and keep doi: and url: ids as written", () => {
	const text = [
		'digest({"date":"2026-11-16","entries":[{"id":"arxiv:2507.11473v2"},{"id":"arxiv:hep-th/9901001"}]});',
		'digest({"date":"2026-11-17","entries":[{"id":"doi:10.56553/Popets-2026"},{"id":"url:https://example.org/News"},{"id":"news:x"}]});',
	].join("\n");
	expect(idsInText(text)).toEqual({
		arxiv: new Set(["2507.11473", "hep-th/9901001"]),
		other: new Set([
			"doi:10.56553/Popets-2026",
			"url:https://example.org/News",
		]),
	});
});
