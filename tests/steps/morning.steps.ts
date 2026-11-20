// The morning's scripts against a stand-in for arXiv: arxiv.ts appends the paper, sync.ts pushes the day to D1 and
// pulls it back from D1 as the deploy does, and both pages show what the build made of it.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { expect } from "@playwright/test";
import { startWorker } from "../support/cloud.ts";
import {
	Given,
	openPage,
	type Reader,
	runScript,
	Then,
	When,
} from "./world.ts";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");

// The arXiv papers the stand-in knows: title → id and the API answer it gives.
const PAPERS: Record<string, { id: string; feed: string }> = {
	"Attention Is All You Need": {
		id: "1706.03762",
		feed: "arxiv-1706.03762.xml",
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

When("the morning scripts add it and push the day", async ({ world }) => {
	const arxiv = arxivStandIn(world);
	await startWorker(world.cloud);
	const written = path.join(world.dir, "digests.js");
	const pulled = path.join(world.dir, "pulled", "digests.js");
	fs.mkdirSync(path.dirname(pulled));
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
	await runScript(world, "deploy/sync.ts", ["push", written]);
	await runScript(world, "deploy/sync.ts", ["pull", "--database", pulled]);
	world.digestsFile = pulled;
});

Then(
	/^the (public|owner's) page shows "(.*)" under today$/,
	async ({ world, browser }, which: string, title: string) => {
		const reader: Reader = which === "public" ? "visitor" : "owner";
		const page = await openPage(world, browser, reader);
		const today = page.locator(`section.day[data-date="${world.today}"]`);
		await expect.soft(today.locator(".entry__title")).toHaveText([title]);
	},
);
