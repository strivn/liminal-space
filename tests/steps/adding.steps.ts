// Adding from Claude: the connector's add_papers on the real Worker, then the add run's scripts in add.yml's order.
import fs from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import { connectorToken, sendToWorker } from "../support/cloud.ts";
import { arxivStandIn } from "./morning.steps.ts";
import { runScript, Then, When, type World } from "./world.ts";

// What the connector answered each scenario's add.
const answers = new WeakMap<World, string>();

When("Claude adds it through the connector", async ({ world }) => {
	const call = {
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: {
			name: "add_papers",
			arguments: { ids: [arxivStandIn(world).id] },
		},
	};
	const answer = await sendToWorker(
		world.cloud,
		"POST",
		"/liminal-space/mcp",
		{
			"Content-Type": "application/json",
			"Cf-Access-Jwt-Assertion": await connectorToken(world.cloud),
		},
		JSON.stringify(call),
	);
	expect(answer.status, answer.body).toBe(200);
	const text = JSON.parse(answer.body).result?.content?.[0]?.text;
	expect(typeof text, answer.body).toBe("string");
	answers.set(world, text);
});

Then(
	"Claude is told it is queued and to check the page in a few minutes",
	({ world }) => {
		expect(answers.get(world)).toBe(
			"Queued 1 paper. Tell the user to check the page in a few minutes.",
		);
	},
);

// add.yml's steps: pull the database, handle the queue, push, report each request's result; then deploy.yml's pull,
// which the site is built from.
When("the add run carries the request out", async ({ world }) => {
	const arxiv = arxivStandIn(world);
	const digests = path.join(world.dir, "add", "digests.js");
	const results = path.join(world.dir, "add", "add-results.json");
	const pushOutput = path.join(world.dir, "add", "push-output.txt");
	const deployed = path.join(world.dir, "deploy", "digests.js");
	fs.mkdirSync(path.dirname(digests));
	fs.mkdirSync(path.dirname(deployed));
	const scripts = {
		ARXIV_API: arxiv.url,
		ARXIV_OAI: arxiv.url,
		ARXIV_HTML_BASE: `${new URL(arxiv.url).origin}/html`,
		ARXIV_HTML_STORE: path.join(world.dir, "html-store"),
		ARXIV_PAUSE_MS: "1",
		FIGURE_DELAY_MS: "0",
		TMPDIR: world.dir,
		LIMINAL_ALLOW_LOCAL: [arxiv.url, world.cloud.accessUrl]
			.map((address) => new URL(address).host)
			.join(","),
	};
	await runScript(world, "deploy/sync.ts", ["pull", "--database", digests]);
	await runScript(
		world,
		"deploy/add-requests.ts",
		["run", digests, results],
		scripts,
	);
	fs.writeFileSync(
		pushOutput,
		await runScript(world, "deploy/sync.ts", ["push", digests]),
	);
	await runScript(world, "deploy/add-requests.ts", [
		"report",
		results,
		"success",
		pushOutput,
	]);
	await runScript(world, "deploy/sync.ts", ["pull", "--database", deployed]);
	world.digestsFile = deployed;
});
