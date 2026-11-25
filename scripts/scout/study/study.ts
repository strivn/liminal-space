// Prepare the words of Chinese entries for study.
// Usage: node scripts/scout/study/study.ts <digests file> <study file>                  today's Chinese entries
//        node scripts/scout/study/study.ts <digests file> <study file> --since <date>   every Chinese entry from <date>
// The study file holds one Study per line (shared/study-protocol.ts); entries already in it are skipped.
import type { JsonObject } from "../../../shared/narrow.ts";

// At most this many entries go to the model in one run.
export const MAX_ENTRIES_PER_RUN = 10;

export type StudyRunReport = {
	studied: string[];
	refused: { id: string; problems: string[] }[];
	skipped: string[];
};

// An entry is Chinese when its title has a Han character.
export function isChinese(_entry: JsonObject): boolean {
	throw new Error("not implemented");
}

// Study the Chinese entries dated from since that the study file lacks, and append them to it.
export async function studyEntries(
	_digestsFile: string,
	_studyFile: string,
	_since: string,
): Promise<StudyRunReport> {
	throw new Error("not implemented");
}

async function main(_args: string[]): Promise<void> {
	throw new Error("not implemented");
}

if (import.meta.main) {
	await main(process.argv.slice(2));
}
