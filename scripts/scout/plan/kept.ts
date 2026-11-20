// Reading and writing the search plan's kept files in the cache folder.
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { errorCode, isJsonObject } from "../../../shared/narrow.ts";
import { cacheFolder } from "../../lib/cli.ts";

// Kept answers (lookups.json) and list copies (lists.json); .cache/ is gitignored.
const CACHE = cacheFolder();

// One kept file of the cache folder as an object; {} when there is none yet, or when it doesn't load, which is named
// on stderr: the run goes on without it and writes a fresh one.
export function readKept(name: string): Record<string, unknown> {
	const file = join(CACHE, name);
	if (!existsSync(file)) {
		return {};
	}
	try {
		const data: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (isJsonObject(data)) {
			return data;
		}
	} catch {
		// named below, like a file that loads but isn't an object
	}
	console.error(`search.ts: ${file} doesn't load; this run goes on without it`);
	return {};
}

// Write one kept file; true when it was written. One that can't be written only costs the next run a download or a
// lookup, so it is named on stderr and the run goes on.
export function writeKept(
	name: string,
	data: Record<string, unknown>,
): boolean {
	const file = join(CACHE, name);
	// Written beside it, then renamed over it: a run stopped mid-write leaves the old file whole, never half of the new
	// one. The rename replaces the file in one step.
	const partial = `${file}.partial`;
	try {
		mkdirSync(CACHE, { recursive: true });
		writeFileSync(partial, `${JSON.stringify(data, null, 1)}\n`);
		renameSync(partial, file);
		return true;
	} catch (error) {
		console.error(`search.ts: can't write ${file} (${errorCode(error)})`);
		return false;
	}
}
