// What scripts/deploy/build-site.ts writes for the Home Screen app: the manifest, the icons and who links them.
// The script runs once on a copy of site/ with one empty day; each test reads the built folder.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, test } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPT = path.join(ROOT, "scripts", "deploy", "build-site.ts");

let workFolder = "";
let built = "";
const read = (file: string) => fs.readFileSync(path.join(built, file), "utf8");

beforeAll(() => {
	workFolder = fs.mkdtempSync(path.join(os.tmpdir(), "liminal-home-screen-"));
	const site = path.join(workFolder, "site");
	fs.cpSync(path.join(ROOT, "site"), site, {
		recursive: true,
		filter: (source) => !/(digests[^/]*\.js|figures)$/.test(source),
	});
	const digests = path.join(workFolder, "digests.js");
	fs.writeFileSync(digests, 'digest({"date":"2026-11-01","entries":[]});\n');
	const dist = path.join(workFolder, "dist");
	execFileSync(process.execPath, [SCRIPT, digests, dist], {
		env: { ...process.env, LIMINAL_SITE: site },
	});
	built = path.join(dist, "liminal-space");
});

afterAll(() => {
	fs.rmSync(workFolder, { recursive: true, force: true });
});

// The <link> elements of a page's head, each as its attributes.
function links(html: string) {
	return [...html.matchAll(/<link\b([^>]*)>/g)].map((link) =>
		Object.fromEntries(
			[...(link[1] || "").matchAll(/([\w-]+)="([^"]*)"/g)].map((pair) => [
				pair[1],
				pair[2],
			]),
		),
	);
}

describe("who links the manifest and the icons", () => {
	test("only the owner's page links the manifest, one folder up", () => {
		const owner = links(read("owner/index.html")).filter(
			(link) => link.rel === "manifest",
		);
		assert.deepEqual(owner, [
			{ rel: "manifest", href: "../manifest.webmanifest" },
		]);
		assert.deepEqual(
			links(read("index.html")).filter((link) => link.rel === "manifest"),
			[],
		);
		assert.ok(fs.existsSync(path.join(built, "manifest.webmanifest")));
	});

	test("both pages link the tab icons and the Home Screen icon to files that exist, and set the theme colour", () => {
		for (const [page, prefix] of [
			["index.html", ""],
			["owner/index.html", "../"],
		] as const) {
			const html = read(page);
			const icons = links(html)
				.filter(
					(link) => link.rel === "icon" || link.rel === "apple-touch-icon",
				)
				.map((link) => `${link.rel} ${link.sizes} ${link.href}`);
			assert.deepEqual(icons, [
				`icon 32x32 ${prefix}app-icon/icon-32.png`,
				`icon 16x16 ${prefix}app-icon/icon-16.png`,
				`apple-touch-icon 180x180 ${prefix}app-icon/apple-touch-icon.png`,
			]);
			assert.match(html, /<meta name="theme-color" content="#041534">/, page);
			for (const link of links(html).filter((one) =>
				/icon/.test(one.rel || ""),
			)) {
				const file = path.join(
					path.dirname(path.join(built, page)),
					link.href || "",
				);
				assert.ok(fs.existsSync(file), `${page} links ${link.href}`);
			}
		}
	});

	test("there is one Home Screen icon, not a pair switched by the colour scheme", () => {
		assert.equal(
			fs.existsSync(path.join(built, "app-icon", "apple-touch-icon-dark.png")),
			false,
		);
		for (const page of ["index.html", "owner/index.html"]) {
			assert.equal(
				links(read(page)).filter((link) => link.rel === "apple-touch-icon")
					.length,
				1,
				page,
			);
		}
	});
});

describe("the manifest", () => {
	const manifest = () => JSON.parse(read("manifest.webmanifest"));

	test("the manifest starts the app on the owner's page, a built page inside its scope, and sits outside the owner's folder", () => {
		const { id, start_url, scope } = manifest();
		assert.equal(start_url, id);
		assert.ok(start_url.startsWith(scope), `${start_url} is inside ${scope}`);
		assert.ok(
			fs.existsSync(
				path.join(built, start_url.slice(scope.length), "index.html"),
			),
			"the start URL is a built page",
		);
		// A visitor never reaches the manifest through a login: it sits on the public path.
		assert.ok(
			!fs.existsSync(path.join(built, "owner", "manifest.webmanifest")),
		);
	});

	test("every icon it names is a built PNG of the size it says", () => {
		const icons: { src: string; sizes: string; type: string }[] =
			manifest().icons;
		assert.ok(icons.length > 0);
		for (const icon of icons) {
			assert.equal(icon.type, "image/png");
			const file = fs.readFileSync(path.join(built, icon.src));
			assert.equal(file.subarray(1, 4).toString(), "PNG", icon.src);
			assert.equal(
				`${file.readUInt32BE(16)}x${file.readUInt32BE(20)}`,
				icon.sizes,
				icon.src,
			);
		}
	});
});

describe("the content security policy", () => {
	// The directives of the policy the headers give the page's files.
	function policy() {
		const headers = fs.readFileSync(path.join(built, "..", "_headers"), "utf8");
		const rule = headers.split("\n/*\n")[0] || "";
		const section = rule.slice(rule.indexOf("/liminal-space/*\n"));
		const line =
			section
				.split("\n")
				.find((each) => each.includes("Content-Security-Policy:")) || "";
		const directives = new Map<string, string[]>();
		for (const part of line.slice(line.indexOf(":") + 1).split(";")) {
			const [name, ...sources] = part.trim().split(/\s+/);
			if (name) directives.set(name, sources);
		}
		return directives;
	}
	const allows = (directive: string) => {
		const directives = policy();
		return (
			directives.get(directive) ||
			directives.get("default-src") ||
			[]
		).includes("'self'");
	};

	test("security: the policy lets the owner's page load the site's own manifest, icons, stylesheet, script and fonts", () => {
		const html = read("owner/index.html");
		const needs = new Set<string>();
		for (const link of links(html)) {
			if (link.rel === "manifest") needs.add("manifest-src");
			if (link.rel === "icon" || link.rel === "apple-touch-icon")
				needs.add("img-src");
			if (link.rel === "stylesheet") needs.add("style-src");
			if (link.rel === "preload" && link.as === "font") needs.add("font-src");
		}
		if (/<script\b[^>]*\bsrc=/.test(html)) needs.add("script-src");
		assert.ok(
			needs.has("manifest-src") && needs.has("img-src"),
			"the page links a manifest and icons",
		);
		for (const directive of needs)
			assert.ok(allows(directive), `${directive} lets 'self' through`);
	});

	// Whether the policy refuses an inline script or another site's address under a directive, by CSP's own rules.
	const refuses = (directive: string, source: string) => {
		const directives = policy();
		let sources = directives.get(directive);
		if (sources === undefined && directive.endsWith("-src"))
			sources = directives.get("default-src");
		if (sources === undefined) return false;
		if (source === "inline") return !sources.includes("'unsafe-inline'");
		const { protocol, host } = new URL(source);
		return !sources.some(
			(allowed) =>
				allowed === "*" ||
				allowed === protocol ||
				allowed === source ||
				allowed === host ||
				(allowed.includes("*.") &&
					host.endsWith(allowed.slice(allowed.indexOf("*.") + 1))),
		);
	};

	test("security: a built page framed by another site, or holding an inline script, another site's script, a base tag or a form target, is refused by the policy the build wrote", () => {
		const elsewhere = "https://evil.example";
		assert.deepEqual(
			{
				"framed by another site": refuses("frame-ancestors", elsewhere),
				"an inline script": refuses("script-src", "inline"),
				"another site's script": refuses("script-src", elsewhere),
				"a base tag to another site": refuses("base-uri", elsewhere),
				"a form sent to another site": refuses("form-action", elsewhere),
			},
			{
				"framed by another site": true,
				"an inline script": true,
				"another site's script": true,
				"a base tag to another site": true,
				"a form sent to another site": true,
			},
		);
	});
});
