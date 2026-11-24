// Link conference papers to their published versions, read from the proceedings files listed in interests.md.
// Usage: node scripts/scout/proceedings/camera-ready.ts <digests file>         today's papers with a venue
//        node scripts/scout/proceedings/camera-ready.ts <digests file> --all   every paper with a venue and none yet

// How a proceedings file is written.
export type ProceedingsFormat =
	| "pmlr-bib"
	| "anthology-bib"
	| "proceedings-listing"
	| "popets-index"
	| "oai-pmh"
	| "crossref";

// One paper as a proceedings file lists it.
export type PublishedPaper = { title: string; authors: string[]; url: string };

// The papers in one proceedings file, from its body and the address it was read from.
export function readProceedings(
	format: ProceedingsFormat,
	body: string,
	fileUrl: string,
): PublishedPaper[] {
	throw new Error(`not implemented: ${format} ${body.length} ${fileUrl}`);
}

// The published version of a paper, or null when no listed paper matches it.
export function matchPublished(
	paper: { title: string; authors: string[] },
	published: PublishedPaper[],
): PublishedPaper | null {
	throw new Error(`not implemented: ${paper.title} ${published.length}`);
}

if (import.meta.main) {
	throw new Error("not implemented");
}
