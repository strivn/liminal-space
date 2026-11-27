// The morning's scripts against a stand-in for arXiv: arxiv.ts appends the paper, sync.ts pushes the day to D1 and
// pulls it back from D1 as the deploy does, and both pages show what the build made of it.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { type Browser, expect } from "@playwright/test";
import { startWorker } from "../support/cloud.ts";
import {
	Given,
	openPage,
	pageOf,
	type Reader,
	runScript,
	Then,
	When,
	type World,
} from "./world.ts";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");
const SITE_ICONS = path.join(import.meta.dirname, "..", "..", "site", "icons");
const LAB_POST =
	"https://openai.com/index/combatting-adversarial-distillation/";
const LAB_IMAGES = "https://images.ctfassets.net/kftzwdyauwt9/fixture";

const NEURIPS_2017 = "https://proceedings.neurips.cc/paper_files/paper/2017";
const ATTENTION_2017 =
	"https://proceedings.neurips.cc/paper_files/paper/2017/hash/3f5ee243547dee91fbd053c1c4a845aa-Abstract.html";

// Each scenario's proceedings stand-in.
const proceedingsStandIns = new WeakMap<
	object,
	{ base: string; interests: string }
>();

// Each scenario's stand-in for OpenAI's blog.
const labStandIns = new WeakMap<object, { base: string; title: string }>();

// Listen on a free port until the scenario ends.
async function listen(world: World, server: http.Server) {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	world.closers.push(
		() => new Promise<void>((resolve) => server.close(() => resolve())),
	);
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("the stand-in has no port");
	}
	return `http://127.0.0.1:${address.port}`;
}

// The arXiv papers the stand-in knows: title → id and the API answer it gives.
const PAPERS: Record<string, { id: string; feed: string }> = {
	"Attention Is All You Need": {
		id: "1706.03762",
		feed: "arxiv-1706.03762.xml",
	},
	"Chain of Thought Monitorability: A New and Fragile Opportunity for AI Safety":
		{
			id: "2507.11473",
			feed: "arxiv-2507.11473.xml",
		},
};

// Each scenario's stand-in for arXiv's API: its address and the id it knows.
const standIns = new WeakMap<object, { url: string; id: string }>();

Given("arXiv has the paper {string}", async ({ world }, title: string) => {
	const paper = PAPERS[title];
	if (paper === undefined) {
		throw new Error(`the stand-in for arXiv has no paper "${title}"`);
	}
	const feed = fs.readFileSync(path.join(FIXTURES, paper.feed));
	const server = http.createServer((_request, response) => {
		response.writeHead(200, { "Content-Type": "application/atom+xml" });
		response.end(feed);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	world.closers.push(
		() => new Promise<void>((resolve) => server.close(() => resolve())),
	);
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("the stand-in for arXiv has no port");
	}
	standIns.set(world, {
		url: `http://127.0.0.1:${address.port}/api/query`,
		id: paper.id,
	});
});

// The scenario's stand-in for arXiv: its address and the id of the paper it knows.
export function arxivStandIn(world: object): { url: string; id: string } {
	const arxiv = standIns.get(world);
	if (arxiv === undefined) {
		throw new Error("no stand-in for arXiv was started");
	}
	return arxiv;
}

When(
	"the morning scripts add it(, without a venue,) and push the day",
	async ({ world }) => {
		const arxiv = arxivStandIn(world);
		await startWorker(world.cloud);
		const written = path.join(world.dir, "digests.js");
		const pulled = path.join(world.dir, "pulled", "digests.js");
		fs.mkdirSync(path.dirname(pulled));
		const proceedings = proceedingsStandIns.get(world);
		await runScript(
			world,
			"scout/arxiv/arxiv.ts",
			["--append", written, arxiv.id],
			{
				ARXIV_API: arxiv.url,
				ARXIV_OAI: arxiv.url,
				ARXIV_PAUSE_MS: "1",
				TMPDIR: world.dir,
				LIMINAL_ALLOW_LOCAL: new URL(arxiv.url).host,
			},
		);
		await runScript(
			world,
			"scout/proceedings/camera-ready.ts",
			[written],
			proceedings
				? {
						INTERESTS_FILE: proceedings.interests,
						PROCEEDINGS_BASE: proceedings.base,
						LIMINAL_ALLOW_LOCAL: new URL(proceedings.base).host,
					}
				: { INTERESTS_FILE: noProceedings(world) },
		);
		await runScript(world, "deploy/sync.ts", ["push", written]);
		await runScript(world, "deploy/sync.ts", ["pull", "--database", pulled]);
		world.digestsFile = pulled;
	},
);

// An interests.md that lists no proceedings, so no site is asked.
function noProceedings(world: World) {
	const interests = path.join(world.dir, "no-proceedings.md");
	fs.writeFileSync(interests, "## Proceedings\n");
	return interests;
}

Then(
	/^the (public|owner's) page shows "(.*)" under today$/,
	async ({ world, browser }, which: string, title: string) => {
		const reader: Reader = which === "public" ? "visitor" : "owner";
		const page = await openPage(world, browser, reader);
		const today = page.locator(`section.day[data-date="${world.today}"]`);
		await expect.soft(today.locator(".entry__title")).toHaveText([title]);
	},
);

Given(
	"OpenAI's blog has the post {string} with a cover image and a diagram",
	async ({ world }, title: string) => {
		const page = `<!doctype html><html><body><main><article><h1>${title}</h1>
<p>Distillation copies a model's behaviour through its API.</p>
<img src="${LAB_IMAGES}/cover.webp" alt="${title} — Cover">
<figure><img src="${LAB_IMAGES}/diagram.png" alt="Diagram of two layers of anti-distillation safeguards.">
<figcaption>Model behaviour and API protections.</figcaption></figure>
</article></main></body></html>`;
		const server = http.createServer((_request, response) => {
			response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			response.end(page);
		});
		labStandIns.set(world, { base: await listen(world, server), title });
		world.outsideImages.set(
			`${LAB_IMAGES}/diagram.png`,
			fs.readFileSync(path.join(SITE_ICONS, "openai.com.png")),
		);
	},
);

When(
	"the morning scripts add the post, the scout picks its diagram and the day is pushed",
	async ({ world }) => {
		const lab = labStandIns.get(world);
		if (lab === undefined) throw new Error("no stand-in for OpenAI's blog");
		await startWorker(world.cloud);
		const written = path.join(world.dir, "digests.js");
		const pulled = path.join(world.dir, "pulled", "digests.js");
		const items = path.join(world.dir, "items.json");
		fs.mkdirSync(path.dirname(pulled));
		fs.writeFileSync(
			items,
			JSON.stringify([
				{
					type: "news",
					title: lab.title,
					published: world.today,
					source: "OpenAI",
					url: LAB_POST,
					description: "How we protect our models from distillation.",
				},
			]),
		);
		await runScript(world, "digests/digests.ts", ["add", written, items]);
		const env = {
			LAB_PAGE_BASE: lab.base,
			LIMINAL_ALLOW_LOCAL: new URL(lab.base).host,
		};
		const listed = await runScript(
			world,
			"scout/web/post-figure.ts",
			[written, LAB_POST],
			env,
		);
		const pick = listed.match(/^(\d+)\. .*\n {3}alt: .*diagram/im)?.[1];
		if (pick === undefined) throw new Error(`no diagram listed:\n${listed}`);
		await runScript(
			world,
			"scout/web/post-figure.ts",
			[written, LAB_POST, "--pick", pick],
			env,
		);
		await runScript(world, "deploy/sync.ts", ["push", written]);
		await runScript(world, "deploy/sync.ts", ["pull", "--database", pulled]);
		world.digestsFile = pulled;
	},
);

Then(
	"the public page shows the diagram under the post's description",
	async ({ world, browser }) => {
		const page = await openPage(world, browser, "visitor");
		const post = page.locator("article.entry", { hasText: "Combatting" });
		const description = post.locator(".entry__description");
		const diagram = post.locator(".entry__figure img");
		await expect(diagram).toHaveAttribute(
			"alt",
			"Diagram of two layers of anti-distillation safeguards.",
		);
		await expect
			.poll(() =>
				diagram.evaluate((image: HTMLImageElement) => image.naturalWidth),
			)
			.toBeGreaterThan(0);
		const below =
			((await diagram.boundingBox())?.y ?? 0) >
			((await description.boundingBox())?.y ?? Number.POSITIVE_INFINITY);
		expect(below, "the diagram sits under the description").toBe(true);
	},
);

Then("the diagram opens the post", async ({ world }) => {
	const page = world.pages.get("visitor");
	if (page === undefined) throw new Error("the public page isn't open");
	await expect(page.locator("article.entry .entry__figure a")).toHaveAttribute(
		"href",
		LAB_POST,
	);
});

Given("NeurIPS 2017's proceedings list it", async ({ world }) => {
	const listing = `<ul><li class="conference" data-track="conference"><div class="paper-content">
<a title="paper title" href="${new URL(ATTENTION_2017).pathname}">Attention is All you Need</a>
<span class="paper-authors">Ashish Vaswani, Noam Shazeer, Niki Parmar</span></div></li></ul>`;
	const server = http.createServer((request, response) => {
		const found = new URL(request.url ?? "/", "http://x").pathname;
		response.writeHead(found === new URL(NEURIPS_2017).pathname ? 200 : 404);
		response.end(listing);
	});
	const interests = path.join(world.dir, "interests.md");
	fs.writeFileSync(
		interests,
		`## Proceedings\n- NeurIPS 2017: ${NEURIPS_2017}\n`,
	);
	proceedingsStandIns.set(world, {
		base: await listen(world, server),
		interests,
	});
});

// The public page's entry for a title.
async function titleLink(world: World, browser: Browser, title: string) {
	const page = await pageOf(world, browser, "visitor");
	return page.locator("article.entry", { hasText: title }).first();
}

Then(
	"its title opens its NeurIPS 2017 proceedings page, with arXiv still linked",
	async ({ world, browser }) => {
		const entry = await titleLink(world, browser, "Attention Is All You Need");
		await expect(
			entry.locator(".entry__title > a:not(.entry__arxiv)"),
		).toHaveAttribute("href", ATTENTION_2017);
		await expect(entry.locator(".entry__arxiv")).toHaveAttribute(
			"href",
			"https://arxiv.org/abs/1706.03762",
		);
	},
);

Then("its title opens its arXiv page", async ({ world, browser }) => {
	const entry = await titleLink(world, browser, "Chain of Thought");
	await expect(
		entry.locator(".entry__title > a:not(.entry__arxiv)"),
	).toHaveAttribute("href", /^https:\/\/arxiv\.org\//);
});
