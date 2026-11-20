// The newsfeed's reader for LessWrong's GraphQL API.
import { isJsonObject } from "../../../shared/narrow.ts";
import {
	authorNames,
	download,
	type Item,
	list,
	plainText,
	ReadProblem,
	type Source,
	usableDescription,
} from "./item.ts";

const LESSWRONG_LIMITS = { frontpage: 50, offFrontpage: 200 };

// LessWrong's posts for a source's view, from its GraphQL API.
export async function lesswrongItems(source: Source): Promise<Item[]> {
	const view = source.view || "frontpage";
	const terms = `view:"${view === "frontpage" ? "frontpage" : "new"}", limit:${LESSWRONG_LIMITS[view]}`;
	const query = `{ posts(input:{terms:{${terms}}}){ results{ _id title pageUrl postedAt frontpageDate baseScore user{ displayName } tags{ name } contents{ plaintextDescription } } } }`;
	const body = await download(
		`${source.url}?query=${encodeURIComponent(query)}`,
	);
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new ReadProblem("answered with something that isn't JSON");
	}
	const results =
		isJsonObject(parsed) &&
		isJsonObject(parsed.data) &&
		isJsonObject(parsed.data.posts) &&
		parsed.data.posts.results;
	if (!Array.isArray(results)) {
		throw new ReadProblem("answered without a list of posts");
	}
	const wanted = new Set(source.tags || []);
	const minKarma = source.minKarma || 0;
	const items: Item[] = [];
	for (const post of results) {
		if (!isJsonObject(post) || typeof post.pageUrl !== "string") {
			continue;
		}
		if (typeof post.baseScore !== "number" || post.baseScore < minKarma) {
			continue;
		}
		const onFrontpage = typeof post.frontpageDate === "string";
		if (onFrontpage !== (view === "frontpage")) {
			continue;
		}
		const tags = list(post.tags).map((t) => (isJsonObject(t) ? t.name : null));
		if (
			wanted.size > 0 &&
			!tags.some((t) => typeof t === "string" && wanted.has(t))
		) {
			continue;
		}
		const at = new Date(String(post.postedAt));
		if (Number.isNaN(at.getTime())) {
			continue;
		}
		const user = isJsonObject(post.user) ? post.user.displayName : undefined;
		const contents = isJsonObject(post.contents)
			? post.contents.plaintextDescription
			: "";
		items.push({
			title: plainText(post.title),
			url: post.pageUrl,
			at: at,
			authors: authorNames(list(user)),
			description: usableDescription([contents]),
			categories: [],
			karma: post.baseScore,
		});
	}
	return items;
}
