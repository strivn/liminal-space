import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { cacheFolder, failer, REPO } from "../../scripts/lib/cli.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

test("the repository folder the scripts find holds package.json", () => {
	expect(existsSync(join(REPO, "package.json"))).toBe(true);
});

test("the cache folder is LIMINAL_CACHE when it is set, and .cache in the repository when it is not", () => {
	vi.stubEnv("LIMINAL_CACHE", "/somewhere/else");
	expect(cacheFolder()).toBe("/somewhere/else");
	vi.stubEnv("LIMINAL_CACHE", "");
	expect(cacheFolder()).toBe(join(REPO, ".cache"));
});

test("a script that fails prints '<script>: <message>' and exits with code 1", () => {
	const printed = vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(process, "exit").mockImplementation((code) => {
		throw new Error(`exit ${code}`);
	});
	expect(() => failer("demo.ts")("it broke")).toThrow("exit 1");
	expect(printed).toHaveBeenCalledWith("demo.ts: it broke");
});
