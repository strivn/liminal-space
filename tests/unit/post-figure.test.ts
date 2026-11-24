// The lab post figure script, scripts/scout/web/post-figure.ts: listing a post's images and writing the scout's pick.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, test } from "vitest";
import { listImages } from "../../scripts/scout/web/post-figure.ts";
import { closeServers, serve, serveUnlisted } from "./local-server.ts";
import {
	digestText,
	entriesOfLine,
	removeTempFolders,
	runScript,
	scriptPath,
	tempFolder,
} from "./run-script.ts";

const SCRIPT = scriptPath("scout/web/post-figure.ts");
const POST = "https://openai.com/index/combatting-adversarial-distillation/";
const SPACE = "https://images.ctfassets.net/kftzwdyauwt9";

afterEach(closeServers);
afterAll(removeTempFolders);

// A post page: a cover in the header, a diagram with a caption in the article.
function postPage(article: string) {
	return `<!doctype html><html><body>
<header><img src="${SPACE}/logo.svg" alt="OpenAI logo"></header>
<nav><img src="${SPACE}/menu.png" alt="Menu"></nav>
<main><article>${article}</article></main>
<footer><img src="${SPACE}/footer.png" alt="Footer"></footer>
</body></html>`;
}

const ARTICLE = `<p>Distillation copies a model's behaviour through its API, and we protect against it in layers.</p>
<img src="${SPACE}/cover.webp" alt="Combatting adversarial distillation — Cover">
<figure><img src="${SPACE}/diagram.png" alt="Two layers of anti-distillation safeguards.">
<figcaption>Figure 1: Model behaviour and API protections.</figcaption></figure>`;

// A digests file holding the post, in a new temp folder.
function digestsWith(entry: Record<string, unknown>) {
	const file = join(tempFolder("post-figure-"), "digests.js");
	writeFileSync(file, `${digestText("2026-11-20", [entry])}\n`);
	return file;
}

function post(extra: Record<string, unknown> = {}) {
	return {
		id: `url:${POST}`,
		type: "news",
		title: "Combatting adversarial distillation",
		published: "2026-11-20",
		source: "OpenAI",
		url: POST,
		...extra,
	};
}

// A stand-in for openai.com serving `page`, counting requests.
async function standIn(page: string) {
	const seen = { requests: 0 };
	const base = await serve((_incoming, outgoing) => {
		seen.requests += 1;
		outgoing.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		outgoing.end(page);
	});
	return { base: base, seen: seen };
}

test("A lab post's images are listed in page order, numbered, with their alt text and caption", async () => {
	const { base } = await standIn(postPage(ARTICLE));
	const file = digestsWith(post());
	const ran = await runScript(SCRIPT, [file, POST], { LAB_PAGE_BASE: base });
	assert.equal(ran.code, 0, ran.stderr);
	assert.equal(
		ran.stdout,
		[
			`1. ${SPACE}/cover.webp`,
			"   alt: Combatting adversarial distillation — Cover",
			`2. ${SPACE}/diagram.png`,
			"   alt: Two layers of anti-distillation safeguards.",
			"   caption: Figure 1: Model behaviour and API protections.",
			"",
		].join("\n"),
	);
});

test("Images in the header, navigation, footer and sidebar are not listed", () => {
	const page = `<main><article><p>Text.</p>
<header><img src="${SPACE}/hero.png" alt="Hero"></header>
<aside><img src="${SPACE}/author.png" alt="Author"></aside>
<img src="${SPACE}/chart.png" alt="Chart">
<nav><img src="${SPACE}/next.png" alt="Next post"></nav>
<footer><img src="${SPACE}/share.png" alt="Share"></footer></article></main>`;
	assert.deepEqual(
		listImages(page, POST).map((each) => each.alt),
		["Chart"],
	);
});

test("Images are read from the article or main element that holds the most paragraph text", () => {
	const page = `<article><p>Related</p><img src="${SPACE}/related.png" alt="Related post"></article>
<article><p>The post's long body text, many words long.</p><img src="${SPACE}/plot.png" alt="Plot"></article>`;
	assert.deepEqual(
		listImages(page, POST).map((each) => each.alt),
		["Plot"],
	);
});

test("A Next.js image link is listed as the image it wraps", () => {
	const wrapped = encodeURIComponent(
		"https://cdn.openai.com/mdx-assets/a/fig.png",
	);
	const page = `<article><p>Text.</p><img src="/_next/image?url=${wrapped}&amp;w=3840&amp;q=90" alt="Probe logits"></article>`;
	assert.equal(
		listImages(page, "https://alignment.openai.com/probes/")[0]?.src,
		"https://cdn.openai.com/mdx-assets/a/fig.png",
	);
});

test("An srcset whose addresses hold commas gives its largest image whole", () => {
	const small =
		"https://substackcdn.com/image/fetch/w_424,c_limit,f_webp/https%3A%2F%2Fexample.com%2Fa.png";
	const large =
		"https://substackcdn.com/image/fetch/w_1456,c_limit,f_webp/https%3A%2F%2Fexample.com%2Fa.png";
	const page = `<article><p>Text.</p><picture><source srcset="${small} 424w, ${large} 1456w"><img src="${small}" alt="Diagram"></picture></article>`;
	assert.equal(listImages(page, POST)[0]?.src, large);
});

test("The picked image is written into the post's line with its alt text, caption and the post as where it is from", async () => {
	const { base } = await standIn(postPage(ARTICLE));
	const file = digestsWith(post());
	const ran = await runScript(SCRIPT, [file, POST, "--pick", "2"], {
		LAB_PAGE_BASE: base,
	});
	assert.equal(ran.code, 0, ran.stderr);
	const [entry] = entriesOfLine(readFileSync(file, "utf8").trim());
	assert.deepEqual(entry?.figure, {
		src: `${SPACE}/diagram.png`,
		from: POST,
		alt: "Two layers of anti-distillation safeguards.",
		caption: "Figure 1: Model behaviour and API protections.",
	});
});

test("A pick from outside the post's lab image addresses is refused and the line is left as it was", async () => {
	const { base } = await standIn(
		postPage(
			`<p>Text.</p><img src="https://images.ctfassets.net/otherspace/x.png" alt="Chart">`,
		),
	);
	const file = digestsWith(post());
	const before = readFileSync(file, "utf8");
	const ran = await runScript(SCRIPT, [file, POST, "--pick", "1"], {
		LAB_PAGE_BASE: base,
	});
	assert.equal(ran.code, 1);
	assert.match(ran.stderr, /not from the lab's image addresses/);
	assert.equal(readFileSync(file, "utf8"), before);
});

test("A post that already has a figure keeps it", async () => {
	const { base, seen } = await standIn(postPage(ARTICLE));
	const figure = { src: `${SPACE}/diagram.png`, from: POST };
	const file = digestsWith(post({ figure: figure }));
	const before = readFileSync(file, "utf8");
	const ran = await runScript(SCRIPT, [file, POST, "--pick", "1"], {
		LAB_PAGE_BASE: base,
	});
	assert.equal(ran.code, 0, ran.stderr);
	assert.match(ran.stdout, /already has a figure/);
	assert.equal(readFileSync(file, "utf8"), before);
	assert.equal(seen.requests, 0);
});

test("A post that is not from a listed lab is refused without being fetched", async () => {
	const { base, seen } = await standIn(postPage(ARTICLE));
	const url = "https://blog.redwoodresearch.org/p/a-post";
	const file = digestsWith(post({ id: `url:${url}`, url: url }));
	const ran = await runScript(SCRIPT, [file, url], { LAB_PAGE_BASE: base });
	assert.equal(ran.code, 1);
	assert.match(ran.stderr, /not from a listed lab/);
	assert.equal(seen.requests, 0);
});

test("security: a post address that resolves to a private network address is never fetched", async () => {
	let requests = 0;
	const base = await serveUnlisted((_incoming, outgoing) => {
		requests += 1;
		outgoing.end(postPage(ARTICLE));
	});
	const file = digestsWith(post());
	const ran = await runScript(SCRIPT, [file, POST], { LAB_PAGE_BASE: base });
	assert.equal(ran.code, 1);
	assert.match(ran.stderr, /not read/);
	assert.equal(requests, 0);
});
