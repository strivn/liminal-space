// Unit tests for scripts/scout/newsfeed/icons.ts, run as a script against servers on 127.0.0.1 only.
import { execFile } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, expect, test } from "vitest";
import { closeServers, serve } from "./local-server.ts";

const SCRIPT = new URL(
	"../../scripts/scout/newsfeed/icons.ts",
	import.meta.url,
);
const WORK = mkdtempSync(join(tmpdir(), "liminal-unit-icons-"));
const run = promisify(execFile);

// A 1x1 PNG header: the signature, then an IHDR chunk with width 1 and height 1.
const PNG = Buffer.from(
	"89504e470d0a1a0a0000000d494844520000000100000001",
	"hex",
);

afterEach(closeServers);
afterAll(() => {
	rmSync(WORK, { recursive: true, force: true });
});

test("a feed's icon served after a redirect is saved under the feed's host, with the extension of its content type", async () => {
	const base = await serve((incoming, out) => {
		if (incoming.url === "/icon") {
			out.writeHead(302, { location: "/real.png" });
			out.end();
			return;
		}
		out.writeHead(200, { "content-type": "image/png" });
		out.end(PNG);
	});
	const feeds = join(WORK, "feeds.json");
	const folder = join(WORK, "icons");
	writeFileSync(
		feeds,
		JSON.stringify({
			sources: [{ kind: "rss", url: `${base}/feed.xml`, icon: `${base}/icon` }],
		}),
	);
	await run(process.execPath, [SCRIPT.pathname, feeds, folder]);
	const host = new URL(base).host;
	expect(existsSync(join(folder, `${host}.png`))).toBe(true);
	expect(readFileSync(join(folder, `${host}.png`))).toEqual(PNG);
	expect(JSON.parse(readFileSync(join(folder, "index.json"), "utf8"))).toEqual({
		[host]: `${host}.png`,
	});
});
