// List a lab blog post's images with their alt text and caption, and write the one the scout picks as its figure.
// Usage: node scripts/scout/web/post-figure.ts <digests file> <url>
//        node scripts/scout/web/post-figure.ts <digests file> <url> --pick <n>

// One image in a post's article body, as the scout sees it.
export type FigureCandidate = { src: string; alt: string; caption: string };

// The images in a post's article body, in page order, from its HTML and the address it was read from.
export function listImages(html: string, pageUrl: string): FigureCandidate[] {
	throw new Error(`not implemented: ${html.length} ${pageUrl}`);
}

if (import.meta.main) {
	throw new Error("not implemented");
}
