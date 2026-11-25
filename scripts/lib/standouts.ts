// The marked papers sync.ts writes and build-site.ts reads.
import { dirname, join } from "node:path";

// One marked paper.
export type StandoutRow = { entry: unknown; date: string; note: string };

// The file beside the digests file.
export function standoutsPath(digestsFile: string): string {
	return join(dirname(digestsFile), "digests.standouts.json");
}
