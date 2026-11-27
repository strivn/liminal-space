// One scenario's world: its digests, its built site, the real Worker with its own D1, and a browser for each reader.
import { execFile } from "node:child_process";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
	Browser,
	BrowserContext,
	BrowserContextOptions,
	Page,
} from "@playwright/test";
import { expect } from "@playwright/test";
import { test as base, createBdd } from "playwright-bdd";
import { daysBefore, jakartaToday } from "../../scripts/lib/run-date.ts";
import type { ReadChange } from "../../shared/owner-protocol.ts";
import type { Study } from "../../shared/study-protocol.ts";
import { PHONE_QUERY } from "../../site/page/phone.ts";
import { SITE_ORIGIN } from "../fixtures/worker-in-node.ts";
import type { Cloud } from "../support/cloud.ts";
import {
	startCloud,
	startWorker,
	stopCloud,
	syncEnv,
} from "../support/cloud.ts";
import { ownerToken, postToSite } from "../support/owner.ts";

const run = promisify(execFile);
const ROOT = path.join(import.meta.dirname, "..", "..");

export const PUBLIC_PAGE = `${SITE_ORIGIN}/liminal-space/`;
export const OWNER_PAGE = `${SITE_ORIGIN}/liminal-space/owner/`;

export type Reader = "owner" | "visitor";

// A paper entry as the scripts write it.
export type Paper = {
	id: string;
	type: "paper";
	title: string;
	authors: string[];
	published: string;
	source: string;
	url: string;
	abstract: string;
	venue?: string;
	venue_source?: string;
	camera_ready?: { url: string; venue: string; from: string; doi?: string };
	openalex: {
		topics: { name: string; field: string; score: number }[];
		keywords: string[];
	};
};

// A news entry in Chinese and the words its study holds.
export type ChineseEntry = {
	entry: {
		id: string;
		type: "news";
		title: string;
		published: string;
		source: string;
		url: string;
	};
	study: Study;
};

// The main OpenAlex topic of every seeded paper.
export const OPENALEX_TOPIC = "Reinforcement learning";

export type World = {
	dir: string;
	today: string;
	yesterday: string;
	// Each day's papers in the order the digest lists them.
	days: Map<string, Paper[]>;
	// The Chinese entry today's digest ends with, and its study: built into the site, as a deploy with --study does.
	chinese: ChineseEntry | null;
	// When the last step moved the mouse onto a word, in milliseconds.
	hoveredAt: number;
	// A digests file the morning scripts wrote and pushed, used instead of `days`.
	digestsFile: string | null;
	pendingReads: ReadChange[];
	cloud: Cloud;
	server: http.Server;
	siteBuilt: boolean;
	contexts: Map<Reader, BrowserContext>;
	pages: Map<Reader, Page>;
	errors: string[];
	// Whether the owner's requests carry Access's login, and the addresses the owner's browser asked for without it.
	ownerSignedIn: boolean;
	signedOutRequests: Set<string>;
	// The window's width a Given set, before any page opened; null for the project's own. The height stays the project's.
	windowWidth: number | null;
	windowHeight: number;
	// The path of every request a browser sent to the site, in order.
	requested: string[];
	// The paper the last When step acted on, for "it" in the next step.
	paper: Paper | null;
	// What a step started that must stop when the scenario ends.
	closers: (() => Promise<void>)[];
	// Outside images, served by address.
	outsideImages: Map<string, Buffer>;
};

// The two sentences of every seeded abstract, which the highlight and comment steps select.
export const FIRST_SENTENCE = "We measure the loss on a held-out set.";
export const SECOND_SENTENCE = "It falls as the data grows.";

// The `n`th paper (from 1) of `date`; `day` keeps ids apart between days.
export function paperOn(date: string, day: number, n: number): Paper {
	const number = `2610.${String(day * 1000 + n).padStart(5, "0")}`;
	return {
		id: `arxiv:${number}`,
		type: "paper",
		title: `Paper ${n} of ${date}`,
		authors: ["Yann LeCun"],
		published: date,
		source: "arXiv Machine Learning",
		url: `https://arxiv.org/abs/${number}`,
		abstract: `${FIRST_SENTENCE} ${SECOND_SENTENCE}`,
		openalex: {
			topics: [{ name: OPENALEX_TOPIC, field: "Computer Science", score: 0.9 }],
			keywords: [],
		},
	};
}

// The `n`th paper as a proceedings or journal paper known by its DOI, with no arXiv id: `fields` replace the paper's
// id, source, page and venue.
export function paperByDoi(
	date: string,
	day: number,
	n: number,
	fields: Pick<Paper, "id" | "source" | "url" | "venue">,
): Paper {
	return { ...paperOn(date, day, n), ...fields };
}

// The date two months before `date`, on the same day of the month or the last day of a shorter month.
function twoMonthsBefore(date: string): string {
	const [year, month, day] = date.split("-").map(Number);
	const first = new Date(Date.UTC(Number(year), Number(month) - 3, 1));
	const lastDay = new Date(
		Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
	).getUTCDate();
	first.setUTCDate(Math.min(Number(day), lastDay));
	return first.toISOString().slice(0, 10);
}

// The day a step names ("today", "yesterday" or "the day 2 months ago"), as a date.
export function dateOf(world: World, day: string): string {
	if (day === "today") return world.today;
	if (day === "yesterday") return world.yesterday;
	return twoMonthsBefore(world.today);
}

// The `n`th paper (from 1) of `date`, as the world holds it.
export function nthPaper(world: World, date: string, n: number): Paper {
	const paper = world.days.get(date)?.[n - 1];
	if (paper === undefined) {
		throw new Error(`${date} has no paper ${n}`);
	}
	return paper;
}

// The folder the site is built into, which the Worker serves.
function distOf(world: World): string {
	return path.join(world.dir, "dist");
}

// A digests file with one line per day of `days`.
function seededDigests(world: World): string {
	const file = path.join(world.dir, "digests.js");
	const lines = [...world.days.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([date, entries]) => {
			const listed: object[] = [...entries];
			if (world.chinese !== null && date === world.today) {
				listed.push(world.chinese.entry);
			}
			return `digest(${JSON.stringify({ date, entries: listed })});`;
		});
	fs.writeFileSync(file, `${lines.join("\n")}\n`);
	return file;
}

// Run one of the repo's scripts with the stand-ins' addresses and test values in its environment; what it printed.
export async function runScript(
	world: World,
	script: string,
	args: string[],
	env: Record<string, string> = {},
): Promise<string> {
	const done = await run(
		process.execPath,
		[path.join(ROOT, "scripts", script), ...args],
		{
			cwd: world.dir,
			env: {
				...process.env,
				...syncEnv(world.cloud),
				LIMINAL_CACHE: path.join(world.dir, "cache"),
				...env,
			},
		},
	);
	return done.stdout;
}

// Build the site from the digests as a deploy does, serve it from the Worker, push the seeded digests to its D1 as
// sync.ts does, and save the read marks the Givens asked for.
export async function ensureSite(world: World): Promise<void> {
	if (world.siteBuilt) {
		return;
	}
	// A Worker the morning scripts already started serves the build only after a reload.
	const running = world.cloud.starting !== null;
	const digests = world.digestsFile ?? seededDigests(world);
	const studyArguments: string[] = [];
	if (world.chinese !== null) {
		const studyFile = path.join(world.dir, "study.jsonl");
		fs.writeFileSync(studyFile, `${JSON.stringify(world.chinese.study)}\n`);
		studyArguments.push("--study", studyFile);
	}
	await runScript(world, "deploy/build-site.ts", [
		...studyArguments,
		digests,
		distOf(world),
	]);
	await startWorker(world.cloud);
	if (running) {
		await world.cloud.harness?.update((options) => options);
	}
	if (world.digestsFile === null) {
		await runScript(world, "deploy/sync.ts", ["push", digests]);
	}
	world.siteBuilt = true;
	const answers = await Promise.all(
		world.pendingReads.map((change) =>
			postToSite(world.cloud, "/liminal-space/api/owner/read", change),
		),
	);
	for (const [index, answer] of answers.entries()) {
		expect(
			answer.status,
			`saving the read mark of ${world.pendingReads[index]?.id}`,
		).toBe(200);
	}
}

// A browser for `reader` whose requests to the site go to the scenario's Worker; the owner's carry Access's login.
async function contextFor(
	world: World,
	browser: Browser,
	reader: Reader,
): Promise<BrowserContext> {
	const known = world.contexts.get(reader);
	if (known !== undefined) {
		return known;
	}
	// Playwright fills in the project's device options; only a narrower window is set here.
	const options: BrowserContextOptions = {};
	if (world.windowWidth !== null) {
		options.viewport = { width: world.windowWidth, height: world.windowHeight };
	}
	const context = await browser.newContext(options);
	let token: string | null = null;
	if (reader === "owner") {
		token = await ownerToken(world.cloud);
	}
	await context.route(`${SITE_ORIGIN}/**`, async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		world.requested.push(url.pathname);
		const headers: Record<string, string> = { ...request.headers() };
		if (token !== null && world.ownerSignedIn) {
			headers["cf-access-jwt-assertion"] = token;
			headers.cookie = `CF_Authorization=${token}`;
		} else if (token !== null) {
			world.signedOutRequests.add(request.url());
		}
		const harness = world.cloud.harness;
		if (harness === null || world.cloud.workerUrl === null) {
			throw new Error("the page asked for a file before the Worker started");
		}
		const address = world.cloud.workerUrl + url.pathname + url.search;
		const body = request.postDataBuffer();
		const answer = await harness.fetch(
			address,
			body === null
				? { method: request.method(), headers }
				: { method: request.method(), headers, body: Uint8Array.from(body) },
		);
		const bytes = Buffer.from(await answer.arrayBuffer());
		await route.fulfill({
			status: answer.status,
			headers: Object.fromEntries(answer.headers),
			body: bytes,
		});
	});
	await context.route(
		(url) => world.outsideImages.has(url.href),
		(route) =>
			route.fulfill({
				status: 200,
				contentType: "image/png",
				body: world.outsideImages.get(route.request().url()) ?? "",
			}),
	);
	world.contexts.set(reader, context);
	return context;
}

// Open `reader`'s page (the owner's copy or the public one) on its Feed, and wait for today's papers to draw. A visitor
// opens on Selected unless the address says #feed; `opening` "own" leaves the address as a visitor finds it, and the
// caller waits for what it expects.
export async function openPage(
	world: World,
	browser: Browser,
	reader: Reader,
	opening: "feed" | "own" = "feed",
): Promise<Page> {
	await ensureSite(world);
	const context = await contextFor(world, browser, reader);
	const page = await context.newPage();
	page.on("console", (message) => {
		// Chrome logs the refusal of a request the owner sent signed out; the scenario checks what the page made of it.
		const refused =
			message.text().startsWith("Failed to load resource") &&
			world.signedOutRequests.has(message.location().url);
		if (message.type() === "error" && !refused) {
			world.errors.push(`${reader}: ${message.text()}`);
		}
	});
	page.on("pageerror", (error) => {
		world.errors.push(`${reader}: ${error.message}`);
	});
	let address = OWNER_PAGE;
	if (reader === "visitor")
		address = opening === "feed" ? `${PUBLIC_PAGE}#feed` : PUBLIC_PAGE;
	const response = await page.goto(address);
	// The page carries the site's policy, so a policy violation reaches the After hook as a console error.
	expect(
		response?.headers()["content-security-policy"],
		"the page's Content-Security-Policy",
	).toContain("default-src 'none'");
	if (opening === "feed")
		await expect(page.locator("article.entry").first()).toBeVisible();
	world.pages.set(reader, page);
	return page;
}

// The page `reader` has open, opened now if they have none.
export async function pageOf(
	world: World,
	browser: Browser,
	reader: Reader,
): Promise<Page> {
	return world.pages.get(reader) ?? openPage(world, browser, reader);
}

// Whether `page` lays itself out for a phone, as the page's own query decides.
export async function isPhone(page: Page): Promise<boolean> {
	return page.evaluate((query) => matchMedia(query).matches, PHONE_QUERY);
}

// Reload `reader`'s page and wait for its papers to draw again.
export async function reload(page: Page): Promise<void> {
	await page.reload();
	await expect(page.locator("article.entry").first()).toBeVisible();
}

export const test = base.extend<{ world: World }>({
	world: async ({ viewport }, use) => {
		if (viewport === null) {
			throw new Error("the project sets no window size");
		}
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "liminal-e2e-"));
		const { cloud, server } = await startCloud();
		cloud.assetsDir = path.join(dir, "dist");
		fs.mkdirSync(cloud.assetsDir);
		const today = jakartaToday();
		const world: World = {
			dir,
			today,
			yesterday: daysBefore(today, 1),
			days: new Map(),
			chinese: null,
			hoveredAt: 0,
			digestsFile: null,
			pendingReads: [],
			cloud,
			server,
			siteBuilt: false,
			contexts: new Map(),
			pages: new Map(),
			errors: [],
			ownerSignedIn: true,
			signedOutRequests: new Set(),
			windowWidth: null,
			windowHeight: viewport.height,
			requested: [],
			paper: null,
			closers: [],
			outsideImages: new Map(),
		};
		await use(world);
		for (const context of world.contexts.values()) {
			await context.close();
		}
		for (const close of world.closers) {
			await close();
		}
		await stopCloud(cloud, server);
		fs.rmSync(dir, { recursive: true, force: true });
	},
});

export const { Given, When, Then, After } = createBdd(test);

// Every scenario ends with no error logged by any page it opened.
After(async ({ world }) => {
	expect(world.errors, "errors the pages logged").toEqual([]);
});
