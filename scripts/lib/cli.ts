// What the programs share: the repository folder, the cache folder and the one-line failure exit.
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The folder above scripts/, found from this file's real location, so any working folder works.
export const REPO = dirname(
	dirname(dirname(realpathSync(fileURLToPath(import.meta.url)))),
);

// LIMINAL_CACHE (tests point it elsewhere), else .cache/ in the repo; read at call time.
export function cacheFolder(): string {
	return process.env.LIMINAL_CACHE || join(REPO, ".cache");
}

// The type a program gives its `fail`, so the compiler knows code after a call is unreachable.
export type Fail = (message: string) => never;

// A program's "stop with a one-line explanation instead of a stack trace".
export function failer(script: string): Fail {
	return (message) => {
		console.error(`${script}: ${message}`);
		process.exit(1);
	};
}
