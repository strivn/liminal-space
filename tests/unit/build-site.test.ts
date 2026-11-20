// Unit tests for scripts/deploy/build-site.ts's versioned addresses: a browser keeps app.js, style.css, KaTeX and the fonts for a year, so every
// address the page and its stylesheets use for them must change when, and only when, the file behind it changes.
// The script runs on a copy of site/ (LIMINAL_SITE), built twice, the second time after one change.

import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, test } from "vitest";
import { digestFiles, siteData } from "../../scripts/deploy/build-site.ts";
import { closeServers, serve } from "./local-server.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPT = path.join(ROOT, "scripts", "deploy", "build-site.ts");

const folders: string[] = [];
afterEach(closeServers);
afterEach(() => {
	for (const folder of folders.splice(0)) {
		fs.rmSync(folder, { recursive: true, force: true });
	}
});

// A copy of site/ without its digests and figures, a digests file with one line, and a build of them.
function siteCopy() {
	const folder = fs.mkdtempSync(path.join(os.tmpdir(), "liminal-build-test-"));
	folders.push(folder);
	const site = path.join(folder, "site");
	fs.cpSync(path.join(ROOT, "site"), site, {
		recursive: true,
		filter: (source) => !/(digests[^/]*\.js|figures)$/.test(source),
	});
	const digests = path.join(folder, "digests.js");
	fs.writeFileSync(digests, 'digest({"date":"2026-11-01","entries":[]});\n');
	return { site: site, digests: digests, dist: path.join(folder, "dist") };
}

// Build the copy and return the addresses its page, its stylesheet and KaTeX's stylesheet use, each file's in order.
function build(copy: ReturnType<typeof siteCopy>) {
	execFileSync(process.execPath, [SCRIPT, copy.digests, copy.dist], {
		env: { ...process.env, LIMINAL_SITE: copy.site },
	});
	const page = path.join(copy.dist, "liminal-space");
	const read = (file: string) => fs.readFileSync(path.join(page, file), "utf8");
	return {
		html: [...read("index.html").matchAll(/(?:href|src)="([^"]+)"/g)].map(
			(match) => match[1] || "",
		),
		style: [...read("style.css").matchAll(/url\(([^)]+)\)/g)].map(
			(match) => match[1] || "",
		),
		katex: [...read("katex/katex.min.css").matchAll(/url\(([^)]+)\)/g)].map(
			(match) => match[1] || "",
		),
	};
}

// The addresses that differ between two builds' lists, as "before -> after".
function changed(before: string[], after: string[]) {
	assert.equal(before.length, after.length);
	return before
		.map((address, at) => `${address} -> ${after[at]}`)
		.filter((_pair, at) => before[at] !== after[at]);
}

test("a changed KaTeX font gets a new address, and so does the KaTeX stylesheet naming it", () => {
	const copy = siteCopy();
	const before = build(copy);
	fs.appendFileSync(
		path.join(copy.site, "katex", "fonts", "KaTeX_Main-Regular.woff2"),
		"x",
	);
	const after = build(copy);
	const fonts = changed(before.katex, after.katex);
	assert.equal(fonts.length, 1, fonts.join("\n"));
	assert.match(
		fonts[0] || "",
		/^fonts\/KaTeX_Main-Regular\.woff2\?v=\w{12} -> fonts\/KaTeX_Main-Regular\.woff2\?v=\w{12}$/,
	);
	const page = changed(before.html, after.html);
	assert.equal(page.length, 1, page.join("\n"));
	assert.match(page[0] || "", /^katex\/katex\.min\.css\?v=/);
	assert.deepEqual(changed(before.style, after.style), []);
});

test("a changed page font gets a new address, and so does style.css naming it", () => {
	const copy = siteCopy();
	const before = build(copy);
	fs.appendFileSync(
		path.join(copy.site, "fonts", "Manrope-Variable-latin.woff2"),
		"x",
	);
	const after = build(copy);
	assert.equal(changed(before.style, after.style).length, 1);
	// The page's font preload changes with the font and stays the address style.css asks for, so the preload is used.
	const page = changed(before.html, after.html);
	assert.equal(page.length, 2, page.join("\n"));
	assert.match(page[0] || "", /^fonts\/Manrope-Variable-latin\.woff2\?v=/);
	assert.match(page[1] || "", /^style\.css\?v=/);
	const preload = after.html.find((address) =>
		address.includes("Manrope-Variable-latin"),
	);
	assert.ok(preload);
	assert.ok(after.style.includes(preload), preload);
	assert.deepEqual(changed(before.katex, after.katex), []);
});

// The address app.js's import() asks for the Markdown renderer at, in the built page.
function rendererAddress(copy: ReturnType<typeof siteCopy>) {
	build(copy);
	const script = fs.readFileSync(
		path.join(copy.dist, "liminal-space", "app.js"),
		"utf8",
	);
	return script.match(
		/import\("(\.\/claude-markdown\.js\?v=[0-9a-f]{12})"\)/,
	)?.[1];
}

test("the built page loads the Markdown renderer at an address that changes with its contents", () => {
	const copy = siteCopy();
	const before = rendererAddress(copy);
	assert.ok(before, "app.js imports claude-markdown.js?v=<12 hex digits>");
	fs.appendFileSync(
		path.join(copy.site, "claude-markdown.js"),
		"\n// changed\n",
	);
	const after = rendererAddress(copy);
	assert.ok(after, "app.js still imports claude-markdown.js?v=<12 hex digits>");
	assert.notEqual(after, before);
});

test("the built site holds the Claude icon", () => {
	const copy = siteCopy();
	build(copy);
	const built = path.join(copy.dist, "liminal-space", "claude-sonnet.svg");
	assert.ok(fs.existsSync(built), "the build copied claude-sonnet.svg");
	assert.equal(
		fs.readFileSync(built, "utf8"),
		fs.readFileSync(path.join(copy.site, "claude-sonnet.svg"), "utf8"),
	);
});

// The staging strip shows the commit it names, so the option takes a commit id and nothing else
// that could reach the page's HTML.
test("security: --staging refuses anything but a commit id, and builds nothing", () => {
	const copy = siteCopy();
	for (const commit of ['<b onmouseover="x">', "develop", "5ec760"]) {
		let failure = "";
		try {
			execFileSync(
				process.execPath,
				[SCRIPT, "--staging", commit, copy.digests, copy.dist],
				{
					env: { ...process.env, LIMINAL_SITE: copy.site },
					stdio: "pipe",
				},
			);
		} catch (error) {
			failure = String((error as { stderr?: Buffer }).stderr);
		}
		assert.match(
			failure,
			/--staging takes a commit id/,
			`the refusal for ${commit}`,
		);
		assert.equal(fs.existsSync(copy.dist), false, `a build for ${commit}`);
	}
});

// Build the copy, as staging's when a commit is given; the built folder.
function builtFolder(copy: ReturnType<typeof siteCopy>, commit?: string) {
	let staging: string[] = [];
	if (commit !== undefined) staging = ["--staging", commit];
	execFileSync(
		process.execPath,
		[SCRIPT, ...staging, copy.digests, copy.dist],
		{ env: { ...process.env, LIMINAL_SITE: copy.site } },
	);
	return copy.dist;
}

// The headers Cloudflare gives each file the build serves, by its address, from every _headers rule that matches it.
function servedHeaders(dist: string) {
	const rules: { path: RegExp; headers: string[] }[] = [];
	for (const line of fs
		.readFileSync(path.join(dist, "_headers"), "utf8")
		.split("\n")) {
		if (/^\S/.test(line)) {
			const pattern = line
				.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
				.replaceAll("*", ".*");
			rules.push({ path: new RegExp(`^${pattern}$`), headers: [] });
		} else if (line.trim() !== "") {
			rules.at(-1)?.headers.push(line.trim());
		}
	}
	const served: Record<string, string[]> = {};
	for (const file of fs.readdirSync(dist, {
		recursive: true,
		withFileTypes: true,
	})) {
		const relative = path.relative(dist, path.join(file.parentPath, file.name));
		if (!file.isFile() || ["_headers", "_redirects"].includes(relative))
			continue;
		const address = `/${relative.split(path.sep).join("/")}`;
		served[address] = rules
			.filter((rule) => rule.path.test(address))
			.flatMap((rule) => rule.headers);
	}
	return served;
}

// Whether robots.txt lets a robot read an address: its own group or else "*", and the longest matching rule wins.
function robotMayRead(robots: string, agent: string, address: string) {
	const groups: { agents: string[]; rules: [boolean, string][] }[] = [];
	let readingAgents = false;
	for (const line of robots.split("\n")) {
		const [field = "", ...rest] = line.split(":");
		const value = rest.join(":").trim();
		if (field === "User-agent") {
			if (!readingAgents) groups.push({ agents: [], rules: [] });
			groups.at(-1)?.agents.push(value);
			readingAgents = true;
		} else if (field === "Allow" || field === "Disallow") {
			groups.at(-1)?.rules.push([field === "Allow", value]);
			readingAgents = false;
		}
	}
	const group =
		groups.find((each) => each.agents.includes(agent)) ||
		groups.find((each) => each.agents.includes("*"));
	const matching = (group?.rules || [])
		.filter(([, prefix]) => prefix !== "" && address.startsWith(prefix))
		.sort((a, b) => b[1].length - a[1].length || Number(b[0]) - Number(a[0]));
	return matching[0]?.[0] ?? true;
}

test("security: a staging build's robots.txt keeps every robot off every address and names no sitemap, and every file is served with noindex", () => {
	const dist = builtFolder(siteCopy(), "5ec760d");
	const robots = fs.readFileSync(path.join(dist, "robots.txt"), "utf8");
	for (const agent of ["Googlebot", "GPTBot", "Claude-User", "ChatGPT-User"]) {
		for (const address of [
			"/liminal-space/",
			"/liminal-space/digests/2026-11-01.md",
			"/liminal-space/data/index.json",
		]) {
			assert.equal(
				robotMayRead(robots, agent, address),
				false,
				`${agent} reads ${address}`,
			);
		}
	}
	assert.doesNotMatch(robots, /Sitemap:/);
	assert.equal(
		fs.existsSync(path.join(dist, "liminal-space", "sitemap.xml")),
		false,
	);
	for (const [address, headers] of Object.entries(servedHeaders(dist))) {
		assert.ok(
			headers.includes("X-Robots-Tag: noindex"),
			`${address} is served with noindex`,
		);
	}
});

test("security: every file of a public or a staging build is served with nosniff, HSTS and a Referrer-Policy", () => {
	for (const commit of [undefined, "5ec760d"]) {
		const served = servedHeaders(builtFolder(siteCopy(), commit));
		assert.ok(Object.keys(served).length > 10, "the build serves its files");
		for (const [address, headers] of Object.entries(served)) {
			for (const header of [
				"X-Content-Type-Options: nosniff",
				"Strict-Transport-Security: max-age=31536000",
				"Referrer-Policy: strict-origin-when-cross-origin",
			]) {
				assert.ok(
					headers.includes(header),
					`${address} (${commit || "public"}) has ${header}`,
				);
			}
		}
	}
});

// The key Claude's replies are paid with lives in the Worker alone, so a file the build would
// publish that holds one stops the build, whatever the file is.
test("privacy: the build fails when any published file holds an Anthropic API key", () => {
	const key = "sk-ant-api03-0123456789abcdefABCDEF_-0123456789abcdef";
	for (const file of ["app.js", "katex/katex.min.css", "fonts/NOTICE.txt"]) {
		const copy = siteCopy();
		// The file is one the page's own folders hold, or a new one in them.
		const planted = path.join(copy.site, file);
		fs.mkdirSync(path.dirname(planted), { recursive: true });
		fs.appendFileSync(planted, `\n/* ${key} */\n`);

		let failure = "";
		try {
			execFileSync(process.execPath, [SCRIPT, copy.digests, copy.dist], {
				env: { ...process.env, LIMINAL_SITE: copy.site },
				stdio: "pipe",
			});
		} catch (error) {
			failure = String((error as { stderr?: Buffer }).stderr);
		}
		assert.match(failure, /Anthropic API key/, `the refusal for ${file}`);
		assert.match(failure, /liminal-space\//, `the published file for ${file}`);
		assert.ok(!failure.includes(key), `the key is not repeated for ${file}`);
		assert.equal(fs.existsSync(copy.dist), false, `a build with ${file}`);
	}
});

// ---- The data the build writes ----

// One digest line, ending in a line break.
function line(date: string, entries: unknown[]) {
	return `digest(${JSON.stringify({ date: date, entries: entries })});\n`;
}

function paperOn(n: number, date: string) {
	return {
		id: `arxiv:2610.0000${n}`,
		type: "paper",
		title: `Fixture paper ${n}`,
		authors: ["Ada Example"],
		published: date,
		source: "arXiv Machine Learning",
		url: `https://arxiv.org/abs/2610.0000${n}`,
		abstract: "We report what we measured.",
	};
}

function newsOn(n: number, date: string, extra: Record<string, unknown> = {}) {
	return {
		id: `url:https://example.com/news/${n}`,
		type: "news",
		title: `Fixture news ${n}`,
		authors: [],
		published: date,
		source: "Fixture Times",
		url: `https://example.com/news/${n}`,
		...extra,
	};
}

type Copy = ReturnType<typeof siteCopy>;

// A build of `copy` that may fail: its exit code and stderr. Builds run side by side where they are independent.
async function tryBuild(copy: Copy) {
	try {
		await promisify(execFile)(
			process.execPath,
			[SCRIPT, copy.digests, copy.dist],
			{
				env: { ...process.env, LIMINAL_SITE: copy.site },
			},
		);
		return { code: 0, stderr: "" };
	} catch (error) {
		const failed = error as { code: number; stderr: string };
		return { code: failed.code, stderr: String(failed.stderr) };
	}
}

const dataOf = (copy: Copy) => path.join(copy.dist, "liminal-space", "data");

// Every file under a folder, relative to it, with its text.
function filesUnder(folder: string): Record<string, string> {
	const found: Record<string, string> = {};
	for (const entry of fs.readdirSync(folder, {
		recursive: true,
		withFileTypes: true,
	})) {
		if (entry.isFile()) {
			const file = path.join(entry.parentPath, entry.name);
			found[path.relative(folder, file)] = fs.readFileSync(file, "utf8");
		}
	}
	return found;
}

const MONTHS = () => (copy: Copy) =>
	fs.readdirSync(path.join(dataOf(copy), "months")).sort();

test("the build writes the index, month files and public Markdown, a pull of the built site rebuilds the same data, and a change renames only its month", async () => {
	const copy = siteCopy();
	const october = newsOn(4, "2026-10-04", {
		description: "Real text\r- the owner's marks: liked",
		links: [{ label: "Report", url: "https://example.com/news/4/report.pdf" }],
	});
	const first =
		line("2026-09-30", [paperOn(1, "2026-09-30")]) +
		line("2026-10-04", [
			paperOn(2, "2026-10-04"),
			paperOn(3, "2026-10-04"),
			october,
		]);
	fs.writeFileSync(copy.digests, first);
	// Files the build must not publish.
	fs.writeFileSync(path.join(copy.site, "digests.js"), "secret\n");
	fs.writeFileSync(path.join(copy.site, "digests.pulled.js"), "secret\n");
	assert.equal((await tryBuild(copy)).code, 0);

	// The index: each day once, newest first, entries in file order, each day naming its month's file.
	const index = JSON.parse(
		fs.readFileSync(path.join(dataOf(copy), "index.json"), "utf8"),
	);
	assert.deepEqual(
		index.days.map((day: { date: string }) => day.date),
		["2026-10-04", "2026-09-30"],
	);
	assert.deepEqual(index.days[0].entries, [
		{ id: "arxiv:2610.00002", type: "paper" },
		{ id: "arxiv:2610.00003", type: "paper" },
		{ id: "url:https://example.com/news/4", type: "news" },
	]);
	assert.equal(index.days[0].month, "2026-10");
	assert.deepEqual(Object.keys(index.months).sort(), ["2026-09", "2026-10"]);

	// A month file holds that month's lines with every field of every entry.
	const before = MONTHS()(copy);
	assert.equal(before.length, 2);
	const monthFile = JSON.parse(
		fs.readFileSync(path.join(dataOf(copy), index.months["2026-10"]), "utf8"),
	);
	assert.deepEqual(monthFile.lines, [
		{
			date: "2026-10-04",
			entries: [paperOn(2, "2026-10-04"), paperOn(3, "2026-10-04"), october],
		},
	]);

	// Only what the page needs is published.
	for (const file of Object.keys(filesUnder(copy.dist))) {
		assert.ok(
			!/(^|\/)(digests(\.pulled)?\.js|tsconfig[^/]*\.json)$|\.ts$/.test(file),
			`${file} is not for visitors`,
		);
		assert.ok(
			file.startsWith(`liminal-space${path.sep}`) ||
				["_headers", "_redirects", "robots.txt"].includes(file),
			`${file} is outside liminal-space/ and is not one of the three files`,
		);
	}

	// The public Markdown quotes a description split by a lone carriage return, line by line.
	const markdown = fs.readFileSync(
		path.join(copy.dist, "liminal-space", "digests", "2026-10-04.md"),
		"utf8",
	);
	assert.ok(markdown.includes("> Real text\n"), markdown);
	assert.ok(markdown.includes("> - the owner's marks: liked"), markdown);
	assert.ok(
		!markdown
			.split("\n")
			.some((each) => each.startsWith("- the owner's marks")),
		"no line of the Markdown starts as the entry's text did",
	);

	// Pulling the built site gives a digests file that builds the same data.
	const site = await serve((incoming, out) => {
		const file = path.join(
			copy.dist,
			"liminal-space",
			new URL(incoming.url as string, "http://stand-in.test").pathname,
		);
		if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
			out.writeHead(404);
			out.end();
			return;
		}
		out.end(fs.readFileSync(file));
	});
	const pulled = siteCopy();
	await promisify(execFile)(
		process.execPath,
		[path.join(ROOT, "scripts", "deploy", "sync.ts"), "pull", pulled.digests],
		{ env: { ...process.env, LIMINAL_URL: site } },
	);
	assert.equal((await tryBuild(pulled)).code, 0);
	assert.deepEqual(filesUnder(dataOf(pulled)), filesUnder(dataOf(copy)));

	// A rebuild after a new October line renames October's file only, and leaves no file of the earlier build.
	fs.writeFileSync(
		copy.digests,
		first + line("2026-10-05", [paperOn(4, "2026-10-05")]),
	);
	assert.equal((await tryBuild(copy)).code, 0);
	const after = MONTHS()(copy);
	assert.equal(after[0], before[0], "September's file keeps its name");
	assert.notEqual(after[1], before[1], "October's file has a new name");
	assert.equal(after.length, 2, "the earlier October file is gone");
});

test("an empty digests file builds an empty index, lines of one date make one day, and a bad line or date stops the build and keeps the earlier one", async () => {
	const empty = siteCopy();
	fs.writeFileSync(empty.digests, "");
	const joined = siteCopy();
	fs.writeFileSync(
		joined.digests,
		line("2026-10-04", [paperOn(2, "2026-10-04")]) +
			line("2026-10-04", [paperOn(3, "2026-10-04"), newsOn(4, "2026-10-04")]),
	);
	const earlier = siteCopy();
	assert.equal((await tryBuild(earlier)).code, 0);
	const kept = filesUnder(earlier.dist);

	const broken = [
		["not a digest line", "doesn't load"],
		["a date that climbs out of the folder", "../../../escaped"],
		["a month that doesn't exist", "2026-13-01"],
		["a day without its leading zero", "2026-10-4"],
	];
	const copies = broken.map(() => {
		const copy = siteCopy();
		return copy;
	});
	copies[0] && fs.cpSync(earlier.dist, copies[0].dist, { recursive: true });
	broken.forEach(([, value], k) => {
		const copy = copies[k] as Copy;
		const text =
			value === "doesn't load"
				? "not a digest line\n"
				: line(value as string, [paperOn(2, "2026-10-04")]);
		fs.writeFileSync(
			copy.digests,
			line("2026-09-30", [paperOn(1, "2026-09-30")]) + text,
		);
	});
	const [emptied, merged, ...failed] = await Promise.all(
		[empty, joined, ...copies].map((copy) => tryBuild(copy)),
	);
	assert.equal(emptied?.code, 0);
	assert.equal(merged?.code, 0);
	// Several lines of one date are one day in the index, its entries in file order.
	const days = JSON.parse(
		fs.readFileSync(path.join(dataOf(joined), "index.json"), "utf8"),
	).days;
	assert.deepEqual(
		days.map((day: { date: string; entries: unknown[] }) => [
			day.date,
			day.entries.length,
		]),
		[["2026-10-04", 3]],
	);
	const index = JSON.parse(
		fs.readFileSync(path.join(dataOf(empty), "index.json"), "utf8"),
	);
	assert.deepEqual(index.days, []);
	assert.deepEqual(fs.readdirSync(path.join(dataOf(empty), "months")), []);

	failed.forEach((result, k) => {
		const what = broken[k]?.[0] ?? "";
		const value = broken[k]?.[1] ?? "";
		assert.notEqual(result.code, 0, what);
		assert.match(result.stderr, /line 2/, what);
		if (value !== "doesn't load") {
			assert.match(result.stderr, /YYYY-MM-DD/, what);
		}
		assert.equal(
			fs.existsSync(
				path.join(path.dirname((copies[k] as Copy).dist), "escaped.md"),
			),
			false,
			what,
		);
	});
	// The earlier build in the first failed copy's dist is as it was.
	assert.deepEqual(filesUnder((copies[0] as Copy).dist), kept);
});

// ---- The Markdown digests the build writes for agents ----

// A digests file line for one day.
function digestLine(date: string, entries: object[]): string {
	return `digest(${JSON.stringify({ date: date, entries: entries })});`;
}

const SCIENTIST_AI = {
	id: "arxiv:2610.00001",
	type: "paper",
	title: "Scientist AI",
	authors: ["Yoshua Bengio", "Yann LeCun"],
	published: "2026-10-20",
	source: "arXiv",
	url: "https://arxiv.org/abs/2610.00001",
	links: [{ label: "PDF", url: "https://arxiv.org/pdf/2610.00001" }],
	abstract: "We build an agent that is honest by design. $O(n^2)$ attention.",
};
const SYSTEM_CARD = {
	id: "url:https://example.com/gemini-3-system-card",
	type: "report",
	title: "Gemini 3 system card",
	authors: [],
	published: "2026-10-20",
	source: "Example Labs",
	url: "https://example.com/gemini-3-system-card",
	description: "The model card for Gemini 3, with its safety evaluations.",
};

test("the build writes one Markdown file a day and an index, and nothing else", () => {
	const files = digestFiles(
		siteData(
			[
				digestLine("2026-10-19", [{ ...SCIENTIST_AI, id: "arxiv:2610.00009" }]),
				digestLine("2026-10-20", [SCIENTIST_AI, SYSTEM_CARD]),
			].join("\n"),
		),
	);
	assert.deepEqual([...files.keys()].sort(), [
		"2026-10-19.md",
		"2026-10-20.md",
		"index.md",
	]);
});

test("a day's file holds every entry of that day, a paper with its authors, links, arXiv id and whole abstract", () => {
	const files = digestFiles(
		siteData(digestLine("2026-10-20", [SCIENTIST_AI, SYSTEM_CARD])),
	);
	const day = files.get("2026-10-20.md") ?? "";
	assert.ok(day.includes("Scientist AI"), day);
	assert.ok(day.includes("Gemini 3 system card"), day);
	assert.ok(day.includes("Yoshua Bengio"), day);
	assert.ok(day.includes("https://arxiv.org/pdf/2610.00001"), day);
	assert.ok(day.includes("arxiv:2610.00001"), day);
	assert.ok(day.includes(SCIENTIST_AI.abstract), day);
});

test("the index lists each day newest first with its number of entries, each linking its file", () => {
	const files = digestFiles(
		siteData(
			[
				digestLine("2026-10-19", [
					{ ...SCIENTIST_AI, id: "arxiv:2610.00009" },
					{ ...SCIENTIST_AI, id: "arxiv:2610.00010" },
				]),
				digestLine("2026-10-20", [SCIENTIST_AI]),
			].join("\n"),
		),
	);
	const index = files.get("index.md") ?? "";
	assert.ok(
		index.indexOf("[2026-10-20](2026-10-20.md): 1 entry") <
			index.indexOf("[2026-10-19](2026-10-19.md): 2 entries"),
		index,
	);
});

test("an empty digests file builds an index that says there are no digests yet", () => {
	const files = digestFiles(siteData(""));
	assert.deepEqual([...files.keys()], ["index.md"]);
	assert.match(files.get("index.md") ?? "", /No digests yet\./);
});

test("security: a line whose date isn't a real day stops the build before any file name is made from it", () => {
	for (const date of ["../../../../tmp/pwn", "2026-02-30", "20 October"]) {
		assert.throws(
			() => siteData(digestLine(date, [SCIENTIST_AI])),
			/date must be YYYY-MM-DD/,
			date,
		);
	}
});
