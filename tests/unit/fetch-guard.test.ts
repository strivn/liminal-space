// scripts/scout/web/fetch-guard.ts and scripts/lib/public-address.ts: the output folders fulltext.sh may write to,
// and the addresses that may be fetched.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test, vi } from "vitest";

// What a name resolves to in these tests; an IP address resolves to itself, as in Node.
const resolved = vi.hoisted(() => new Map<string, string[]>());
vi.mock("node:dns/promises", () => ({
	lookup: async (host: string) =>
		(resolved.get(host) || [host]).map((address) => ({
			address: address,
			family: 4,
		})),
}));

const { FetchRefused, publicAddress } = await import(
	"../../scripts/lib/public-address.ts"
);

const ROOT = path.join(import.meta.dirname, "..", "..");
const GUARD = path.join(ROOT, "scripts", "scout", "web", "fetch-guard.ts");

const made: string[] = [];
afterEach(() => {
	resolved.clear();
	for (const each of made.splice(0)) {
		fs.rmSync(each, { recursive: true, force: true });
	}
});

// A fresh folder of the test's own inside the system's temporary folder, as its real path.
function tempFolder(): string {
	const folder = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "liminal-guard-")),
	);
	made.push(folder);
	return folder;
}

// Ask the guard about an output folder, with TMPDIR set to `tmp`.
function checkFolder(folder: string, tmp: string) {
	const run = spawnSync(process.execPath, [GUARD, "folder", folder], {
		encoding: "utf8",
		env: { ...process.env, TMPDIR: tmp },
	});
	return { code: run.status, stdout: run.stdout.trim(), stderr: run.stderr };
}

test("security: an output folder inside TMPDIR is allowed, and one that doesn't exist yet too", () => {
	const tmp = tempFolder();
	assert.deepEqual(checkFolder(tmp, tmp), { code: 0, stdout: tmp, stderr: "" });
	const inner = path.join(tmp, "new", "deeper");
	assert.equal(checkFolder(inner, tmp).stdout, inner);
});

test("security: an output folder in the repository is refused", () => {
	const folder = path.join(ROOT, "site");
	const run = checkFolder(folder, tempFolder());
	assert.equal(run.code, 1);
	assert.equal(run.stdout, "");
	assert.match(run.stderr, /is not inside TMPDIR or /);
});

test("security: a link in TMPDIR that leads into the repository is refused, naming where it leads", () => {
	const tmp = tempFolder();
	const link = path.join(tmp, "link");
	fs.symlinkSync(path.join(ROOT, "site"), link);
	const run = checkFolder(path.join(link, "out"), tmp);
	assert.equal(run.code, 1);
	assert.ok(
		run.stderr.includes(
			`it resolves to ${path.join(fs.realpathSync(ROOT), "site", "out")}`,
		),
		run.stderr,
	);
});

test("security: a folder whose name only starts with TMPDIR's is refused", () => {
	// The repository's own folder stands in for TMPDIR, so its neighbour is in no temporary folder.
	const run = checkFolder(`${ROOT}-beside`, ROOT);
	assert.equal(run.code, 1);
	assert.match(run.stderr, /is not inside TMPDIR or /);
});

test("security: a public address is given back with its port, 443 for https and 80 for http", async () => {
	assert.deepEqual(await publicAddress("https://8.8.8.8/paper.pdf"), {
		address: "8.8.8.8",
		port: "443",
	});
	assert.deepEqual(await publicAddress("http://8.8.8.8/paper.pdf"), {
		address: "8.8.8.8",
		port: "80",
	});
});

test("security: a name is refused when any address it resolves to is local, whatever the order", async () => {
	for (const addresses of [
		["8.8.8.8", "127.0.0.1"],
		["10.0.0.1", "8.8.8.8"],
	]) {
		resolved.set("papers.example", addresses);
		await assert.rejects(
			publicAddress("https://papers.example/paper.pdf"),
			(error) =>
				error instanceof FetchRefused &&
				error.message === '"papers.example" is not on the public internet',
		);
	}
});

test("security: an address holding a backslash, a space or a control character is refused", async () => {
	for (const address of [
		"http://8.8.8.8\\@127.0.0.1/",
		"http://8.8.8.8/a b",
		"http://8.8.8.8/\n",
	]) {
		await assert.rejects(publicAddress(address), FetchRefused, address);
	}
});
