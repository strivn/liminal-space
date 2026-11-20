// arXiv ids, with nothing from Node, so the Worker's add_papers and scripts/scout/arxiv/arxiv.ts read an id the same way.
// Formats: https://info.arxiv.org/help/arxiv_identifier.html

// Since April 2007: "2507.11473" (year and month, a dot, 4 or 5 digits).
const NEW_STYLE_ID = /^\d{4}\.\d{4,5}$/;
// Until March 2007: "hep-th/9901001" or "math.GT/0309136": the archive (letters, with single hyphens between words),
// an optional subject class, a slash and 7 digits. "--/1234567" or "-a/1234567" is no archive.
const OLD_STYLE_ID = /^[a-z]+(-[a-z]+)*(\.[A-Z]{2})?\/\d{7}$/;

// " arXiv:2507.11473v2 " -> "2507.11473": spaces around it, an "arxiv:" prefix in any case, and the version go.
export function normalizeId(id: string): string {
	return id
		.trim()
		.replace(/^arxiv:/i, "")
		.replace(/v\d+$/, "");
}

// True when a normalized id has one of arXiv's two id formats.
export function isArxivId(id: string): boolean {
	return NEW_STYLE_ID.test(id) || OLD_STYLE_ID.test(id);
}
