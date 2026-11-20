// Unit tests for scripts/scout/web/fulltext.sh, one rule at a time: where each way of naming
// an item is fetched from, what the output files are named, which user agent each site gets, what it says when a fetch
// fails or an item isn't one, paths and curl options that are not items, redirects to addresses other than http(s),
// challenge pages, character sets, and the guards: addresses on this machine or a private network, redirects, and the
// output folder.
// The script is bash, so there are no functions to import: each test runs it against a stand-in server in this process.
// arXiv's PDFs come from the stand-in under /pdf and DOIs under /doi; every other host is behind a proxy that refuses,
// so no test can reach a real site. LIMINAL_ALLOW_LOCAL opens the stand-in's address, and only it, to the script.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, test } from "vitest";
import { isJsonObject } from "../../shared/narrow.ts";
import { twoPagePdf } from "../support/pdf.ts";

const SCRIPT = fileURLToPath(
	new URL("../../scripts/scout/web/fulltext.sh", import.meta.url),
);
const CONSTANTS: unknown = JSON.parse(
	fs.readFileSync(
		fileURLToPath(new URL("../../scripts/lib/constants.json", import.meta.url)),
		"utf8",
	),
);
assert.ok(isJsonObject(CONSTANTS), "constants.json holds one object");
const REFUSING_PROXY = "http://127.0.0.1:9";
const CAFE = "Café crème — l’été, naïve";

// --- The stand-in ---

// One answer of the stand-in: status, Content-Type and body, with a Location header when location is set.
type StandInAnswer = {
	status: number;
	type: string;
	body: string | Buffer;
	location?: string;
	declaredLength?: number; // a Content-Length to declare; the headers go out and the body never follows
};

// What the stand-in answers for a request path; null answers 404.
type Answerer = (urlPath: string) => StandInAnswer | null;

// One request the stand-in received: its path and its User-Agent header.
type LoggedRequest = { path: string; agent: string };

// What the stand-in answers and what it has received; url is null until it listens, answer until useStandIn.
type StandIn = {
	url: string | null;
	answer: Answerer | null;
	log: LoggedRequest[];
};

// One run of the script: exit code (an error's code, which may be a signal name), output, its folders, and the output
// folder when runOnItem made one.
type ScriptRun = {
	code: number | string | undefined;
	stdout: string;
	stderr: string;
	tmpDir: string;
	cwd: string;
	outDir?: string;
};

// A run on one item, with the output folder runOnItem made.
type ItemRun = ScriptRun & { outDir: string };

// The FTP stand-in: its ftp:// address (null until it listens) and how many connections it has had.
type FtpStandIn = { url: string | null; connections: number };

// A second local listener: its port, its server, and how many requests it received.
type OtherListener = { port: number; requests: number; server: http.Server };

// One server for the whole file; each test sets what it answers with useStandIn. Tests in a file run one at a time.
const standIn: StandIn = {
	url: null,
	answer: null, // (path) => { status, type, body, location (optional, sent as the Location header) } or null for 404
	log: [], // { path, agent } per request, in arrival order
};
const server = http.createServer((request, response) => {
	// An http.Server request always has a url; "" only satisfies TypeScript.
	const requestUrl = request.url || "";
	standIn.log.push({
		path: requestUrl,
		agent: request.headers["user-agent"] || "",
	});
	const answerFor = standIn.answer;
	assert.ok(answerFor !== null, "useStandIn ran before the request");
	const answer = answerFor(requestUrl);
	if (answer === null) {
		response.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
		response.end("<html><body><p>Not found</p></body></html>");
		return;
	}
	const headers: Record<string, string> = { "Content-Type": answer.type };
	if (answer.location !== undefined) {
		headers.Location = answer.location;
	}
	if (answer.declaredLength !== undefined) {
		headers["Content-Length"] = String(answer.declaredLength);
		response.writeHead(answer.status, headers);
		response.flushHeaders();
		return;
	}
	response.writeHead(answer.status, headers);
	response.end(answer.body);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(
	address !== null && typeof address === "object",
	"the stand-in listens on a port",
);
standIn.url = `http://127.0.0.1:${address.port}`;

// A bare TCP listener standing in for an FTP server: it counts the connections it gets and closes each at once, so a
// redirect to ftp:// that curl followed shows up as a connection.
const ftpStandIn: FtpStandIn = {
	url: null,
	connections: 0,
};
const ftpServer = net.createServer((socket) => {
	ftpStandIn.connections += 1;
	socket.destroy();
});
await new Promise<void>((resolve) => ftpServer.listen(0, "127.0.0.1", resolve));
const ftpAddress = ftpServer.address();
assert.ok(
	ftpAddress !== null && typeof ftpAddress === "object",
	"the FTP stand-in listens on a port",
);
ftpStandIn.url = `ftp://127.0.0.1:${ftpAddress.port}`;

// Forget earlier requests and answer with `answer` from now on.
function useStandIn(answer: Answerer) {
	standIn.log = [];
	standIn.answer = answer;
}

// The paths the stand-in was asked for, in order.
function requestedPaths() {
	return standIn.log.map((request) => request.path);
}

// A 200 answer holding the two-page PDF for `id` ("Page one of <id>", "Page two of <id>").
function pdfAnswer(id: string): StandInAnswer {
	return { status: 200, type: "application/pdf", body: twoPagePdf(id) };
}

// A 200 answer holding an HTML page whose body is `bodyHtml`, in UTF-8.
function htmlAnswer(bodyHtml: string): StandInAnswer {
	const page =
		'<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n</head>\n<body>\n' +
		bodyHtml +
		"\n</body>\n</html>\n";
	return { status: 200, type: "text/html; charset=utf-8", body: page };
}

// Answers every arXiv path /pdf/<id> with that id's two-page PDF, every /doi/ path with the PDF for "doi", every /news/
// path with a short article, and anything else with 404.
function servesEverything(urlPath: string): StandInAnswer | null {
	if (urlPath.startsWith("/pdf/")) {
		return pdfAnswer(urlPath.slice("/pdf/".length));
	}
	if (urlPath.startsWith("/doi/")) {
		return pdfAnswer("doi");
	}
	if (urlPath.startsWith("/news/")) {
		return htmlAnswer("<p>The ferry timetable changes on Monday.</p>");
	}
	return null;
}

// --- Folders and runs ---

const tempDirs: string[] = [];
afterAll(() => {
	server.closeAllConnections();
	server.close();
	ftpServer.close();
	for (const dir of tempDirs) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// A fresh, empty folder, deleted when the file's tests end.
function tempDir(prefix: string) {
	const dir = fs.mkdtempSync(
		path.join(os.tmpdir(), `liminal-fulltext-unit-${prefix}-`),
	);
	tempDirs.push(dir);
	return dir;
}

// Every file under `dir`, at any depth, relative to it. Folders are not listed.
function filesUnder(dir: string) {
	const files: string[] = [];
	for (const entry of fs.readdirSync(dir, {
		recursive: true,
		withFileTypes: true,
	})) {
		if (entry.isFile()) {
			files.push(path.relative(dir, path.join(entry.parentPath, entry.name)));
		}
	}
	return files;
}

// Run the script with `args` in `cwd` (a fresh folder when not given), with a fresh TMPDIR and no LIMINAL_TMP.
// `extraEnv` (optional) adds variables to that environment or replaces them, e.g. a TMPDIR of the test's own.
// Returns { code, stdout, stderr, tmpDir, cwd }.
function run(
	args: string[],
	cwd?: string,
	extraEnv?: Record<string, string | undefined>,
): Promise<ScriptRun> {
	const workingDir = cwd || tempDir("cwd");
	const tmpDir = tempDir("tmp");
	const env = Object.assign(
		{},
		process.env,
		{
			ARXIV_PDF_BASE: `${standIn.url}/pdf`,
			DOI_BASE: `${standIn.url}/doi`,
			TMPDIR: `${tmpDir}/`,
			LIMINAL_TMP: undefined, // an undefined value drops the variable from the child's environment
			http_proxy: REFUSING_PROXY,
			https_proxy: REFUSING_PROXY,
			all_proxy: REFUSING_PROXY,
			HTTP_PROXY: REFUSING_PROXY,
			HTTPS_PROXY: REFUSING_PROXY,
			ALL_PROXY: REFUSING_PROXY,
			no_proxy: "127.0.0.1,localhost",
			NO_PROXY: "127.0.0.1,localhost",
			// The url is set when the stand-in listens, at the top of this file; the template only satisfies TypeScript.
			LIMINAL_ALLOW_LOCAL: new URL(`${standIn.url}`).host,
		},
		extraEnv || {},
	);
	return new Promise((resolve) => {
		execFile(
			SCRIPT,
			args,
			{ cwd: workingDir, env: env, timeout: 60000 },
			(error, stdout, stderr) => {
				let code: number | string | undefined = 0;
				if (error) {
					code = error.code;
				}
				resolve({
					code: code,
					stdout: stdout,
					stderr: stderr,
					tmpDir: tmpDir,
					cwd: workingDir,
				});
			},
		);
	});
}

// Run on one item with a fresh output directory. Returns the run, plus `outDir`.
async function runOnItem(
	item: string,
	cwd?: string,
	extraEnv?: Record<string, string | undefined>,
): Promise<ItemRun> {
	const outDir = tempDir("out");
	const result = await run([item, outDir], cwd, extraEnv);
	return Object.assign(result, { outDir: outDir });
}

// The run succeeded and printed one line, the path of a text file; returns that file's text.
function printedText(result: ScriptRun) {
	assert.equal(result.code, 0, result.stderr);
	const printed = result.stdout.trim();
	assert.ok(
		printed.endsWith(".txt"),
		`prints the path of a .txt file, got ${JSON.stringify(result.stdout)}`,
	);
	return fs.readFileSync(printed, "utf8");
}

// The run printed this exact line on stderr.
function assertStderrLine(result: ScriptRun, expected: string) {
	assert.ok(
		result.stderr.split("\n").includes(expected),
		`a stderr line ${JSON.stringify(expected)}; stderr was:\n${result.stderr}`,
	);
}

// The run printed a stderr line starting with `prefix` and holding `words` after it.
function assertStderrLineStartingWith(
	result: ScriptRun,
	prefix: string,
	words: string,
) {
	let found = false;
	for (const line of result.stderr.split("\n")) {
		if (line.startsWith(prefix) && line.slice(prefix.length).includes(words)) {
			found = true;
		}
	}
	assert.ok(
		found,
		`a stderr line starting ${JSON.stringify(prefix)}, then ${JSON.stringify(words)}; stderr was:\n${result.stderr}`,
	);
}

// The run failed with exit code 1 and printed no path.
function assertFailed(result: ScriptRun) {
	assert.equal(result.code, 1, result.stderr);
	assert.equal(result.stdout, "");
}

// The run failed with exit code 1, printed no path, and left no file in TMPDIR or the output folder.
function assertFailedCleanly(result: ScriptRun) {
	assertFailed(result);
	assertNoFilesLeft(result);
}

// No file is left in TMPDIR, the working folder, or the output folder when there is one. Folders may remain.
function assertNoFilesLeft(result: ScriptRun) {
	assert.deepEqual(filesUnder(result.tmpDir), [], "files left in TMPDIR");
	assert.deepEqual(
		filesUnder(result.cwd),
		[],
		"files left in the working folder",
	);
	if (result.outDir) {
		assert.deepEqual(
			filesUnder(result.outDir),
			[],
			"files left in the output folder",
		);
	}
}

// Standard output is one line, the path of a file named `fileName` in `outDir` (compared after resolving symlinks,
// since macOS's /var is /private/var).
function assertPrintedPath(
	result: ScriptRun,
	outDir: string,
	fileName: string,
) {
	const lines = result.stdout.split("\n");
	assert.deepEqual(
		lines.slice(1),
		[""],
		`standard output is one line: ${JSON.stringify(result.stdout)}`,
	);
	const printed = lines[0];
	assert.ok(printed !== undefined, "split gives at least one line");
	assert.equal(path.basename(printed), fileName);
	assert.equal(fs.realpathSync(path.dirname(printed)), fs.realpathSync(outDir));
}

// =====================================================================================================
// Where each item is fetched from
// =====================================================================================================

// Each row: an item, and the path the stand-in is asked for.
const FETCHED_FROM: [string, string][] = [
	["ARXIV:2507.11473", "/pdf/2507.11473"],
	["2507.11473", "/pdf/2507.11473"],
	["0704.0001", "/pdf/0704.0001"],
	["2507.11473v12", "/pdf/2507.11473v12"],
	["arXiv:2507.11473v2", "/pdf/2507.11473v2"],
	["math.GT/0309136", "/pdf/math.GT/0309136"],
	["arxiv:math.GT/0309136", "/pdf/math.GT/0309136"],
	["http://arxiv.org/abs/2507.11473", "/pdf/2507.11473"],
	["https://www.arxiv.org/abs/2507.11473", "/pdf/2507.11473"],
	["https://arxiv.org/abs/hep-th/9901001", "/pdf/hep-th/9901001"],
	["http://www.arxiv.org/pdf/2507.11473v2", "/pdf/2507.11473v2"],
	["https://arxiv.org/pdf/2507.11473.pdf", "/pdf/2507.11473"],
	["https://arxiv.org/pdf/2507.11473v2.pdf", "/pdf/2507.11473v2"],
	// An arXiv URL loses its ?query and #fragment before its id is read.
	[
		"https://arxiv.org/abs/2507.11473v3?context=cs#abstract",
		"/pdf/2507.11473v3",
	],
	["https://arxiv.org/pdf/2507.11473.pdf?download=1", "/pdf/2507.11473"],
	["https://arxiv.org/abs/hep-th/9901001#S2", "/pdf/hep-th/9901001"],
	// Any other URL is fetched as given, query included.
	[`${standIn.url}/news/ferry.html?page=2`, "/news/ferry.html?page=2"],
];

for (const row of FETCHED_FROM) {
	const item = row[0];
	const expectedPath = row[1];
	test(`${item} is fetched from ${expectedPath}`, async () => {
		useStandIn(servesEverything);
		const result = await runOnItem(item);
		assert.equal(result.code, 0, result.stderr);
		assert.deepEqual(requestedPaths(), [expectedPath]);
	});
}

// =====================================================================================================
// Something that isn't an item: only http and https addresses are fetched, a path is never read, and an item that
// starts with "-" is not one
// =====================================================================================================

// The line the script prints for an item it refuses.
function notAnItemLine(item: string) {
	return `fulltext.sh: "${item}" is not an arXiv id, URL, doi: or url:`;
}

// The "-K" forms are below, with a real curl config file.
const NOT_ITEMS = [
	"2507.114",
	"arxiv:hello",
	"ftp://example.com/a.pdf",
	"url:example.com/news/ferry.html", // no scheme, so not an http(s) address
	"url:",
	"-",
];

for (const item of NOT_ITEMS) {
	test(`security: "${item}" is refused with exit 1, and nothing is fetched or written`, async () => {
		useStandIn(servesEverything);
		const result = await runOnItem(item);
		assertFailedCleanly(result);
		assertStderrLine(result, notAnItemLine(item));
		assert.deepEqual(requestedPaths(), []);
	});
}

// A curl config file that would make curl ask the stand-in for /injected, if curl ever read it.
function curlConfigFile() {
	const file = path.join(tempDir("curlrc"), "curlrc");
	fs.writeFileSync(file, `url = "${standIn.url}/injected"\n`);
	return file;
}

// "-K<file>" is curl's option to read a config file; the item never reaches curl, so the stand-in hears nothing.
for (const prefix of ["-K", "url:-K"]) {
	test(`security: "${prefix}<curl config file>" is refused, and curl never reads the file`, async () => {
		useStandIn(servesEverything);
		const item = prefix + curlConfigFile();
		const result = await runOnItem(item);
		assertFailedCleanly(result);
		assertStderrLine(result, notAnItemLine(item));
		assert.deepEqual(requestedPaths(), []);
	});
}

// A DOI is only ever a path on DOI_BASE, so one that looks like a curl option is asked for there like any other.
test('security: "doi:-K<curl config file>" is asked for on doi.org, and curl never reads the file', async () => {
	useStandIn(servesEverything);
	const file = curlConfigFile();
	const result = await runOnItem(`doi:-K${file}`);
	assert.equal(result.code, 0, result.stderr);
	assert.deepEqual(requestedPaths(), [`/doi/-K${file}`]);
});

// A path is never read, even when the file is there.
test("security: the absolute path of a saved PDF is refused, and the file is not read", async () => {
	useStandIn(servesEverything);
	const file = path.join(tempDir("saved"), "paper.pdf");
	fs.writeFileSync(file, twoPagePdf("the saved paper"));
	const result = await runOnItem(file);
	assertFailedCleanly(result);
	assertStderrLine(result, notAnItemLine(file));
	assert.deepEqual(requestedPaths(), []);
});

// The working folder holds the saved file, so only the output folder and TMPDIR must stay empty.
test("security: a relative path to a saved PDF in the working folder is refused, and the file is not read", async () => {
	useStandIn(servesEverything);
	const dir = tempDir("saved");
	fs.writeFileSync(
		path.join(dir, "report.pdf"),
		twoPagePdf("the relative report"),
	);
	const result = await runOnItem("report.pdf", dir);
	assertFailed(result);
	assertStderrLine(result, notAnItemLine("report.pdf"));
	assert.deepEqual(requestedPaths(), []);
	assert.deepEqual(
		filesUnder(result.outDir),
		[],
		"files left in the output folder",
	);
	assert.deepEqual(filesUnder(result.tmpDir), [], "files left in TMPDIR");
	assert.deepEqual(fs.readdirSync(dir), ["report.pdf"]);
});

// A file named like an arXiv id sits in the working folder; the id still means the paper on arXiv.
test("security: a file named like an arXiv id is not read: the id is fetched from arXiv", async () => {
	useStandIn(servesEverything);
	const dir = tempDir("saved");
	fs.writeFileSync(path.join(dir, "2507.11473"), twoPagePdf("the local copy"));
	const text = printedText(await runOnItem("2507.11473", dir));
	assert.ok(text.includes("Page one of 2507.11473"), text);
	assert.ok(!text.includes("the local copy"), text);
	assert.deepEqual(requestedPaths(), ["/pdf/2507.11473"]);
});

// =====================================================================================================
// Redirects: followed to http and https addresses only
// =====================================================================================================

// A stand-in that answers `fromPath` with HTTP 302 to `location`, and every other path as servesEverything does.
function redirectsTo(fromPath: string, location: string): Answerer {
	return (urlPath) => {
		if (urlPath === fromPath) {
			return {
				status: 302,
				type: "text/html; charset=utf-8",
				body: "",
				location: location,
			};
		}
		return servesEverything(urlPath);
	};
}

// A file in a fresh folder holding `content`; its text must never show up in what a run prints or writes.
function secretFile(name: string, content: string | Buffer) {
	const file = path.join(tempDir("secret"), name);
	fs.writeFileSync(file, content);
	return file;
}

test("security: a redirect to a file:// address fails with a fetch error for the URL, and the file is not read", async () => {
	const secret = secretFile(
		"saved.html",
		"<!doctype html>\n<html>\n<body>\n<p>Secret saved page</p>\n</body>\n</html>\n",
	);
	useStandIn(redirectsTo("/news/moved.html", `file://${secret}`));
	const url = `${standIn.url}/news/moved.html`;
	const result = await runOnItem(url);
	assertFailedCleanly(result);
	assertStderrLineStartingWith(
		result,
		`fulltext.sh: could not fetch ${url}: `,
		"",
	);
	assert.ok(!result.stderr.includes("Secret saved page"), result.stderr);
});

test("security: a DOI that redirects to a file:// address fails with a fetch error for its doi.org address", async () => {
	const secret = secretFile("saved.pdf", twoPagePdf("the secret file"));
	useStandIn(redirectsTo("/doi/10.1234/moved", `file://${secret}`));
	const result = await runOnItem("doi:10.1234/moved");
	assertFailedCleanly(result);
	assertStderrLineStartingWith(
		result,
		`fulltext.sh: could not fetch ${standIn.url}/doi/10.1234/moved: `,
		"",
	);
});

// curl follows a redirect to ftp:// unless told not to (measured with curl 8.7.1: one connection to the FTP stand-in),
// so this test is the one that shows the script limits redirects to http and https itself.
test("security: a redirect to an ftp:// address fails with a fetch error for the URL, and no connection is made to it", async () => {
	ftpStandIn.connections = 0;
	useStandIn(redirectsTo("/news/moved.html", `${ftpStandIn.url}/a.pdf`));
	const url = `${standIn.url}/news/moved.html`;
	const result = await runOnItem(url);
	assertFailedCleanly(result);
	assertStderrLineStartingWith(
		result,
		`fulltext.sh: could not fetch ${url}: `,
		"",
	);
	assert.equal(ftpStandIn.connections, 0, "connections to the FTP stand-in");
});

// doi.org answers every DOI with a redirect to the publisher, so a redirect to an http address must be followed.
test("a DOI that redirects to an http address gives the text of the PDF it lands on", async () => {
	useStandIn((urlPath) => {
		if (urlPath === "/doi/10.1234/moved") {
			return {
				status: 302,
				type: "text/html; charset=utf-8",
				body: "",
				location: `${standIn.url}/papers/landing.pdf`,
			};
		}
		if (urlPath === "/papers/landing.pdf") {
			return pdfAnswer("the landing paper");
		}
		return null;
	});
	const text = printedText(await runOnItem("doi:10.1234/moved"));
	assert.ok(text.includes("Page one of the landing paper"), text);
	assert.deepEqual(requestedPaths(), [
		"/doi/10.1234/moved",
		"/papers/landing.pdf",
	]);
});

// =====================================================================================================
// Output names: the item with characters outside A-Za-z0-9._- turned into _, cut to 80 characters
// =====================================================================================================

// Each row: an item, and the name its files get.
const NAMED: [string, string][] = [
	["arxiv:2507.11473", "arxiv_2507.11473"],
	["hep-th/9901001", "hep-th_9901001"],
	["doi:10.1145/3442188.3445922", "doi_10.1145_3442188.3445922"],
];

for (const row of NAMED) {
	const item = row[0];
	const name = row[1];
	test(`${item} is written as ${name}.txt, with its PDF as ${name}.pdf`, async () => {
		useStandIn(servesEverything);
		const result = await runOnItem(item);
		assert.equal(result.code, 0, result.stderr);
		assertPrintedPath(result, result.outDir, `${name}.txt`);
		assert.deepEqual(fs.readdirSync(result.outDir).sort(), [
			`${name}.pdf`,
			`${name}.txt`,
		]);
	});
}

test("a long URL gives a file name cut to 80 characters, and an HTML page leaves only the text file", async () => {
	useStandIn(servesEverything);
	const result = await runOnItem(`${standIn.url}/news/${"a".repeat(200)}.html`);
	assert.equal(result.code, 0, result.stderr);
	const files = fs.readdirSync(result.outDir);
	assert.equal(
		files.length,
		1,
		`files in the output folder: ${files.join(", ")}`,
	);
	const textName = files[0];
	assert.ok(textName !== undefined, "a file in the output folder");
	assert.equal(textName.length, 80 + ".txt".length, textName);
	assert.match(textName, /^http___127\.0\.0\.1_[A-Za-z0-9._-]+\.txt$/);
	assertPrintedPath(result, result.outDir, textName);
});

// =====================================================================================================
// An output folder whose name starts with "-" is a folder, not an option
// =====================================================================================================

// The printed path, read from the folder the script ran in when it is relative.
function printedFile(result: ScriptRun) {
	const lines = result.stdout.split("\n");
	assert.deepEqual(
		lines.slice(1),
		[""],
		`standard output is one line: ${JSON.stringify(result.stdout)}`,
	);
	const printed = lines[0];
	assert.ok(printed !== undefined, "split gives at least one line");
	// path.resolve keeps an absolute path as it is, like Python's os.path.join(cwd, "/abs").
	return path.resolve(result.cwd, printed);
}

test('an HTML page with the output folder "-out" leaves only its text file in ./-out', async () => {
	useStandIn(servesEverything);
	const result = await run([`${standIn.url}/news/ferry.html`, "-out"]);
	assert.equal(result.code, 0, result.stderr);
	const outDir = path.join(result.cwd, "-out");
	const files = fs.readdirSync(outDir);
	assert.equal(files.length, 1, `files in ./-out: ${files.join(", ")}`);
	const textName = files[0];
	assert.ok(textName !== undefined, "a file in ./-out");
	assert.ok(textName.endsWith(".txt"), textName);
	const printed = printedFile(result);
	assert.equal(
		fs.realpathSync(printed),
		fs.realpathSync(path.join(outDir, textName)),
	);
	assert.ok(
		fs
			.readFileSync(printed, "utf8")
			.includes("The ferry timetable changes on Monday."),
		"the text file holds the page",
	);
});

// =====================================================================================================
// User agents
// =====================================================================================================

// Every request sends the user agent in scripts/lib/constants.json; these are two kinds of item.
for (const item of [
	"https://arxiv.org/abs/2507.11473?context=cs",
	"doi:10.1145/3442188.3445922",
]) {
	test(`${item} is fetched with the user agent in scripts/lib/constants.json`, async () => {
		useStandIn(servesEverything);
		await runOnItem(item);
		assert.ok(standIn.log.length > 0, "requests");
		for (const request of standIn.log) {
			assert.equal(request.agent, CONSTANTS.userAgent);
		}
	});
}

// =====================================================================================================
// Failed fetches
// =====================================================================================================

test('an HTTP error is reported with the URL and "HTTP <code>"', async () => {
	useStandIn(() => ({
		status: 500,
		type: "text/html; charset=utf-8",
		body: "<p>Server error</p>",
	}));
	const url = `${standIn.url}/news/broken.html`;
	const result = await runOnItem(url);
	assertFailed(result);
	assertStderrLineStartingWith(
		result,
		`fulltext.sh: could not fetch ${url}: `,
		"HTTP 500",
	);
});

test("a DOI that answers 404 is reported with the address it was fetched from", async () => {
	useStandIn(() => null);
	const result = await runOnItem("doi:10.1234/missing");
	assertFailed(result);
	assertStderrLineStartingWith(
		result,
		`fulltext.sh: could not fetch ${standIn.url}/doi/10.1234/missing: `,
		"HTTP 404",
	);
});

test("an arXiv id that answers 404 is reported with the address it was fetched from", async () => {
	useStandIn(() => null);
	const result = await runOnItem("2507.99999");
	assertFailed(result);
	assertStderrLineStartingWith(
		result,
		`fulltext.sh: could not fetch ${standIn.url}/pdf/2507.99999: `,
		"HTTP 404",
	);
});

// arXiv answers with a page instead of a PDF.
for (const item of ["https://arxiv.org/abs/2507.11473"]) {
	test(`arXiv answering ${item} with a web page instead of a PDF is reported, and no file is left`, async () => {
		useStandIn(() => htmlAnswer("<h1>Rate exceeded</h1>"));
		const result = await runOnItem(item);
		assertFailedCleanly(result);
		assertStderrLine(
			result,
			`fulltext.sh: arXiv gave something that isn't a PDF for 2507.11473: ${standIn.url}/pdf/2507.11473`,
		);
	});
}

test("security: a download that declares more than 100 MB is refused as larger than 100 MB, and no file is left", async () => {
	useStandIn(() => ({
		status: 200,
		type: "application/pdf",
		body: "",
		declaredLength: 101 * 1024 * 1024,
	}));
	const url = `${standIn.url}/news/huge.pdf`;
	const result = await runOnItem(url);
	assertFailedCleanly(result);
	assertStderrLineStartingWith(
		result,
		`fulltext.sh: could not fetch ${url}: `,
		"larger than 100 MB",
	);
});

// =====================================================================================================
// Challenge pages: under 3,000 characters of text, holding one of the phrases, in any case
// =====================================================================================================

const CHALLENGE_TEXTS = [
	"ENABLE JAVASCRIPT AND COOKIES TO CONTINUE",
	"Just a moment...",
	"Checking your browser before accessing the site.",
	"Attention Required! | Cloudflare",
	"Attention required! One more step.",
	"Please enable cookies.",
	"Verify you are human by completing the action below.",
];

for (const text of CHALLENGE_TEXTS) {
	test(`a short page reading "${text}" is refused as a page that asks for JavaScript or cookies`, async () => {
		useStandIn(() => htmlAnswer(`<p>${text}</p>`));
		const url = `${standIn.url}/news/guarded.html`;
		const result = await runOnItem(url);
		assertFailedCleanly(result);
		assertStderrLine(
			result,
			`fulltext.sh: ${url} answered with a page that asks for JavaScript or cookies, not the article`,
		);
	});
}

// "just a moment..." is a phrase with its three dots, not a pattern.
test('a short page reading "Just a moment, said the minister" is an article', async () => {
	useStandIn(() =>
		htmlAnswer(
			"<p>Just a moment, said the minister, before the vote on the harbour budget.</p>",
		),
	);
	const text = printedText(
		await runOnItem(`${standIn.url}/news/minister.html`),
	);
	assert.ok(text.includes("Just a moment, said the minister"), text);
});

// =====================================================================================================
// Character sets
// =====================================================================================================

// The page's text as windows-1252 bytes: the five accented or typographic characters by hand, the rest ASCII.
function windows1252Page(headTags: string) {
	const before = Buffer.from(
		`<!doctype html>\n<html>\n<head>\n${headTags}\n</head>\n<body>\n<p>`,
		"latin1",
	);
	// Café crème — l’été, naïve, with é E9, è E8, — 97, ’ 92, ï EF.
	const text = Buffer.from([
		0x43, 0x61, 0x66, 0xe9, 0x20, 0x63, 0x72, 0xe8, 0x6d, 0x65, 0x20, 0x97,
		0x20, 0x6c, 0x92, 0xe9, 0x74, 0xe9, 0x2c, 0x20, 0x6e, 0x61, 0xef, 0x76,
		0x65,
	]);
	const after = Buffer.from("</p>\n</body>\n</html>\n", "latin1");
	return Buffer.concat([before, text, after]);
}

test("a windows-1252 page declared by <meta http-equiv> is read in windows-1252", async () => {
	const head =
		'<meta http-equiv="Content-Type" content="text/html; charset=windows-1252">';
	useStandIn(() => ({
		status: 200,
		type: "text/html",
		body: windows1252Page(head),
	}));
	const text = printedText(
		await runOnItem(`${standIn.url}/news/http-equiv.html`),
	);
	assert.ok(text.normalize("NFC").includes(CAFE), text);
});

test("the Content-Type header's character set wins over the page's own <meta charset>", async () => {
	useStandIn(() => ({
		status: 200,
		type: "text/html; charset=windows-1252",
		body: windows1252Page('<meta charset="utf-8">'),
	}));
	const text = printedText(
		await runOnItem(`${standIn.url}/news/header-wins.html`),
	);
	assert.ok(text.normalize("NFC").includes(CAFE), text);
});

// =====================================================================================================
// Guards: only the public internet, and the one local address LIMINAL_ALLOW_LOCAL names
// =====================================================================================================

// The refusal line for `url`, whose host `host` (no port) is on this Mac or a private network.
function notPublicLine(url: string, host: string) {
	return `fulltext.sh: could not fetch ${url}: "${host}" is not on the public internet`;
}

// [item, URL refused, host named]. The address ranges are tests/unit/local-address.test.ts's, in process. This name is
// the one only a real run checks: a ".localhost" name the resolver answers for this Mac.
const NOT_PUBLIC: [string, string, string][] = [
	[
		"http://liminal-test.localhost:8765/a",
		"http://liminal-test.localhost:8765/a",
		"liminal-test.localhost",
	],
];

for (const row of NOT_PUBLIC) {
	test(`security: ${row[0]} is refused as not on the public internet, and nothing is fetched or written`, async () => {
		useStandIn(servesEverything);
		const outDir = tempDir("out");
		const result = await run([row[0], outDir], undefined, {
			LIMINAL_ALLOW_LOCAL: undefined,
		});
		assertFailed(result);
		assertStderrLine(result, notPublicLine(row[1], row[2]));
		assert.deepEqual(requestedPaths(), []);
		assert.deepEqual(fs.readdirSync(outDir), []);
		assert.deepEqual(filesUnder(result.tmpDir), []);
	});
}

test("security: the local test server is refused without LIMINAL_ALLOW_LOCAL", async () => {
	useStandIn(servesEverything);
	const url = `${standIn.url}/news/ferry.html`;
	const outDir = tempDir("out");
	const result = await run([url, outDir], undefined, {
		LIMINAL_ALLOW_LOCAL: undefined,
	});
	assertFailed(result);
	assertStderrLine(result, notPublicLine(url, "127.0.0.1"));
	assert.deepEqual(requestedPaths(), []);
});

// A second listener on another port of 127.0.0.1, counting requests.
async function otherListener(): Promise<OtherListener> {
	const server = http.createServer((_request, response) => {
		other.requests += 1;
		response.end("secret");
	});
	// The port is set once the server listens.
	const other: OtherListener = { port: 0, requests: 0, server: server };
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(
		address !== null && typeof address === "object",
		"the listener listens on a port",
	);
	other.port = address.port;
	return other;
}

test("security: LIMINAL_ALLOW_LOCAL allows only its own address, so another port on 127.0.0.1 is refused", async () => {
	const other = await otherListener();
	try {
		useStandIn(servesEverything);
		const url = `http://127.0.0.1:${other.port}/page.html`;
		const result = await runOnItem(url);
		assertFailed(result);
		assertStderrLine(result, notPublicLine(url, "127.0.0.1"));
		assert.equal(other.requests, 0);
	} finally {
		other.server.close();
	}
});

test("security: a redirect to a private address is refused before any request to it", async () => {
	useStandIn(
		redirectsTo("/news/moved.html", "http://169.254.169.254/latest/meta-data"),
	);
	const url = `${standIn.url}/news/moved.html`;
	const result = await runOnItem(url);
	assertFailedCleanly(result);
	assertStderrLine(
		result,
		`fulltext.sh: could not fetch ${url}: redirect to http://169.254.169.254/latest/meta-data: "169.254.169.254" is not on the public internet`,
	);
});

// /hop/<n> redirects to /hop/<n + 1> until /hop/<count>, which redirects to the article.
function chainOf(count: number): Answerer {
	return (urlPath) => {
		const match = urlPath.match(/^\/hop\/(\d+)$/);
		if (match === null) {
			return servesEverything(urlPath);
		}
		const n = Number(match[1]);
		let location = `/hop/${n + 1}`;
		if (n === count) {
			location = "/news/ferry.html";
		}
		return {
			status: 302,
			type: "text/html; charset=utf-8",
			body: "",
			location: location,
		};
	};
}

test("limit: a chain of 6 redirects fails as too many redirects for the URL, and no file is printed or left", async () => {
	useStandIn(chainOf(6));
	const url = `${standIn.url}/hop/1`;
	const result = await runOnItem(url);
	assertFailedCleanly(result);
	assertStderrLineStartingWith(
		result,
		`fulltext.sh: could not fetch ${url}: `,
		"too many redirects",
	);
	assert.ok(
		!requestedPaths().includes("/news/ferry.html"),
		"the article after the 6th redirect was not asked for",
	);
});

// =====================================================================================================
// Guards: the output folder must be inside TMPDIR or /private/tmp
// =====================================================================================================

// macOS only: /private/tmp is where macOS keeps /tmp; Linux has no /private.
test.skipIf(process.platform !== "darwin")(
	"an output folder in /private/tmp is allowed",
	async () => {
		useStandIn(servesEverything);
		const dir = fs.mkdtempSync("/private/tmp/liminal-fulltext-unit-private-");
		tempDirs.push(dir);
		const text = printedText(await run(["arxiv:2507.11473", dir]));
		assert.ok(text.includes("Page one of 2507.11473"), text);
	},
);

test("security: an output folder outside the temporary folders is refused before anything is fetched or written", async () => {
	useStandIn(servesEverything);
	const dir = path.join(import.meta.dirname, "not-a-temporary-folder");
	tempDirs.push(dir);
	const result = await run(["arxiv:2507.11473", dir]);
	assert.notEqual(result.code, 0);
	assert.match(result.stderr, /is not inside TMPDIR or /);
	assert.equal(fs.existsSync(dir), false);
	assert.deepEqual(standIn.log, []);
});

test("a converter that runs past its time limit is stopped", async () => {
	// Fake converters that never finish.
	const bin = tempDir("bin");
	const pids = tempDir("pids");
	for (const [name, body] of [
		["pdftotext", `echo $$ > "${pids}/pdftotext"\nexec sleep 30`],
		["w3m", `echo $$ > "${pids}/w3m"\nexec sleep 30`],
		["uname", "echo Linux"],
	]) {
		fs.writeFileSync(path.join(bin, `${name}`), `#!/bin/sh\n${body}\n`, {
			mode: 0o755,
		});
	}
	useStandIn(servesEverything);
	const slowPath = `${bin}:${process.env.PATH}`;
	const limit = { PATH: slowPath, CONVERTER_TIMEOUT_SECONDS: "1" };
	const started = Date.now();
	const pdf = await runOnItem("2507.11473", undefined, limit);
	const page = await runOnItem(
		`${standIn.url}/news/ferry.html`,
		undefined,
		limit,
	);
	assert.ok(Date.now() - started < 15_000, "both runs ended long before 30 s");
	for (const [result, converter] of [
		[pdf, "pdftotext"],
		[page, "w3m"],
	] as const) {
		assert.equal(result.code, 1, result.stderr);
		assert.match(
			result.stderr,
			new RegExp(`fulltext.sh: ${converter} ran more than 1 seconds`),
		);
		assert.equal(result.stdout, "");
		assert.deepEqual(filesUnder(result.outDir), []);
		const pid = Number(fs.readFileSync(path.join(pids, converter), "utf8"));
		assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
	}
});
