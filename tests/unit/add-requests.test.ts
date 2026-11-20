// Unit tests for scripts/deploy/add-requests.ts scriptTimeoutMs, which reads the time limit of each script a run starts from
// ADD_SCRIPT_TIMEOUT_MS: each script add-requests.ts runs has a time limit. These are the values it takes.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, expect, test, vi } from "vitest";
import {
	runScript,
	scriptTimeoutMs,
} from "../../scripts/deploy/add-requests.ts";

test("The limit is 5 minutes when ADD_SCRIPT_TIMEOUT_MS is unset or empty", () => {
	assert.equal(scriptTimeoutMs(undefined), 300000);
	assert.equal(scriptTimeoutMs(""), 300000);
});

test("A positive whole number of milliseconds is the limit", () => {
	assert.equal(scriptTimeoutMs("500"), 500);
	assert.equal(scriptTimeoutMs("1"), 1);
});

// spawnSync takes a 32-bit timer: a larger number would run with no limit at all.
test("A limit larger than a timer can hold is refused, naming ADD_SCRIPT_TIMEOUT_MS", () => {
	assert.throws(() => scriptTimeoutMs("2147483648"), /ADD_SCRIPT_TIMEOUT_MS/);
});

test.each(["0", "1.5"])(
	"A limit of %s is refused, naming ADD_SCRIPT_TIMEOUT_MS",
	(value) => {
		assert.throws(() => scriptTimeoutMs(value), /ADD_SCRIPT_TIMEOUT_MS/);
	},
);

const FOLDER = mkdtempSync(join(tmpdir(), "liminal-unit-add-requests-"));
afterAll(() => {
	rmSync(FOLDER, { recursive: true, force: true });
});

// A script file in the test's folder; the address runScript takes for it.
function scriptWith(name: string, code: string) {
	const file = join(FOLDER, name);
	writeFileSync(file, code);
	return pathToFileURL(file).href;
}

test("limit: A script that runs past its limit is stopped within seconds, and the run says it took too long", () => {
	const marker = join(FOLDER, "sleeper.pid");
	const script = scriptWith(
		"sleeper.mjs",
		`import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, String(process.pid));
await new Promise((resolve) => setTimeout(resolve, 30000));`,
	);
	const written = vi.spyOn(console, "error").mockImplementation(() => {});
	const started = Date.now();
	const ran = runScript(script, [], 500);
	const said = written.mock.calls.map((call) => String(call[0]));
	written.mockRestore();
	expect(ran.timedOut).toBe(true);
	expect(Date.now() - started).toBeLessThan(10_000);
	expect(said.join("\n")).toContain("took longer than 500 ms and was stopped");
	// The script's process no longer exists: signal 0 only asks whether it does.
	expect(() => process.kill(Number(readFileSync(marker, "utf8")), 0)).toThrow(
		/ESRCH/,
	);
});

test("privacy: A script is run without the sync token or Cloudflare's token in its environment", () => {
	const names = [
		"ACCESS_SYNC_ID",
		"ACCESS_SYNC_SECRET",
		"CLOUDFLARE_API_TOKEN",
	];
	for (const name of names) {
		vi.stubEnv(name, "secret-value");
	}
	vi.stubEnv("LIMINAL_PLAIN", "kept");
	const script = scriptWith(
		"env.mjs",
		`console.log(JSON.stringify([${JSON.stringify(names)}.map((name) => process.env[name] ?? null), process.env.LIMINAL_PLAIN]));`,
	);
	const ran = runScript(script, [], 20_000);
	vi.unstubAllEnvs();
	expect(JSON.parse(ran.stdout)).toEqual([[null, null, null], "kept"]);
});
