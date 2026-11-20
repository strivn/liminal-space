// The contents groups of a day's entries, shared by the page's contents and the connector's get_digest.

// Hosts listed under "From the labs"; a subdomain of one counts too.
export const LAB_HOSTS: string[] = [
	"anthropic.com",
	"openai.com",
	"deepmind.google",
	"deepmindsafetyresearch.medium.com",
	"research.google",
	"ai.meta.com",
	"research.meta.ai",
	"mistral.ai",
	"transformer-circuits.pub",
	"metr.org",
	"redwoodresearch.org",
	"aisi.gov.uk",
];

// Hosts listed under "LessWrong"; a subdomain of one counts too.
export const LESSWRONG_HOSTS: string[] = [
	"lesswrong.com",
	"alignmentforum.org",
];

// The contents groups, in the order the contents list them.
export type GroupLabel = "Papers" | "From the labs" | "LessWrong" | "News";
export const GROUP_LABELS: GroupLabel[] = [
	"Papers",
	"From the labs",
	"LessWrong",
	"News",
];

// Whether `host` is one of `sites` or a subdomain of one.
function isOnSite(host: string, sites: string[]): boolean {
	return sites.some((site) => host === site || host.endsWith(`.${site}`));
}

// The fields of an entry that decide its group and its place in it; a page entry and a digest line both fit.
export type GroupedEntry = { type?: unknown; url?: unknown; ad_hoc?: unknown };

// Papers by type, every other entry by its URL's host; a missing or non-http(s) URL goes under "News".
export function entryGroup(entry: GroupedEntry): GroupLabel {
	if (entry.type === "paper") return "Papers";
	// Any value is read as text; only http(s) links count.
	const url = String(entry.url || "");
	if (!/^https?:\/\//i.test(url) || !URL.canParse(url)) return "News";
	const host = new URL(url).hostname;
	if (isOnSite(host, LAB_HOSTS)) return "From the labs";
	if (isOnSite(host, LESSWRONG_HOSTS)) return "LessWrong";
	return "News";
}

// A day's entries per group in GROUP_LABELS, each in append order with papers added ad hoc first; empty groups are
// left out.
export function contentsGroups<Entry extends GroupedEntry>(
	entries: Entry[],
): { label: GroupLabel; entries: Entry[] }[] {
	const groups = GROUP_LABELS.map((label) => ({
		label,
		entries: [] as Entry[],
	}));
	const adHocFirst = [
		...entries.filter((entry) => entry.ad_hoc === true),
		...entries.filter((entry) => entry.ad_hoc !== true),
	];
	for (const entry of adHocFirst) {
		const label = entryGroup(entry);
		groups.find((group) => group.label === label)?.entries.push(entry);
	}
	return groups.filter((group) => group.entries.length > 0);
}
