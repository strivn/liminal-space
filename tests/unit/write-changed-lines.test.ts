// Tests of scripts/digests/digests-file.ts's readDigests and writeChangedLines, the one place describe.ts and figure.ts rewrite
// the digests file, in a temp folder.

import assert from "node:assert/strict";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import {
	readDigests,
	writeChangedLines,
} from "../../scripts/digests/digests-file.ts";
import { digestText, removeTempFolders, tempFolder } from "./run-script.ts";

afterAll(removeTempFolders);

function entry(n: number, description?: string) {
	const fields: Record<string, unknown> = {
		id: `url:https://example.com/${n}`,
		type: "news",
		title: `Story ${n}`,
		authors: ["Ada Example"],
		published: "2026-10-04",
		source: "Fixture Times",
		url: `https://example.com/${n}`,
		links: [],
	};
	if (description !== undefined) {
		fields.description = description;
	}
	return fields;
}

// Never reached: the writes here succeed, or the test checks what the stop was told.
function noStop(): never {
	throw new Error("the write stopped");
}

// A file of three lines, the middle one given a description through writeChangedLines.
function describeSecondLine(
	file: string,
	stop: (real: string, code: string | undefined) => never = noStop,
) {
	const read = readDigests(file, noStop);
	const second = read.digests[1]?.digest as {
		entries: Record<string, unknown>[];
	};
	const first = second.entries[0];
	assert.ok(first);
	first.description = "Added.";
	writeChangedLines(file, read, new Set([1]), stop);
}

const THREE = [
	digestText("2026-10-01", [entry(1)]),
	digestText("2026-10-02", [entry(2)]),
	digestText("2026-10-03", [entry(3)]),
];

test("Only the changed line is rewritten: the other lines, the file's mode and the folder stay as they were", () => {
	for (const mode of [0o600, 0o664]) {
		const folder = tempFolder("liminal-unit-write-");
		const file = join(folder, "digests.js");
		// The last line has no line break, as a hand edit can leave it.
		writeFileSync(file, THREE.join("\n"));
		chmodSync(file, mode);
		describeSecondLine(file);
		const lines = readFileSync(file, "utf8").split("\n");
		assert.equal(lines[0], THREE[0]);
		assert.equal(lines[2], THREE[2]);
		assert.equal(lines.length, 3, "no line break was added");
		assert.equal(lines[1], digestText("2026-10-02", [entry(2, "Added.")]));
		assert.equal(statSync(file).mode & 0o777, mode);
		assert.deepEqual(
			readdirSync(folder),
			["digests.js"],
			"no temporary file is left",
		);
	}
});

test("A digests file reached through a symbolic link stays a link, and the file it points to is the one changed", () => {
	const real = tempFolder("liminal-unit-write-real-");
	const links = tempFolder("liminal-unit-write-link-");
	const target = join(real, "digests.js");
	writeFileSync(target, `${THREE.join("\n")}\n`);
	const link = join(links, "digests.js");
	symlinkSync(target, link);
	describeSecondLine(link);
	assert.equal(lstatSync(link).isSymbolicLink(), true);
	assert.equal(readlinkSync(link), target);
	assert.match(readFileSync(target, "utf8"), /"description":"Added\."/);
	assert.deepEqual(readdirSync(real), ["digests.js"]);
	assert.deepEqual(readdirSync(links), ["digests.js"]);
});

test.skipIf(process.getuid?.() === 0)(
	"A file in a folder that cannot be written is left as it was, with no temporary file, and the error code is passed on",
	() => {
		const folder = tempFolder("liminal-unit-write-");
		const sub = join(folder, "sub");
		mkdirSync(sub);
		const file = join(sub, "digests.js");
		writeFileSync(file, `${THREE.join("\n")}\n`);
		const before = readFileSync(file, "utf8");
		chmodSync(sub, 0o555);
		const told: (string | undefined)[] = [];
		try {
			describeSecondLine(file, (_real, code) => {
				told.push(code);
				throw new Error("stopped");
			});
		} catch (error) {
			assert.equal((error as Error).message, "stopped");
		} finally {
			chmodSync(sub, 0o755);
		}
		assert.deepEqual(told, ["EACCES"]);
		assert.equal(readFileSync(file, "utf8"), before);
		assert.deepEqual(readdirSync(sub), ["digests.js"]);
	},
);
