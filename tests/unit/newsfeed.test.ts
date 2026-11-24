// Unit tests for the program scripts/scout/newsfeed/newsfeed.ts, run as the morning run runs it, against feed servers on 127.0.0.1
// that serve RSS, Atom and LessWrong GraphQL answers written in the tests. Nothing here contacts a real source. One run
// reads many sources at once, as the morning run does, and each rule is read off its own source's items.
import { execFile } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { closeServers, serve } from "./local-server.ts";

const SCRIPT = new URL(
	"../../scripts/scout/newsfeed/newsfeed.ts",
	import.meta.url,
);
const run = promisify(execFile);
const WORK = mkdtempSync(join(tmpdir(), "liminal-unit-newsfeed-"));
const HOUR_MS = 3600 * 1000;

// A moment `hours` ago.
const ago = (hours: number) => new Date(Date.now() - hours * HOUR_MS);

// The Asia/Jakarta date of a moment, as YYYY-MM-DD.
const jakartaDay = (moment: Date) =>
	moment.toLocaleDateString("en-CA", { timeZone: "Asia/Jakarta" });

type Post = {
	title: string;
	link?: string;
	at?: Date;
	description?: string;
	content?: string;
	author?: string;
	categories?: string[];
};

// An RSS feed of the posts. A post with no `at` has no date; one with no `link` has no link element.
function rss(posts: Post[]) {
	const items = posts.map((post) => {
		let xml = `<title>${post.title}</title>`;
		if (post.link !== undefined) {
			xml += `<link>${post.link}</link>`;
		}
		if (post.at !== undefined) {
			xml += `<pubDate>${post.at.toUTCString()}</pubDate>`;
		}
		if (post.description !== undefined) {
			xml += `<description><![CDATA[${post.description}]]></description>`;
		}
		if (post.content !== undefined) {
			xml += `<content:encoded><![CDATA[${post.content}]]></content:encoded>`;
		}
		if (post.author !== undefined) {
			xml += `<dc:creator>${post.author}</dc:creator>`;
		}
		for (const category of post.categories || []) {
			xml += `<category>${category}</category>`;
		}
		return `<item>${xml}</item>`;
	});
	return (
		'<?xml version="1.0"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
		'xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Feed</title>' +
		`${items.join("")}</channel></rss>`
	);
}

// An Atom feed of the posts.
function atom(posts: Post[]) {
	const entries = posts.map((post) => {
		let xml = `<title>${post.title}</title><link rel="alternate" href="${post.link}"/>`;
		if (post.at !== undefined) {
			xml += `<published>${post.at.toISOString()}</published>`;
		}
		if (post.description !== undefined) {
			xml += `<summary>${post.description}</summary>`;
		}
		if (post.author !== undefined) {
			xml += `<author><name>${post.author}</name></author>`;
		}
		return `<entry>${xml}</entry>`;
	});
	return `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Feed</title>${entries.join("")}</feed>`;
}

type LessWrongPost = {
	id: string;
	title: string;
	karma: number;
	postedAt?: Date;
	frontpage?: boolean;
	tags?: string[];
};

// LessWrong's GraphQL answer for the posts.
function lesswrong(posts: LessWrongPost[]) {
	const results = posts.map((post) => ({
		_id: post.id,
		title: post.title,
		pageUrl: `https://www.lesswrong.com/posts/${post.id}/slug`,
		postedAt: (post.postedAt || ago(20)).toISOString(),
		frontpageDate: post.frontpage === false ? null : "2026-10-01T00:00:00Z",
		baseScore: post.karma,
		user: { displayName: "Ada Example" },
		tags: (post.tags || []).map((name) => ({ name: name })),
		contents: { plaintextDescription: "" },
	}));
	return JSON.stringify({ data: { posts: { results: results } } });
}

// One answer of a feed server: its body, status and delay.
type Answer = { body: string; status?: number; delayMs?: number };

// A server with one path for each name in `answers`; `served` counts the requests, `inFlight` the most at once.
async function feeds(answers: Record<string, Answer>) {
	const state = { served: 0, inFlight: 0, mostInFlight: 0 };
	const base = await serve((incoming, out) => {
		state.served += 1;
		state.inFlight += 1;
		state.mostInFlight = Math.max(state.mostInFlight, state.inFlight);
		const path = (incoming.url as string).split("?")[0] as string;
		const answer = answers[path] || { status: 404, body: "" };
		setTimeout(() => {
			out.writeHead(answer.status || 200);
			out.end(answer.body);
			state.inFlight -= 1;
		}, answer.delayMs || 0);
	});
	return { base: base, state: state };
}

type Source = Record<string, unknown>;

// A feed source named `name` read from `${base}${path}`.
function feed(name: string, base: string, path: string, more: Source = {}) {
	return {
		name: name,
		kind: "feed",
		type: "news",
		url: `${base}${path}`,
		...more,
	};
}

// A page source named `name` on the stand-in's `path`, taking its links under /lab/blog/.
function page(name: string, base: string, path: string) {
	const host = base.replaceAll(".", "\\.");
	return {
		name: name,
		kind: "page",
		type: "article",
		url: `${base}${path}`,
		links: `^${host}/lab/blog/[^/]+/$`,
	};
}

// An OpenRouter source named `name` on the stand-in's `path`, keeping Qwen's models.
function models(name: string, base: string, path: string) {
	return {
		name: name,
		kind: "openrouter",
		type: "news",
		url: `${base}${path}`,
		providers: ["qwen"],
	};
}

// A LessWrong source named `name`, read from the stand-in's `path`.
function lessWrong(name: string, base: string, path: string, more: Source) {
	return {
		name: name,
		kind: "lesswrong",
		type: "article",
		url: `${base}${path}`,
		...more,
	};
}

type Item = Record<string, unknown>;
type Result = {
	code: number;
	stdout: string;
	stderr: string;
	items: Item[] | null;
	describeList: string[] | null;
};

let counter = 0;

// newsfeed.ts on the sources, with a digests file holding `digests`; the items file and describe list it wrote, each
// null for none.
async function newsfeed(sources: unknown[], digests = ""): Promise<Result> {
	counter += 1;
	const dir = join(WORK, `run-${counter}`);
	mkdirSync(dir);
	const feedsFile = join(dir, "feeds.json");
	const digestsFile = join(dir, "digests.js");
	const itemsFile = join(dir, "items.json");
	const describeFile = join(dir, "describe.txt");
	writeFileSync(feedsFile, JSON.stringify({ sources: sources }));
	writeFileSync(digestsFile, digests);
	let code = 0;
	let stdout = "";
	let stderr = "";
	try {
		const done = await run(
			process.execPath,
			[SCRIPT.pathname, feedsFile, digestsFile, itemsFile, describeFile],
			{ timeout: 60_000 },
		);
		stdout = done.stdout;
		stderr = done.stderr;
	} catch (error) {
		const failed = error as { code: number; stdout: string; stderr: string };
		code = failed.code;
		stdout = failed.stdout;
		stderr = failed.stderr;
	}
	let items: Item[] | null = null;
	if (existsSync(itemsFile)) {
		items = JSON.parse(readFileSync(itemsFile, "utf8"));
	}
	let describeList: string[] | null = null;
	if (existsSync(describeFile)) {
		describeList = readFileSync(describeFile, "utf8").trimEnd().split("\n");
	}
	return {
		code: code,
		stdout: stdout,
		stderr: stderr,
		items: items,
		describeList: describeList,
	};
}

// A digests line holding an entry with this address.
const digestWith = (url: string) =>
	`digest(${JSON.stringify({ date: "2026-10-01", entries: [{ id: `url:${url}`, type: "news", title: "Seen", authors: [], published: "2026-10-01", source: "S", url: url }] })});\n`;

const post = (title: string, extra: Partial<Post> = {}): Post => ({
	title: title,
	link: `https://example.com/p/${encodeURIComponent(title)}`,
	at: ago(20),
	...extra,
});

// A lab's blog page linking to its posts. `day` is a date within the run's window, written as pages write dates.
function blogPage(day: Date) {
	const written = day.toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
		timeZone: "UTC",
	});
	const iso = day.toISOString().slice(0, 10);
	return (
		"<html><body><ul>" +
		`<li><a href="/lab/blog/timed/"><h2>A post with a time element</h2><span>Ada Example</span><time datetime="${iso}">${written}</time></a></li>` +
		`<li><a href="https://example.com/lab/blog/elsewhere/">Another host's post ${written}</a></li>` +
		`<li><a href="/lab/blog/written/">A post with its date in the text ${written}</a></li>` +
		`<li><a href="/lab/blog/undated/">Read our latest research</a></li>` +
		`<li><a href="/lab/blog/long/">${"Long title ".repeat(40)}${written}</a></li>` +
		`<li><a href="/lab/about/">About us ${written}</a></li>` +
		"</ul></body></html>"
	);
}

const posted = ago(20);
const PROBING = "Probing for deception in small models";
const FLOCK = "Flock says its network has over 120K cameras across 49 states";

let stand: Awaited<ReturnType<typeof feeds>>;
let morning: Result;
let nothingNew: Result;
let allDescribed: Result;
let usage: { code: number; stderr: string };
let invalid: {
	second: Result;
	third: Result;
	pattern: Result;
	noTime: Result;
	textTime: Result;
	served: number;
};

const titlesOf = (source: string) =>
	(morning.items || [])
		.filter((item) => item.source === source)
		.map((item) => item.title);

beforeAll(async () => {
	const five = (prefix: string) =>
		Array.from({ length: 5 }, (_unused, n) =>
			post(`${prefix} ${n}`, { link: `https://example.com/${prefix}/${n}` }),
		);
	const mistral: Post[] = [
		...Array.from({ length: 90 }, (_unused, n) =>
			post(`Old Mistral ${n}`, { at: ago(100 + n) }),
		),
		...five("Mistral"),
	];
	stand = await feeds({
		"/af": {
			body: rss([
				post(PROBING, {
					link: "https://www.alignmentforum.org/posts/abc123/probing",
					at: posted,
					author: "Ada Example",
					description:
						"We probe small models for the intent to deceive and report what we find.",
				}),
				post("Old news", { at: ago(60) }),
				{ title: "Undated", link: "https://example.com/undated" },
				{ title: "Without a link", at: ago(20) },
				post("Seen", { link: "https://example.com/seen?utm_source=feed" }),
			]),
		},
		"/relative/feed.xml": {
			body: atom([{ title: "Relative post", link: "/posts/1/", at: posted }]),
		},
		"/atom": {
			body: atom([
				{
					title: "Atom post",
					link: "https://example.com/atom/1",
					at: posted,
					author: "Bo Sample",
					description:
						"An Atom summary that says what the post is about in words.",
				},
			]),
		},
		"/openai": {
			body: rss([
				post("Study", { categories: ["Research"] }),
				post("Launch", { categories: ["Product"] }),
			]),
		},
		"/mit": {
			body: rss([
				post("Paid", { categories: ["Artificial intelligence", "sponsored"] }),
				post("Story 1", { categories: ["Artificial intelligence"] }),
				post("Story 2", { categories: ["Artificial intelligence"] }),
				post("Other", { categories: ["Gadgets"] }),
			]),
		},
		"/nyt1": { body: rss(five("World")) },
		"/nyt2": { body: rss(five("Tech")) },
		"/mistral": { body: rss(mistral) },
		"/redwood": {
			body: rss([
				post("Heading only", {
					description: "Introduction",
					content:
						"<h2>Introduction</h2><p>In this post, we make the case that alignment needs strong conceptual reasoning.</p>",
				}),
				post("Links only", {
					description:
						"Paper: https://arxiv.org/abs/2609.35291 • Code: https://github.com/x",
				}),
				post("One word", { description: "Introduction" }),
				post("Long", {
					description: `<p>${"<b>word</b> and more words ".repeat(800)}</p>`,
				}),
				post("Usable", { description: FLOCK }),
			]),
		},
		"/lw": {
			body: lesswrong([
				{ id: "abc123", title: PROBING, karma: 90 },
				...[12, 31, 35, 40, 50, 60, 70, 80].map((karma) => ({
					id: `p${karma}`,
					title: `Karma ${karma}`,
					karma: karma,
				})),
			]),
		},
		"/lwtag": {
			body: lesswrong([
				{
					id: "t1",
					title: "Attention heads as lookup tables",
					karma: 20,
					frontpage: false,
					postedAt: ago(4 * 24),
					tags: ["Interpretability (ML & AI)"],
				},
				{
					id: "t2",
					title: "Untagged",
					karma: 20,
					frontpage: false,
					postedAt: ago(4 * 24),
					tags: ["Other"],
				},
				{
					id: "t3",
					title: "On the frontpage",
					karma: 20,
					tags: ["Interpretability (ML & AI)"],
				},
			]),
		},
		"/ft": { status: 500, body: "boom" },
		"/page": { body: "<html><body>Please log in</body></html>" },
		"/lab/blog/": { body: blogPage(posted) },
		"/json-page": { body: JSON.stringify({ posts: ["/lab/blog/x/"] }) },
		"/models": {
			body: JSON.stringify({
				data: [
					{
						id: "qwen/qwen9-max",
						name: "Qwen: Qwen9 Max",
						created: Math.floor(posted.getTime() / 1000),
						description:
							"Qwen9 Max is the flagship of the [Qwen9](https://openrouter.ai/qwen) series, for text and images.",
					},
					{
						id: "google/gemini-9",
						name: "Google: Gemini 9",
						created: Math.floor(posted.getTime() / 1000),
					},
				],
			}),
		},
		"/models-html": { body: "<html><body>Rate limited</body></html>" },
		"/models-empty": { body: JSON.stringify({ error: "busy" }) },
		"/broken-page": {
			body: '<html><body><a href="/lab/blog/open/" title="never closed><time datetime="2026-11-19">A post</time></a>',
		},
		"/slow1": { body: rss([post("Slow 1")]), delayMs: 300 },
		"/slow2": { body: rss([post("Slow 2")]), delayMs: 300 },
		"/patient": { body: rss([post("Patient 1")]), delayMs: 500 },
		"/old": {
			body: rss([post("Old news", { at: ago(60) })]),
		},
	});
	const b = stand.base;
	[morning, nothingNew] = await Promise.all([
		newsfeed(
			[
				feed("Alignment Forum", b, "/af"),
				feed("Atom Feed", b, "/atom"),
				feed("Relative Feed", b, "/relative/feed.xml"),
				feed("OpenAI", b, "/openai", { categories: ["Research", "Safety"] }),
				feed("MIT Technology Review", b, "/mit", {
					categories: ["Artificial intelligence"],
					excludeCategories: ["sponsored"],
					max: 2,
				}),
				feed("New York Times", b, "/nyt1", { max: 2 }),
				feed("New York Times", b, "/nyt2", { max: 2 }),
				feed("Mistral", b, "/mistral"),
				feed("Redwood Research", b, "/redwood"),
				lessWrong("LessWrong", b, "/lw", {
					view: "frontpage",
					minKarma: 30,
					max: 5,
				}),
				lessWrong("LessWrong Tagged", b, "/lwtag", {
					view: "offFrontpage",
					tags: ["Interpretability (ML & AI)"],
				}),
				feed("Financial Times", b, "/ft"),
				feed("Broken Feed", b, "/page"),
				feed("Slow One", b, "/slow1"),
				feed("Slow Two", b, "/slow2"),
				feed("Hasty", b, "/patient", { timeoutMs: 100 }),
				feed("Patient", b, "/patient"),
				page("Lab Blog", b, "/lab/blog/"),
				page("JSON Page", b, "/json-page"),
				page("Broken Page", b, "/broken-page"),
				models("OpenRouter", b, "/models"),
				models("OpenRouter HTML", b, "/models-html"),
				models("OpenRouter Empty", b, "/models-empty"),
			],
			digestWith("https://example.com/seen"),
		),
		newsfeed([feed("Mistral", b, "/old")]),
	]);
	allDescribed = await newsfeed([feed("Atom Feed", b, "/atom")]);
	const served = stand.state.served;
	const two = await Promise.all([
		newsfeed([
			feed("One", b, "/af"),
			{ name: "Two", kind: "feed", type: "news" },
		]),
		newsfeed([feed("One", b, "/af", { excludeCategories: "sponsored" })]),
		newsfeed([{ ...page("One", b, "/lab/blog/"), links: "(" }]),
		newsfeed([feed("One", b, "/af", { timeoutMs: 0 })]),
		newsfeed([
			feed("One", b, "/af"),
			feed("Two", b, "/af", { timeoutMs: "90000" }),
		]),
	]);
	invalid = {
		second: two[0],
		third: two[1],
		pattern: two[2],
		noTime: two[3],
		textTime: two[4],
		served: stand.state.served - served,
	};
	usage = { code: 0, stderr: "" };
	try {
		await run(process.execPath, [SCRIPT.pathname, join(WORK, "feeds.json")]);
	} catch (error) {
		usage = error as { code: number; stderr: string };
	}
}, 120_000);

afterAll(async () => {
	await closeServers();
	rmSync(WORK, { recursive: true, force: true });
});

describe("what a new item becomes", () => {
	test("a new RSS or Atom post becomes an entry with its source, author, date, description and link", () => {
		expect(
			(morning.items || []).find(
				(item) => item.title === PROBING && item.source === "Alignment Forum",
			),
		).toEqual({
			type: "news",
			title: PROBING,
			published: jakartaDay(posted),
			source: "Alignment Forum",
			url: "https://www.alignmentforum.org/posts/abc123/probing",
			authors: ["Ada Example"],
			description:
				"We probe small models for the intent to deceive and report what we find.",
		});
		expect(titlesOf("Atom Feed")).toEqual(["Atom post"]);
		expect(
			(morning.items || []).find((item) => item.source === "Atom Feed"),
		).toMatchObject({
			authors: ["Bo Sample"],
			url: "https://example.com/atom/1",
			description: "An Atom summary that says what the post is about in words.",
		});
		expect(morning.stdout).toContain(`new Alignment Forum: ${PROBING}`);
	});

	test("a post whose link is relative is linked at the feed's own address", () => {
		expect(
			(morning.items || [])
				.filter((item) => item.source === "Relative Feed")
				.map((item) => item.url),
		).toEqual([`${stand.base}/posts/1/`]);
	});

	test("a post is left out when it has no date or link, is older than two days, or is already in the digests file under a tracking address", () => {
		expect(titlesOf("Alignment Forum")).toEqual([PROBING]);
	});

	test("limit: a feed with many posts gives only the last two days' posts, and a source without a daily limit adds them all", () => {
		expect(titlesOf("Mistral")).toEqual(
			[0, 1, 2, 3, 4].map((n) => `Mistral ${n}`),
		);
	});

	test('when no source published in the last two days, the run prints "nothing new" and writes no items file', () => {
		expect(nothingNew.code).toBe(0);
		expect(nothingNew.stdout).toBe("nothing new\n");
		expect(nothingNew.items).toBeNull();
	});
});

describe("blog pages", () => {
	const fromLab = () =>
		(morning.items || []).filter((item) => item.source === "Lab Blog");

	test("a blog page's dated links under its post path become entries with their title, date and link, and no description", () => {
		expect(fromLab()).toContainEqual({
			type: "article",
			title: "A post with a time element",
			published: posted.toISOString().slice(0, 10),
			source: "Lab Blog",
			url: `${stand.base}/lab/blog/timed/`,
		});
		expect(fromLab()).toContainEqual(
			expect.objectContaining({
				title: "A post with its date in the text",
				url: `${stand.base}/lab/blog/written/`,
			}),
		);
	});

	test("a page's undated link, a link outside its post path and a link to another host are left out, and a long title is cut to 200 characters", () => {
		const urls = fromLab().map((item) => item.url);
		expect(urls).toEqual([
			`${stand.base}/lab/blog/timed/`,
			`${stand.base}/lab/blog/written/`,
			`${stand.base}/lab/blog/long/`,
		]);
		const long = fromLab()[2]?.title as string;
		expect(long.length).toBeLessThanOrEqual(200);
		expect(long.endsWith("…")).toBe(true);
	});
});

describe("model releases", () => {
	test("a new model on OpenRouter becomes a news entry with OpenRouter's name, the model's page and its description without link addresses", () => {
		expect(
			(morning.items || []).filter((item) => item.source === "OpenRouter"),
		).toEqual([
			{
				type: "news",
				title: "Qwen: Qwen9 Max",
				published: jakartaDay(posted),
				source: "OpenRouter",
				url: "https://openrouter.ai/qwen/qwen9-max",
				description:
					"Qwen9 Max is the flagship of the Qwen9 series, for text and images.",
			},
		]);
	});
});

describe("descriptions", () => {
	const described = (title: string) =>
		(morning.items || []).find((item) => item.title === title) as Item;

	test("a description that is only a heading is replaced by the post's first paragraph, and a long HTML one becomes at most 300 characters of plain text", () => {
		expect(described("Heading only").description).toBe(
			"In this post, we make the case that alignment needs strong conceptual reasoning.",
		);
		const long = described("Long").description as string;
		expect(long.length).toBeLessThanOrEqual(300);
		expect(long).not.toMatch(/[<>]/);
		expect(long.startsWith("word and more words")).toBe(true);
	});

	test("a description is used only when it holds 8 or more words once links are taken out", () => {
		expect(described("Usable").description).toBe(FLOCK);
		for (const title of ["Links only", "One word"]) {
			expect(described(title)).not.toHaveProperty("description");
		}
	});
});

describe("what is kept and what is shown once", () => {
	test("only posts in a kept category are added", () => {
		expect(titlesOf("OpenAI")).toEqual(["Study"]);
	});

	test("limit: a post in both a kept and a left-out category is left out and does not count toward the outlet's daily limit", () => {
		expect([...titlesOf("MIT Technology Review")].sort()).toEqual([
			"Story 1",
			"Story 2",
		]);
	});

	test("limit: two feeds of one outlet share its daily limit of 2 stories", () => {
		const titles = titlesOf("New York Times") as string[];
		expect(titles).toHaveLength(2);
		expect(new Set(titles).size).toBe(2);
		for (const title of titles) {
			expect(title).toMatch(/^(World|Tech) \d$/);
		}
	});

	test("limit: LessWrong adds its highest-karma posts above the karma floor up to its daily limit, and a post the Alignment Forum already gave appears once", () => {
		expect([...titlesOf("LessWrong")].sort()).toEqual([
			"Karma 40",
			"Karma 50",
			"Karma 60",
			"Karma 70",
			"Karma 80",
		]);
		expect(
			(morning.items || []).filter((item) => item.title === PROBING),
		).toHaveLength(1);
	});

	test("a LessWrong post off the frontpage arrives days later once it has a wanted tag, while untagged and frontpage posts do not", () => {
		expect(titlesOf("LessWrong Tagged")).toEqual([
			"Attention heads as lookup tables",
		]);
	});
});

describe("sources that fail, and the command line", () => {
	test("a source that fails or is not a feed is named as not read, the other sources' items are still written, and the run exits 1", () => {
		expect(morning.code).toBe(1);
		expect(morning.stderr).toContain(
			`newsfeed.ts: Financial Times (${stand.base}/ft) not read: answered HTTP 500`,
		);
		expect(morning.stderr).toContain(
			`Broken Feed (${stand.base}/page) not read: answered with something that isn't a feed`,
		);
		expect(titlesOf("Mistral")).toHaveLength(5);
	});

	test("a page source that answers with something other than HTML, or with markup whose links never close, is named as not read and the other sources' items are still written", () => {
		expect(morning.stderr).toContain(
			`JSON Page (${stand.base}/json-page) not read: answered with a page that links to no dated post`,
		);
		expect(morning.stderr).toContain(
			`Broken Page (${stand.base}/broken-page) not read: answered with a page that links to no dated post`,
		);
		expect(titlesOf("Lab Blog")).toHaveLength(3);
	});

	test("an OpenRouter source that answers with something other than JSON, or with JSON holding no list of models, is named as not read and the other sources' items are still written", () => {
		expect(morning.stderr).toContain(
			`OpenRouter HTML (${stand.base}/models-html) not read: answered with something that isn't JSON`,
		);
		expect(morning.stderr).toContain(
			`OpenRouter Empty (${stand.base}/models-empty) not read: answered without a list of models`,
		);
		expect(titlesOf("OpenRouter")).toHaveLength(1);
	});

	test("a page source whose links pattern is not a regular expression stops the run before any request", () => {
		expect(invalid.pattern.code).toBe(1);
		expect(invalid.pattern.stderr).toContain("source 1 in");
		expect(invalid.pattern.stderr).toContain(
			"links must be a regular expression, on a page source",
		);
	});

	test("the sources are read at the same time", () => {
		expect(titlesOf("Slow One")).toEqual(["Slow 1"]);
		expect(titlesOf("Slow Two")).toEqual(["Slow 2"]);
		expect(stand.state.mostInFlight).toBeGreaterThanOrEqual(2);
	});

	test("a command line with only a feeds file prints the usage line and exits non-zero", () => {
		expect(usage.code).not.toBe(0);
		expect(usage.stderr).toContain(
			"usage: node scripts/scout/newsfeed/newsfeed.ts <feeds file> <digests file> <items file>",
		);
	});

	test("a source without a URL, or an excludeCategories that is not a list, stops the run before any request and names the source", () => {
		expect(invalid.second.code).toBe(1);
		expect(invalid.second.stderr).toContain("source 2");
		expect(invalid.second.stderr).toContain("url is missing");
		expect(invalid.third.code).toBe(1);
		expect(invalid.third.stderr).toContain("source 1");
		expect(invalid.third.stderr).toContain(
			"excludeCategories must be a list of names",
		);
		expect(invalid.served).toBe(0);
		expect(invalid.second.items).toBeNull();
	});

	test("a source with its own timeoutMs waits that long for its answer, while the other sources keep the default 30 seconds", () => {
		expect(morning.stderr).toContain(
			`Hasty (${stand.base}/patient) not read: gave no answer within 0.1 seconds`,
		);
		expect(titlesOf("Hasty")).toEqual([]);
		expect(titlesOf("Patient")).toEqual(["Patient 1"]);
	});

	test("a timeoutMs that is not a whole number above 0 stops the run before any request and names the source", () => {
		expect(invalid.noTime.code).toBe(1);
		expect(invalid.noTime.stderr).toContain("source 1 in");
		expect(invalid.noTime.stderr).toContain(
			"timeoutMs must be a whole number above 0",
		);
		expect(invalid.textTime.code).toBe(1);
		expect(invalid.textTime.stderr).toContain("source 2 in");
		expect(invalid.textTime.stderr).toContain(
			"timeoutMs must be a whole number above 0",
		);
		expect(invalid.served).toBe(0);
		expect(invalid.textTime.items).toBeNull();
	});
});

describe("items left for describe.ts", () => {
	const items = () => morning.items || [];

	test("with a describe list, the run writes the link of every new item that has no description, one per line", () => {
		const bare = items()
			.filter((item) => item.description === undefined)
			.map((item) => item.url);
		expect(bare.length).toBeGreaterThan(0);
		expect(bare).toContain(`${stand.base}/lab/blog/timed/`);
		expect(morning.describeList).toEqual(bare);
	});

	test("an item with its own description is left out of the describe list, and no list is written when every item has one", () => {
		const probing = items().find((item) => item.title === PROBING);
		expect(probing?.description).toBeDefined();
		expect(morning.describeList).not.toContain(probing?.url);
		expect(allDescribed.items).toHaveLength(1);
		expect(allDescribed.describeList).toBeNull();
	});
});
