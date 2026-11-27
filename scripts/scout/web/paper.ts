// Append a paper that has no arXiv id from its own metadata, once its page and DOI agree with it.
// Usage: node scripts/scout/web/paper.ts --append <digests file> [--date YYYY-MM-DD]
//        [--pick surprise --pick-source <url>] <paper json file>

// What the scout or the connector gives for one paper.
export type PaperClaim = {
	title: string;
	authors: string[];
	venue: string;
	url: string;
	doi?: string;
	abstract?: string;
};

// Each check the claim failed, as a phrase; [] when its page and DOI agree with it.
export async function claimProblems(claim: PaperClaim): Promise<string[]> {
	throw new Error(`not implemented: ${claim.url}`);
}

if (import.meta.main) {
	throw new Error("not implemented");
}
