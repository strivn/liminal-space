// Each source the newsfeed reads, run through its reader on a response saved from that source.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { feedItems } from "../../scripts/scout/newsfeed/feed.ts";
import { releaseItems } from "../../scripts/scout/newsfeed/openrouter.ts";
import { pageItems } from "../../scripts/scout/newsfeed/page.ts";
import { closeServers, serve } from "./local-server.ts";

const FIXTURES = new URL("../fixtures/newsfeed/", import.meta.url);
const SCRIPT = new URL(
	"../../scripts/scout/newsfeed/newsfeed.ts",
	import.meta.url,
);
const run = promisify(execFile);

// A saved response from tests/fixtures/newsfeed/.
const saved = (name: string) => readFileSync(new URL(name, FIXTURES), "utf8");

afterAll(closeServers);

describe("lab and research feeds", () => {
	test("Sakana AI's Atom feed gives its posts as news entries", () => {
		const items = feedItems(
			saved("sakana-feed.xml"),
			"https://sakana.ai/feed.xml",
		);
		expect(items).toHaveLength(2);
		expect(items[0]).toMatchObject({
			title:
				"JFinBench: 最新の金融資格試験を用いた日本語金融ベンチマークの公開",
			url: "https://sakana.ai/jfinbench/",
			at: new Date("2026-11-17T00:00:00+09:00"),
		});
		expect(items[0]?.description).toMatch(/^Sakana AIは、日本の金融分野/);
	});

	test("SEA-LION's RSS feed gives its posts as news entries", () => {
		const items = feedItems(
			saved("sea-lion-feed.xml"),
			"https://sea-lion.ai/feed/",
		);
		expect(items).toHaveLength(2);
		expect(items[0]).toMatchObject({
			title:
				"Announcing SEA-LION v5: Our Largest Model & Frontier Level Performance – and Open!",
			url: "https://sea-lion.ai/blog/announcing-sea-lion-v5-our-largest-model-frontier-level-performance-and-open/",
			at: new Date("2026-11-18T04:32:24.000Z"),
			authors: ["AISG | AI Products"],
		});
		expect(items[0]?.description).toMatch(
			/^Today, we are thrilled to announce SEA-LION v5/,
		);
	});

	test("Sarvam AI's RSS feed gives its posts as news entries", () => {
		const items = feedItems(
			saved("sarvam-feed.xml"),
			"https://www.sarvam.ai/rss.xml",
		);
		expect(items).toHaveLength(2);
		expect(items[0]).toMatchObject({
			title: "Introducing Sarvam Token Factory",
			url: "https://www.sarvam.ai/blogs/sarvam-token-factory/",
			at: new Date("2026-11-16T00:00:00.000Z"),
		});
	});

	test("Ai2's RSS feed gives its posts as news entries", () => {
		const items = feedItems(
			saved("ai2-feed.xml"),
			"https://allenai.org/rss.xml",
		);
		expect(items).toHaveLength(2);
		expect(items[0]).toMatchObject({
			title: "Theorizer comes to Asta",
			url: "https://allenai.org/blog/theorizer-in-asta",
			at: new Date("2026-11-19T08:00:00.000Z"),
			description:
				"Theorizer in Asta connects scientific literature to proposed explanations that researchers can examine and test.",
		});
	});

	test("Epoch AI's Atom feed gives its posts as report entries", () => {
		const items = feedItems(
			saved("epoch-feed.xml"),
			"https://epoch.ai/atom.xml",
		);
		expect(items).toHaveLength(2);
		expect(items[0]).toMatchObject({
			title:
				"Agentic inference capacity grew 4.6× in a year, versus 2.6× for compute capacity",
			url: "https://epoch.ai/data-insights/agentic-inference-capacity-growth",
			at: new Date("2026-11-18T00:00:00.000Z"),
			authors: ["Jason Li"],
			description:
				"Our Inference Performance Index and chip sales data show agentic inference capacity grew nearly twice as much as 8-bit compute.",
		});
	});
});

describe("Chinese tech news", () => {
	test("GeekPark's RSS feed gives at most 2 stories a day, with their Chinese titles as published", async () => {
		const xml = saved("geekpark-feed.xml");
		const published = feedItems(xml, "https://www.geekpark.net/rss").map(
			(item) => item.title,
		);
		expect(published).toHaveLength(4);
		expect(published[0]).toBe("「北美大豆包」谷歌，终于杀回 AI 牌桌中央");
		// The saved stories, all dated an hour ago, so the run's two-day window keeps every one.
		const recent = new Date(Date.now() - 3600 * 1000).toUTCString();
		const today = xml.replace(
			/<pubDate>[^<]*<\/pubDate>/g,
			`<pubDate>${recent}</pubDate>`,
		);
		const base = await serve((_incoming, out) => {
			out.writeHead(200);
			out.end(today);
		});
		const dir = mkdtempSync(join(tmpdir(), "liminal-unit-geekpark-"));
		try {
			const feedsFile = join(dir, "feeds.json");
			const itemsFile = join(dir, "items.json");
			const source = {
				name: "GeekPark",
				kind: "feed",
				type: "news",
				url: `${base}/rss`,
				max: 2,
			};
			writeFileSync(feedsFile, JSON.stringify({ sources: [source] }));
			await run(process.execPath, [
				SCRIPT.pathname,
				feedsFile,
				join(dir, "digests.js"),
				itemsFile,
			]);
			const items: { title: string }[] = JSON.parse(
				readFileSync(itemsFile, "utf8"),
			);
			expect(items).toHaveLength(2);
			for (const item of items) {
				expect(published).toContain(item.title);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("lab blog pages without a feed", () => {
	test("Thinking Machines' blog page gives each post with its title, date and link", () => {
		const items = pageItems(
			saved("thinking-machines-blog.html"),
			"https://thinkingmachines.ai/blog/",
			"^https://thinkingmachines\\.ai/blog/[^/]+/$",
		);
		expect(items).toHaveLength(8);
		expect(items[0]).toMatchObject({
			title: "End‑to‑End 4‑Bit Training",
			url: "https://thinkingmachines.ai/blog/end-to-end-4-bit-training/",
			at: new Date("2026-11-13"),
		});
	});

	test("Goodfire's research page gives each dated post with its title, date and link, and leaves out the undated featured post", () => {
		const items = pageItems(
			saved("goodfire-research.html"),
			"https://www.goodfire.com/research",
			"^https://www\\.goodfire\\.com/research/[^/]+$",
		);
		expect(items).toHaveLength(47);
		expect(items[0]).toMatchObject({
			title: "Discovering Neuron Communities in Language Models",
			url: "https://www.goodfire.com/research/neuron-communities",
			at: new Date("2026-11-17"),
		});
		// The banner above the list links to the featured post with no date; the post is kept once, from its dated card.
		const featured = items.filter((item) =>
			item.url.endsWith("/research/neurons-as-an-interpretable-basis"),
		);
		expect(featured).toEqual([
			expect.objectContaining({
				title: "Neurons as an Interpretable Basis",
				at: new Date("2026-11-10"),
			}),
		]);
		expect(
			items.some((item) => item.title.includes("Read our latest research")),
		).toBe(false);
	});
});

describe("model releases from OpenRouter", () => {
	const PROVIDERS = [
		"deepseek",
		"qwen",
		"moonshotai",
		"z-ai",
		"minimax",
		"baidu",
		"tencent",
		"bytedance-seed",
		"stepfun",
		"xiaomi",
		"meituan",
		"inclusionai",
	];
	// The models the reader gives when it runs at `moment`.
	const releasedAt = (moment: string) =>
		releaseItems(
			saved("openrouter-models.json"),
			PROVIDERS,
			Date.parse(moment),
		);

	test("OpenRouter's model list gives each new model from DeepSeek, Qwen, Moonshot AI, Z.ai, MiniMax, Baidu, Tencent, ByteDance Seed, StepFun, Xiaomi, Meituan and inclusionAI as one entry, its variants included", () => {
		expect(releasedAt("2026-11-17T12:00:00Z")).toEqual([
			expect.objectContaining({
				title: "Tencent: Hy4 flash",
				url: "https://openrouter.ai/tencent/hy4-flash",
				at: new Date("2026-11-16T14:18:26Z"),
				description: expect.stringMatching(
					/^Hy4 flash is a cost-efficient variant of Hy4 from Tencent, /,
				),
			}),
			expect.objectContaining({
				title: "Qwen: Qwen4 Max",
				url: "https://openrouter.ai/qwen/qwen4-max",
			}),
		]);
		// Listed as the model and its batch variant: one entry.
		expect(releasedAt("2026-10-24T12:00:00Z")).toEqual([
			expect.objectContaining({
				title: "MoonshotAI: Kimi K3.1 Pro",
				url: "https://openrouter.ai/moonshotai/kimi-k3.1-pro",
			}),
		]);
		// Listed only as its free variant: one entry, under the base id's page.
		expect(releasedAt("2026-11-15T00:00:00Z")).toEqual([
			expect.objectContaining({
				title: "inclusionAI: Ling 3.2 Flash",
				url: "https://openrouter.ai/inclusionai/ling-3.2-flash",
			}),
		]);
	});

	test("OpenRouter's model list leaves out models from other providers", () => {
		// Two other labs released models in the same two days as DeepSeek.
		expect(releasedAt("2026-10-18T12:00:00Z").map((item) => item.url)).toEqual([
			"https://openrouter.ai/deepseek/deepseek-v4.1-flash-1017",
		]);
		// Moondream's ids start like Moonshot AI's; ~deepseek ids are aliases of models already listed.
		expect(releasedAt("2026-10-16T12:00:00Z")).toEqual([]);
		expect(releasedAt("2026-09-15T00:00:00Z")).toEqual([]);
	});
});
