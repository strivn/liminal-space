// Where each AI lab's blog figures may load from, keyed by the host of the post's own address. The scripts, the
// Worker's checks, the page and its image policy all read this list.
export const LAB_FIGURE_ADDRESSES: Readonly<Record<string, readonly string[]>> =
	{
		"openai.com": [
			"https://images.ctfassets.net/kftzwdyauwt9/",
			"https://cdn.openai.com/",
		],
		"alignment.openai.com": ["https://cdn.openai.com/"],
		"deploymentsafety.openai.com": ["https://deploymentsafety.openai.com/"],
		"www.anthropic.com": ["https://assets.claude.com/"],
		"deepmind.google": [
			"https://storage.googleapis.com/gweb-uniblog-publish-prod/",
			"https://lh3.googleusercontent.com/",
		],
		"research.google": [
			"https://storage.googleapis.com/gweb-research2023-media/",
		],
		"metr.org": ["https://metr.org/"],
		"www.goodfire.com": ["https://www.goodfire.com/"],
		"www.aisi.gov.uk": [
			"https://cdn.prod.website-files.com/663bd486c5e4c81588db7a48/",
		],
		"allenai.org": ["https://www.datocms-assets.com/64837/"],
		"sakana.ai": ["https://sakana.ai/"],
	};

// Whether src is a figure address allowed for the lab post at postUrl.
export function isLabFigure(postUrl: string, src: string): boolean {
	throw new Error(`not implemented: ${postUrl} ${src}`);
}
