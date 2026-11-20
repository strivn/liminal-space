// The folder layout's rules, read from the source files themselves.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { test } from "vitest";

const SHARED = resolve(import.meta.dirname, "../../shared");
const SCRIPTS = resolve(import.meta.dirname, "../../scripts");
const LIB = join(SCRIPTS, "lib");
const SCOUT = join(SCRIPTS, "scout");

test("shared/ imports nothing from scripts/, site/ or worker/", () => {
	const outside: string[] = [];
	for (const name of readdirSync(SHARED).filter((n) => n.endsWith(".ts"))) {
		const source = readFileSync(join(SHARED, name), "utf8");
		for (const match of source.matchAll(/from "(\.[^"]*)"/g)) {
			const target = resolve(SHARED, match[1] ?? "");
			if (!target.startsWith(SHARED + sep)) {
				outside.push(`${name} imports ${match[1]}`);
			}
		}
	}
	assert.deepEqual(outside, []);
});

// Every .ts file under a folder, as absolute paths.
function tsFiles(folder: string): string[] {
	return readdirSync(folder, { recursive: true, encoding: "utf8" })
		.filter((name) => name.endsWith(".ts"))
		.map((name) => join(folder, name));
}

// Every relative import of a file, as the path it resolves to.
function importTargets(file: string): string[] {
	const source = readFileSync(file, "utf8");
	// Static, side-effect and dynamic imports: from "x", import "x", import("x").
	const imports = /(?:\bfrom|\bimport)\s*\(?\s*"(\.[^"]*)"/g;
	return [...source.matchAll(imports)].map((match) =>
		resolve(join(file, ".."), match[1] ?? ""),
	);
}

const inside = (folder: string, file: string) => file.startsWith(folder + sep);
const name = (file: string) => relative(SCRIPTS, file);

// A program runs on its own: outside lib/, with an import.meta.main block.
const PROGRAMS = tsFiles(SCRIPTS).filter(
	(file) =>
		!inside(LIB, file) &&
		/^if \(import\.meta\.main\)/m.test(readFileSync(file, "utf8")),
);

test("no program in scripts/ imports another program", () => {
	assert.ok(PROGRAMS.length > 0, "found no program");
	const edges = tsFiles(SCRIPTS).flatMap((file) =>
		importTargets(file)
			.filter((target) => PROGRAMS.includes(target))
			.map((target) => `${name(file)} imports ${name(target)}`),
	);
	assert.deepEqual(edges, []);
});

test("scripts/lib imports only scripts/lib and shared/", () => {
	const edges = tsFiles(LIB).flatMap((file) =>
		importTargets(file)
			.filter((target) => !inside(LIB, target) && !inside(SHARED, target))
			.map((target) => `${name(file)} imports ${name(target)}`),
	);
	assert.deepEqual(edges, []);
});

test("only scripts/scout imports from scripts/scout", () => {
	const edges = tsFiles(SCRIPTS)
		.filter((file) => !inside(SCOUT, file))
		.flatMap((file) =>
			importTargets(file)
				.filter((target) => inside(SCOUT, target))
				.map((target) => `${name(file)} imports ${name(target)}`),
		);
	assert.deepEqual(edges, []);
});

test("scripts/lib never calls process.exit, except cli.ts", () => {
	// Comment lines are skipped: a comment may name process.exit().
	const codeOf = (file: string) =>
		readFileSync(file, "utf8")
			.split("\n")
			.filter((line) => !line.trim().startsWith("//"))
			.join("\n");
	const callers = tsFiles(LIB)
		.filter((file) => name(file) !== join("lib", "cli.ts"))
		.filter((file) => /process\.exit\(/.test(codeOf(file)))
		.map(name);
	assert.deepEqual(callers, []);
});

test("describe.ts does not import the HTTP helper in scripts/lib/http.ts", () => {
	const describe = join(SCOUT, "web", "describe.ts");
	assert.ok(!importTargets(describe).includes(join(LIB, "http.ts")));
});
