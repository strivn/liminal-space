// Each lab's figure addresses, by post host.
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

export function isLabFigure(postUrl: string, src: string): boolean {
	const post = URL.parse(postUrl);
	const image = URL.parse(src);
	if (post === null || image === null) return false;
	if (image.protocol !== "https:" || image.username || image.password) {
		return false;
	}
	const allowed = Object.hasOwn(LAB_FIGURE_ADDRESSES, post.host)
		? LAB_FIGURE_ADDRESSES[post.host]
		: undefined;
	return (allowed ?? []).some((prefix) => image.href.startsWith(prefix));
}
