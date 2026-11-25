// The owner's marked papers as sync.ts writes them for the build, in the digests file's folder, and as build-site.ts
// reads them into data/selected.json.
import { dirname, join } from "node:path";

// One marked paper: its entry as stored, the day it was marked and its public note.
export type StandoutRow = { entry: unknown; date: string; note: string };

// Where the marked papers are: beside the digests file.
export function standoutsPath(digestsFile: string): string {
	return join(dirname(digestsFile), "digests.standouts.json");
}
