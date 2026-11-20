// Unit tests for the exports of scripts/scout/scout.ts: scoutOptions and scoutPrompt, which build the options and the
// prompt a scout run hands the Agent SDK, shellSyntaxProblem and refuseShellSyntax, which refuse a Bash command
// holding shell syntax before the allow list reads it, logSection, which writes a run's section of
// .scout-logs/<date>.md, and stderrFailure, which decides what stderr may say about a failed session.
// Every input is written out here, and so is every expected value.

import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	HookJSONOutput,
	Options,
	PreToolUseHookInput,
	SDKPermissionDenial,
	SDKResultError,
	SDKResultSuccess,
	Settings,
} from "@anthropic-ai/claude-agent-sdk";
import { afterAll, test } from "vitest";
import type * as Arxiv from "../../scripts/scout/arxiv/api.ts";
import type * as Scout from "../../scripts/scout/scout.ts";
import {
	bashAllowRules,
	commandLinesIn,
	filledIn,
	ruleMatches,
} from "./allow-list-readers.ts";
import {
	removeTempFolders,
	runScript,
	scriptPath,
	tempFolder,
} from "./run-script.ts";

const SCRIPT = new URL("../../scripts/scout/scout.ts", import.meta.url);

// Importing the script must not start a run. If it did, the run would see this argument, which the runner refuses: it
// prints its usage line and exits 1, failing this file, instead of starting a real run that asks a model.
process.argv.push("--refused-by-the-scout-unit-tests");

// scoutOptions reads scripts/scout/scout.md under the repo it is given, so each repo here is a real folder holding one.
const INSTRUCTIONS = "# The Liminal scout\n\nUnit-test instructions.\n";
const REPOS = mkdtempSync(join(tmpdir(), "liminal-unit-scout-repos-"));
afterAll(() => {
	rmSync(REPOS, { recursive: true, force: true });
});
function makeRepo(name: string): string {
	const repo = join(REPOS, name);
	mkdirSync(join(repo, "scripts", "scout"), { recursive: true });
	writeFileSync(join(repo, "scripts", "scout", "scout.md"), INSTRUCTIONS);
	return repo;
}
const REPO = makeRepo("liminal-space");
const HOME = "/Users/ada";
const SCRATCH = "/private/var/folders/xy/T/liminal-scout-AbC123";

// The cache folder feedback.json is in (scripts/lib/feedback.ts feedbackPath reads LIMINAL_CACHE), so the options name a
// path written out here and never the owner's own .cache/.
const CACHE = "/Users/ada/liminal-cache";
process.env.LIMINAL_CACHE = CACHE;

// The deny rules of every run: no cd, and no read of the owner's read marks, of feedback.json or of /proc. No Edit deny:
// Claude Code's sandbox would make its path unwritable for the scout's scripts too. "//" starts an absolute path in a
// permission rule.
const DENY = [
	"Bash(cd *)",
	`Read(/${REPO}/site/digests.read.json)`,
	"Read(//Users/ada/liminal-cache/feedback.json)",
	"Read(//proc/**)",
];

// A process environment holding the five variables the scout keeps and three it must not get.
const ENV = {
	HOME: "/Users/ada",
	PATH: "/opt/homebrew/bin:/usr/bin:/bin",
	USER: "ada",
	TMPDIR: "/var/folders/xy/T/",
	LANG: "en_GB.UTF-8",
	ANTHROPIC_API_KEY: "unit-test-api-key-1f7c",
	CLAUDE_CODE_PLUGIN_DIRS: "/Users/ada/.claude/mods/status-band",
	SECRET_TOKEN: "unit-test-secret-token-6b0d",
};

// The same environment without LANG.
const ENV_WITHOUT_LANG = {
	HOME: "/Users/ada",
	PATH: "/opt/homebrew/bin:/usr/bin:/bin",
	USER: "ada",
	TMPDIR: "/var/folders/xy/T/",
	SECRET_TOKEN: "unit-test-secret-token-6b0d",
};

// The options' settings: an object, never the path to a settings file.
function settingsOf(options: Options): Settings {
	const settings = options.settings;
	assert.ok(typeof settings === "object", "the options hold a settings object");
	return settings;
}

// The permission rules in the options' settings.
function permissionsOf(options: Options) {
	const permissions = settingsOf(options).permissions;
	assert.ok(permissions !== undefined, "the settings hold permissions");
	return permissions;
}

// The environment the options hand the session.
function envOf(options: Options) {
	const env = options.env;
	assert.ok(env !== undefined, "the options hold an environment");
	return env;
}

test("security: The scout runs with the project's settings only, and none of the owner's", async () => {
	const { scoutOptions }: typeof Scout = await import(SCRIPT.href);
	const options = scoutOptions({
		repo: REPO,
		home: HOME,
		scratch: SCRATCH,
		env: ENV,
	});

	assert.equal(options.cwd, REPO);
	assert.deepEqual(options.settingSources, ["project"]);
	assert.deepEqual(settingsOf(options).claudeMdExcludes, ["**"]);
	assert.equal(settingsOf(options).disableClaudeAiConnectors, true);
	assert.equal(settingsOf(options).autoMemoryEnabled, false);
	assert.equal(settingsOf(options).disableAllHooks, true);
	assert.equal(settingsOf(options).disableBundledSkills, true);
	assert.equal(options.strictMcpConfig, true);
	assert.deepEqual(options.mcpServers, {});
	assert.deepEqual(options.plugins, []);
	assert.equal(options.permissionMode, "dontAsk");
});

// Scenario "The scout can't change folder": the deny rules, a list in settings.permissions.deny, hold "Bash(cd *)".
test("security: The scout can't change folder", async () => {
	const { scoutOptions }: typeof Scout = await import(SCRIPT.href);
	const options = scoutOptions({
		repo: REPO,
		home: HOME,
		scratch: SCRATCH,
		env: ENV,
	});

	const deny = permissionsOf(options).deny;
	assert.ok(Array.isArray(deny), "settings.permissions.deny is a list");
	assert.equal(
		deny.includes("Bash(cd *)"),
		true,
		`settings.permissions.deny was ${JSON.stringify(deny)}`,
	);
});

// Scenario "Only a few environment variables reach the scout".
test("privacy: Only HOME, PATH, USER, TMPDIR and LANG pass from the environment to the scout, next to three variables the scout sets itself", async () => {
	const { scoutOptions }: typeof Scout = await import(SCRIPT.href);
	const options = scoutOptions({
		repo: REPO,
		home: HOME,
		scratch: SCRATCH,
		env: ENV,
	});

	assert.deepEqual(options.env, {
		HOME: "/Users/ada",
		PATH: "/opt/homebrew/bin:/usr/bin:/bin",
		USER: "ada",
		TMPDIR: "/var/folders/xy/T/",
		LANG: "en_GB.UTF-8",
		CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
		BASH_MAX_TIMEOUT_MS: "1800000",
		CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
	});
	const json = JSON.stringify(options);
	assert.equal(
		json.includes("unit-test-api-key-1f7c"),
		false,
		"the value of ANTHROPIC_API_KEY is in the options",
	);
	const pluginDirsKept = json.includes("/Users/ada/.claude/mods/status-band");
	assert.equal(
		pluginDirsKept,
		false,
		"the value of CLAUDE_CODE_PLUGIN_DIRS is in the options",
	);
	assert.equal(
		json.includes("unit-test-secret-token-6b0d"),
		false,
		"the value of SECRET_TOKEN is in the options",
	);
});

// The contract: LANG defaults to en_US.UTF-8 when the environment has none.
test("LANG is en_US.UTF-8 when the environment has none", async () => {
	const { scoutOptions }: typeof Scout = await import(SCRIPT.href);
	const options = scoutOptions({
		repo: REPO,
		home: HOME,
		scratch: SCRATCH,
		env: ENV_WITHOUT_LANG,
	});

	assert.deepEqual(options.env, {
		HOME: "/Users/ada",
		PATH: "/opt/homebrew/bin:/usr/bin:/bin",
		USER: "ada",
		TMPDIR: "/var/folders/xy/T/",
		LANG: "en_US.UTF-8",
		CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
		BASH_MAX_TIMEOUT_MS: "1800000",
		CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
	});
});

// The value is the scout's own, not the process's: a process environment that sets it to '0' still gives '1'.
test("CLAUDE_CODE_DISABLE_BACKGROUND_TASKS is 1 even when the environment sets it to 0", async () => {
	const { scoutOptions }: typeof Scout = await import(SCRIPT.href);
	const env = Object.assign({}, ENV, {
		CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "0",
	});
	const options = scoutOptions({
		repo: REPO,
		home: HOME,
		scratch: SCRATCH,
		env: env,
	});

	assert.equal(envOf(options).CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, "1");
});

// Scenario "A scratch folder for each run": the scratch folder is the only path outside the repo the options allow.
// A rule path starting with "//" is absolute in Claude Code's rule syntax. The two deny rules allow nothing: no cd,
// and no edit of a file in the repo (scenario "The options deny editing any file in the repo").
test("security: The options allow the scratch folder and no other path outside the repo", async () => {
	const { scoutOptions }: typeof Scout = await import(SCRIPT.href);
	const options = scoutOptions({
		repo: REPO,
		home: HOME,
		scratch: SCRATCH,
		env: ENV,
	});

	assert.deepEqual(options.additionalDirectories, [
		"/private/var/folders/xy/T/liminal-scout-AbC123",
	]);
	assert.deepEqual(settingsOf(options).permissions, {
		allow: [
			"Edit(//private/var/folders/xy/T/liminal-scout-AbC123/**)",
			"Read(//private/var/folders/xy/T/liminal-scout-AbC123/**)",
		],
		deny: DENY,
	});
});

// Two runs, two scratch folders: each run's options name its own folder only.
test("Each run's options name its own scratch folder", async () => {
	const { scoutOptions }: typeof Scout = await import(SCRIPT.href);
	const first = scoutOptions({
		repo: REPO,
		home: HOME,
		scratch: "/var/folders/xy/T/liminal-scout-one111",
		env: ENV,
	});
	const second = scoutOptions({
		repo: REPO,
		home: HOME,
		scratch: "/var/folders/xy/T/liminal-scout-two222",
		env: ENV,
	});

	assert.deepEqual(first.additionalDirectories, [
		"/var/folders/xy/T/liminal-scout-one111",
	]);
	assert.deepEqual(permissionsOf(first).allow, [
		"Edit(//var/folders/xy/T/liminal-scout-one111/**)",
		"Read(//var/folders/xy/T/liminal-scout-one111/**)",
	]);
	assert.deepEqual(second.additionalDirectories, [
		"/var/folders/xy/T/liminal-scout-two222",
	]);
	assert.deepEqual(permissionsOf(second).allow, [
		"Edit(//var/folders/xy/T/liminal-scout-two222/**)",
		"Read(//var/folders/xy/T/liminal-scout-two222/**)",
	]);
	const namesTheOther = JSON.stringify(first).includes("liminal-scout-two222");
	assert.equal(
		namesTheOther,
		false,
		"the first run's options name the second's folder",
	);
});

// Rule "The scout reads no file outside the repo and its scratch folder": feedback.json is denied where LIMINAL_CACHE
// puts it, also when that is outside the repo, and a relative LIMINAL_CACHE is written as an absolute path (a rule
// path with one "/" would be read from the repo).
test("security: Reading feedback.json is denied in the LIMINAL_CACHE folder, and a relative LIMINAL_CACHE is made absolute", async () => {
	const { scoutOptions }: typeof Scout = await import(SCRIPT.href);
	const run = { repo: REPO, home: HOME, scratch: SCRATCH, env: ENV };
	try {
		process.env.LIMINAL_CACHE = "/srv/cache with space";
		assert.ok(
			permissionsOf(scoutOptions(run)).deny?.includes(
				"Read(//srv/cache with space/feedback.json)",
			),
			"the deny names feedback.json in an absolute LIMINAL_CACHE",
		);
		process.env.LIMINAL_CACHE = "relative-cache";
		const relative = permissionsOf(scoutOptions(run)).deny || [];
		assert.ok(
			relative.includes(
				`Read(/${join(process.cwd(), "relative-cache", "feedback.json")})`,
			),
			`the deny names feedback.json by its absolute path; the rules were ${JSON.stringify(relative)}`,
		);
	} finally {
		process.env.LIMINAL_CACHE = CACHE;
	}
});

// Rule "A command can't set a variable for the script it runs": a leading NAME=value is refused, whatever follows.
const ASSIGNMENTS = [
	"NODE_OPTIONS=--require=/tmp/x.js node scripts/digests/digests.ts status site/digests.js",
	"LIMINAL_ALLOW_LOCAL=127.0.0.1:80 scripts/scout/web/fulltext.sh http://127.0.0.1/ /tmp/out",
	"ARXIV_API=https://example.com node scripts/scout/arxiv/arxiv.ts --append site/digests.js 2507.11473",
	"TZ=UTC date +%F",
	"A=1 B=2 node scripts/digests/digests.ts status site/digests.js",
	// The forms a shell also reads as an assignment: leading blanks, "+=", an array element, an empty value.
	"  NODE_OPTIONS=x node scripts/digests/digests.ts status site/digests.js",
	"NODE_OPTIONS+=x node scripts/digests/digests.ts status site/digests.js",
	"a[0]=1 node scripts/digests/digests.ts status site/digests.js",
	"NODE_OPTIONS= node scripts/digests/digests.ts status site/digests.js",
	// The date command with anything changed is no longer the one the Scout part names.
	"TZ=Asia/Jakarta date +%F -u",
	"TZ=Asia/Jakarta  date +%F",
];

for (const command of ASSIGNMENTS) {
	test(`security: A command that starts with a variable assignment is refused: ${command}`, async () => {
		const { shellSyntaxProblem }: typeof Scout = await import(SCRIPT.href);

		assert.equal(shellSyntaxProblem(command), "a variable assignment");
	});
}

// An "=" that doesn't start the command is text: an argument, quoted or not.
const NOT_ASSIGNMENTS = [
	"TZ=Asia/Jakarta date +%F",
	"node scripts/scout/web/describe.ts site/digests.js --summary 'https://example.com/a' 'x=1 holds'",
	"node scripts/scout/arxiv/first-page.ts 2507.11473 x=1",
	"scripts/scout/web/fulltext.sh 'https://example.com/x?y=1' /tmp/liminal-scout-abc",
];

for (const command of NOT_ASSIGNMENTS) {
	test(`security: A command that does not start with a variable assignment passes the shell-syntax check: ${command}`, async () => {
		const { shellSyntaxProblem }: typeof Scout = await import(SCRIPT.href);

		assert.equal(shellSyntaxProblem(command), null);
	});
}

// The contract: --dry-run prints the options exactly as listed, so the whole object is compared, with no other key.
// The one hook is the exported refuseShellSyntax itself (compared by reference), on PreToolUse for Bash only.
test("The scout's options hold exactly these settings, with the shell-syntax check on Bash calls, and no other key", async () => {
	const { scoutOptions, refuseShellSyntax }: typeof Scout = await import(
		SCRIPT.href
	);
	const options = scoutOptions({
		repo: REPO,
		home: HOME,
		scratch: SCRATCH,
		env: ENV,
	});

	assert.deepEqual(options, {
		cwd: REPO,
		settingSources: ["project"],
		systemPrompt: {
			type: "preset",
			preset: "claude_code",
			append: INSTRUCTIONS,
		},
		settings: {
			claudeMdExcludes: ["**"],
			disableClaudeAiConnectors: true,
			autoMemoryEnabled: false,
			disableAllHooks: true,
			disableBundledSkills: true,
			permissions: {
				allow: [
					"Edit(//private/var/folders/xy/T/liminal-scout-AbC123/**)",
					"Read(//private/var/folders/xy/T/liminal-scout-AbC123/**)",
				],
				deny: DENY,
			},
		},
		hooks: { PreToolUse: [{ matcher: "Bash", hooks: [refuseShellSyntax] }] },
		additionalDirectories: ["/private/var/folders/xy/T/liminal-scout-AbC123"],
		strictMcpConfig: true,
		mcpServers: {},
		plugins: [],
		permissionMode: "dontAsk",
		// Which model and effort is a setting, not a rule: only their keys are checked.
		model: options.model,
		effort: options.effort,
		env: {
			HOME: "/Users/ada",
			PATH: "/opt/homebrew/bin:/usr/bin:/bin",
			USER: "ada",
			TMPDIR: "/var/folders/xy/T/",
			LANG: "en_GB.UTF-8",
			CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
			BASH_MAX_TIMEOUT_MS: "1800000",
			CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
		},
	});
});

// Scenario "The prompt": it starts with the scout's role line and names the date and the scratch folder it was given.
test("The prompt gives the scout's role, the day and the scratch folder", async () => {
	const { scoutPrompt }: typeof Scout = await import(SCRIPT.href);
	const prompt = scoutPrompt({ today: "2026-10-06", scratch: SCRATCH });

	assert.equal(
		prompt,
		"You are the Liminal scout. Today is 2026-10-06. Your scratchpad directory is " +
			"/private/var/folders/xy/T/liminal-scout-AbC123: write temporary files, such as items.json, there.",
	);
});

// Another day and another folder give another prompt: neither is fixed in the script.
test("The prompt names the day and folder it is given", async () => {
	const { scoutPrompt }: typeof Scout = await import(SCRIPT.href);
	const prompt = scoutPrompt({
		today: "2027-01-31",
		scratch: "/var/folders/zz/T/liminal-scout-Q9w8E7",
	});

	assert.equal(
		prompt,
		"You are the Liminal scout. Today is 2027-01-31. Your scratchpad directory is " +
			"/var/folders/zz/T/liminal-scout-Q9w8E7: write temporary files, such as items.json, there.",
	);
});

// =====================================================================================================
// shellSyntaxProblem and refuseShellSyntax (Rule "The scout can't use shell syntax in a command, and can't edit a
// file in the repo"). shellSyntaxProblem(command) returns null when the command may go on, else what was found; the
// PreToolUse hook refuseShellSyntax runs it on every Bash call.
// =====================================================================================================

// A refused command of the feature's outline, with the "what" column: what the problem must name.
type RefusedRow = { command: string; what: string };

// The rows of "A command with shell syntax outside quotes is refused: <what>", as the feature writes them.
const REFUSED: RefusedRow[] = [
	{
		command: "node scripts/digests/digests.ts status site/digests.js > out.txt",
		what: "a redirect",
	},
	{
		command:
			"node scripts/digests/digests.ts status site/digests.js >> site/digests.js",
		what: "a redirect",
	},
	{
		command: "node scripts/digests/digests.ts status site/digests.js 2>&1",
		what: "a redirect",
	},
	{
		command:
			"node scripts/digests/digests.ts status site/digests.js < interests.md",
		what: "a redirect",
	},
	{
		command: "node scripts/digests/digests.ts status site/digests.js | tee x",
		what: "a pipe",
	},
	{
		command:
			"node scripts/digests/digests.ts status site/digests.js && echo hi",
		what: '"&&"',
	},
	{
		command: "node scripts/digests/digests.ts status site/digests.js ; echo hi",
		what: '";"',
	},
	{
		command: "node scripts/digests/digests.ts status site/digests.js &",
		what: '"&"',
	},
	{
		command: "node scripts/scout/arxiv/first-page.ts $(echo 2507.11473)",
		what: '"$("',
	},
	{
		command: "node scripts/scout/arxiv/first-page.ts `echo 2507.11473`",
		what: "a backquote",
	},
	{
		command: 'node scripts/scout/web/describe.ts site/digests.js "$HOME"',
		what: '"$" in quotes',
	},
	{
		command:
			"node scripts/scout/web/describe.ts site/digests.js 'https://example.com/a",
		what: "an unbalanced quote",
	},
	{
		command: "{ node scripts/digests/digests.ts status site/digests.js; }",
		what: '"{"',
	},
	{
		command: "(node scripts/digests/digests.ts status site/digests.js)",
		what: '"("',
	},
	{
		command: "node scripts/digests/digests.ts status site\\/digests.js",
		what: "a backslash",
	},
];

// The rows of "Text in quotes is inert: <command>", as the feature writes them.
const INERT: string[] = [
	"node scripts/scout/web/describe.ts site/digests.js 'https://example.com/a?b=1&c=2'",
	"node scripts/scout/web/describe.ts site/digests.js --summary 'https://example.com/a' 'A sentence (with brackets); a $5 figure.'",
	"node scripts/scout/web/describe.ts site/digests.js --summary 'https://example.com/a' 'The brain'\\''s map of time.'",
	"scripts/scout/web/fulltext.sh 'https://example.com/x?y=1&z=2' /tmp/liminal-scout-abc",
	'node scripts/scout/web/describe.ts site/digests.js "https://example.com/a?b=1&c=2"',
	'node scripts/scout/arxiv/arxiv.ts --append site/digests.js --venue "FAccT 2026" --venue-source https://example.com/list 2507.11473',
	"TZ=Asia/Jakarta date +%F",
];

// Whether a problem names what the feature's "what" column says, read loosely: a quoted token ("&&", "$(", "{") must
// appear in the problem as it is; a noun phrase ("a redirect", "an unbalanced quote") is matched on its first word
// after the article, in any case, so "redirect to out.txt" and "an unbalanced single quote" both pass.
function namesWhat(problem: string, what: string): boolean {
	const quoted = what.match(/^"(.+)"( in quotes)?$/);
	if (quoted !== null && quoted[1] !== undefined) {
		return problem.includes(quoted[1]);
	}
	const words = what.split(" ").filter((word) => word !== "a" && word !== "an");
	const noun = words[0];
	assert.ok(noun !== undefined, `the "what" column has a word: ${what}`);
	return problem.toLowerCase().includes(noun.toLowerCase());
}

for (const row of REFUSED) {
	test(`security: A command with shell syntax outside quotes is refused, naming ${row.what}: ${row.command}`, async () => {
		const { shellSyntaxProblem }: typeof Scout = await import(SCRIPT.href);
		const problem = shellSyntaxProblem(row.command);

		assert.equal(
			typeof problem,
			"string",
			`the command is refused; the check returned ${JSON.stringify(problem)}`,
		);
		assert.ok(
			typeof problem === "string" && problem.length > 0,
			"the problem is not empty",
		);
		assert.ok(
			typeof problem === "string" && namesWhat(problem, row.what),
			`the problem names ${row.what}; it was ${JSON.stringify(problem)}`,
		);
	});
}

// Scenario "A command over two lines is refused": the newline is shell syntax too (a second command).
test("security: A command over two lines is refused, naming a newline", async () => {
	const { shellSyntaxProblem }: typeof Scout = await import(SCRIPT.href);
	const problem = shellSyntaxProblem(
		"node scripts/digests/digests.ts status site/digests.js\necho hi",
	);

	assert.equal(
		typeof problem,
		"string",
		`the command is refused; the check returned ${JSON.stringify(problem)}`,
	);
	assert.ok(
		typeof problem === "string" && namesWhat(problem, "a newline"),
		`the problem names a newline; it was ${JSON.stringify(problem)}`,
	);
});

for (const command of INERT) {
	test(`security: Text in quotes is not read as shell syntax: ${command}`, async () => {
		const { shellSyntaxProblem }: typeof Scout = await import(SCRIPT.href);

		assert.equal(shellSyntaxProblem(command), null);
	});
}

// The command lines are read from scripts/scout/scout.md, the scout's instructions, by the readers in
// tests/unit/allow-list-readers.ts.
const SCOUT_MD = new URL("../../scripts/scout/scout.md", import.meta.url);

test("Every command scripts/scout/scout.md names passes the shell-syntax check", async () => {
	const { shellSyntaxProblem }: typeof Scout = await import(SCRIPT.href);
	const instructions = readFileSync(SCOUT_MD, "utf8");
	const commands = commandLinesIn(instructions.split("\n")).map((command) =>
		filledIn(command, "site/digests.js", SCRATCH),
	);
	assert.ok(
		commands.length > 12,
		`scripts/scout/scout.md names more than a dozen commands; found:\n${commands.join("\n")}`,
	);

	const refused = commands
		.map((command) => ({ command, problem: shellSyntaxProblem(command) }))
		.filter((checked) => checked.problem !== null);
	assert.deepEqual(refused, [], "commands the shell-syntax check refuses");
});

// A PreToolUse hook input as the SDK sends it for one tool call, with the fields PreToolUseHookInput requires.
function preToolUse(toolName: string, toolInput: unknown): PreToolUseHookInput {
	return {
		hook_event_name: "PreToolUse",
		tool_name: toolName,
		tool_input: toolInput,
		tool_use_id: "toolu_01UnitTestShellSyntax0001",
		session_id: "8f14e45f-ceea-467f-a8e9-2a1c3b5d7e90",
		transcript_path:
			"/Users/ada/.claude/projects/-Users-ada-liminal-space/8f14e45f-ceea-467f-a8e9-2a1c3b5d7e90.jsonl",
		cwd: REPO,
	};
}

// The hook's answer to an input, called as the SDK calls a HookCallback.
async function hookAnswer(input: PreToolUseHookInput): Promise<HookJSONOutput> {
	const { refuseShellSyntax }: typeof Scout = await import(SCRIPT.href);
	return refuseShellSyntax(input, input.tool_use_id, {
		signal: new AbortController().signal,
	});
}

// The PreToolUse-specific part of a hook's answer; fails when the answer has none.
function preToolUseOutput(answer: HookJSONOutput) {
	assert.ok(
		"hookSpecificOutput" in answer && answer.hookSpecificOutput !== undefined,
		`the answer has hookSpecificOutput; it was ${JSON.stringify(answer)}`,
	);
	const output = answer.hookSpecificOutput;
	assert.equal(output.hookEventName, "PreToolUse");
	assert.ok(
		output.hookEventName === "PreToolUse",
		"the hook-specific output is PreToolUse's",
	);
	return output;
}

// Scenario "A Bash call the check refuses is denied with the reason".
test("security: A Bash call the check refuses is denied with the reason", async () => {
	const answer = await hookAnswer(
		preToolUse("Bash", {
			command:
				"node scripts/digests/digests.ts status site/digests.js > out.txt",
		}),
	);

	const output = preToolUseOutput(answer);
	assert.equal(output.permissionDecision, "deny");
	const reason = output.permissionDecisionReason;
	assert.equal(typeof reason, "string", "the deny has a reason");
	assert.ok(
		typeof reason === "string" && /redirect/i.test(reason),
		`the reason names a redirect; it was ${JSON.stringify(reason)}`,
	);
});

// Scenario Outline "The hook leaves <call> to the allow list": an empty answer, so the allow list decides.
test("The shell-syntax check leaves a Bash call without shell syntax to the allow list", async () => {
	const answer = await hookAnswer(
		preToolUse("Bash", {
			command: "node scripts/digests/digests.ts status site/digests.js",
		}),
	);

	assert.deepEqual(answer, {});
});

test("The shell-syntax check leaves a Read call to the allow list", async () => {
	const answer = await hookAnswer(
		preToolUse("Read", { file_path: "/Users/ada/liminal-space/interests.md" }),
	);

	assert.deepEqual(answer, {});
});

test("The shell-syntax check leaves a WebFetch call to the allow list", async () => {
	const answer = await hookAnswer(
		preToolUse("WebFetch", {
			url: "https://example.com/",
			prompt: "What does the page say?",
		}),
	);

	assert.deepEqual(answer, {});
});

// Scenario "A Bash call without command text is denied": nothing to check, so nothing may run.
test("security: A Bash call without command text is denied", async () => {
	const answer = await hookAnswer(preToolUse("Bash", { description: "hm" }));

	const output = preToolUseOutput(answer);
	assert.equal(output.permissionDecision, "deny");
});

// =====================================================================================================
// logSection: a run's section of .scout-logs/<date>.md (@manual scenarios "A real run" and "Refused tool calls are in
// the log"). It is called as logSection(started, ended, outcome, failure), where outcome is
// { result, problem } and result is the SDK's final result message, or null.
// =====================================================================================================

const STARTED = new Date("2026-10-06T00:30:00.000Z");
const ENDED = new Date("2026-10-06T00:52:10.000Z");
const SESSION_ID = "8f14e45f-ceea-467f-a8e9-2a1c3b5d7e90";
// The scout's final message has one line per entry. The contract doesn't say how the section sets it out (as it is,
// quoted, in a code block), so the tests look for each line rather than for the two lines joined.
const FINAL_FIRST_LINE =
	"paper · Attention Is All You Need · https://arxiv.org/abs/1706.03762";
const FINAL_LAST_LINE =
	"news · A headline from the stand-in · https://example.org/news/1";
const FINAL_MESSAGE = `${FINAL_FIRST_LINE}\n${FINAL_LAST_LINE}`;
const FINAL_HEADING = "### Final message";
const REFUSED_HEADING = "### Refused by the allow list";

// A final result message shaped as the Agent SDK sends it at the end of a run, refusing the tool calls given.
// Only the fields logSection reads are built; the SDK's timing and usage fields are left out, so the type is asserted.
function finalResult(
	permissionDenials: SDKPermissionDenial[],
): SDKResultSuccess {
	return {
		type: "result",
		subtype: "success",
		is_error: false,
		result: FINAL_MESSAGE,
		total_cost_usd: 1.25,
		num_turns: 42,
		session_id: SESSION_ID,
		permission_denials: permissionDenials,
	} as SDKResultSuccess;
}

// The lines after the section's "### Refused by the allow list" heading, which the contract puts at the section's end.
// The heading must be a line of its own and appear once. Blank lines at the very end are dropped: they separate this
// section from the next run's, and the contract leaves them open.
function linesAfterRefusedHeading(section: string) {
	const lines = section.split("\n");
	const headingAt = lines.indexOf(REFUSED_HEADING);
	assert.notEqual(
		headingAt,
		-1,
		`the section has the line "${REFUSED_HEADING}"; it was:\n${section}`,
	);
	const headingOnce = lines.lastIndexOf(REFUSED_HEADING) === headingAt;
	assert.equal(
		headingOnce,
		true,
		`the heading appears once; the section was:\n${section}`,
	);

	const after = lines.slice(headingAt + 1);
	let last = after[after.length - 1];
	while (last !== undefined && last.trim() === "") {
		after.pop();
		last = after[after.length - 1];
	}
	return after;
}

// The part reads "(none)": the one non-blank line after the heading. (The contract doesn't say whether a blank line
// comes between them, so this doesn't check that.)
function assertRefusedNone(section: string) {
	const after = linesAfterRefusedHeading(section);
	const nonBlank = after.filter((line) => line.trim() !== "");
	assert.deepEqual(nonBlank, ["(none)"], `the section was:\n${section}`);
}

// Scenario "Refused tool calls are in the log": each refused call gets a line "- <tool_name>: <what>", in the order of
// permission_denials, after a blank line. <what> is the command, else the file path, else the URL, else the whole input
// as JSON. The order given here is not alphabetical, so a sorted list would fail.
test('The run\'s log lists the refused tool calls under "Refused by the allow list", one line each, in order', async () => {
	const { logSection }: typeof Scout = await import(SCRIPT.href);
	const result = finalResult([
		{
			tool_name: "Write",
			tool_use_id: "toolu_01",
			tool_input: { file_path: "/Users/ada/.zshrc", content: "alias x=y\n" },
		},
		{
			tool_name: "Bash",
			tool_use_id: "toolu_02",
			tool_input: {
				command: "curl -s https://example.org/feed.xml",
				description: "Fetch the feed",
			},
		},
		{
			tool_name: "WebSearch",
			tool_use_id: "toolu_03",
			tool_input: {
				query: "agent memory benchmark",
				allowed_domains: ["example.org"],
			},
		},
		{
			tool_name: "WebFetch",
			tool_use_id: "toolu_04",
			tool_input: {
				url: "https://example.org/news/2",
				prompt: "Give the title and date",
			},
		},
	]);
	const section = logSection(
		STARTED,
		ENDED,
		{ result: result, problem: null },
		null,
	);

	assert.deepEqual(linesAfterRefusedHeading(section), [
		"",
		"- Write: /Users/ada/.zshrc",
		"- Bash: curl -s https://example.org/feed.xml",
		'- WebSearch: {"query":"agent memory benchmark","allowed_domains":["example.org"]}',
		"- WebFetch: https://example.org/news/2",
	]);
});

// The contract: "After the '### Final message' part, the section ends with" the refused part. So the final message's
// heading and text come first, and the refused heading after them.
test("The run's log puts the refused tool calls after the final message", async () => {
	const { logSection }: typeof Scout = await import(SCRIPT.href);
	const result = finalResult([
		{
			tool_name: "Bash",
			tool_use_id: "toolu_01",
			tool_input: { command: "rm -rf .fulltext", description: "Clean" },
		},
	]);
	const section = logSection(
		STARTED,
		ENDED,
		{ result: result, problem: null },
		null,
	);

	const finalHeadingAt = section.indexOf(FINAL_HEADING);
	const firstLineAt = section.indexOf(FINAL_FIRST_LINE);
	const lastLineAt = section.indexOf(FINAL_LAST_LINE);
	const refusedHeadingAt = section.indexOf(REFUSED_HEADING);
	assert.notEqual(
		finalHeadingAt,
		-1,
		`the section has "${FINAL_HEADING}"; it was:\n${section}`,
	);
	assert.notEqual(
		firstLineAt,
		-1,
		`the section holds the final message's first line; it was:\n${section}`,
	);
	assert.notEqual(
		lastLineAt,
		-1,
		`the section holds the final message's last line; it was:\n${section}`,
	);
	assert.equal(
		finalHeadingAt < firstLineAt,
		true,
		`the final message comes after its heading:\n${section}`,
	);
	assert.equal(
		firstLineAt < lastLineAt,
		true,
		`the final message's lines keep their order:\n${section}`,
	);
	assert.equal(
		lastLineAt < refusedHeadingAt,
		true,
		`the refused part comes after the final message:\n${section}`,
	);
	assert.deepEqual(linesAfterRefusedHeading(section), [
		"",
		"- Bash: rm -rf .fulltext",
	]);
});

// The log holds the run's final message and its cost, and no line to reopen the session: nobody reopens a session that
// ran on a GitHub runner. The contract leaves the cost's format open, so only the number is looked for.
test("The run's log holds the final message and the cost, and no line to reopen the session", async () => {
	const { logSection }: typeof Scout = await import(SCRIPT.href);
	const result = finalResult([]);
	const section = logSection(
		STARTED,
		ENDED,
		{ result: result, problem: null },
		null,
	);

	const reopen = section
		.split("\n")
		.filter((text) => text.startsWith("Reopen"));
	assert.deepEqual(
		reopen,
		[],
		`the section has no Reopen line; it was:\n${section}`,
	);
	const firstLineHeld = section.includes(FINAL_FIRST_LINE);
	assert.equal(
		firstLineHeld,
		true,
		`the section holds the final message's first line; it was:\n${section}`,
	);
	const lastLineHeld = section.includes(FINAL_LAST_LINE);
	assert.equal(
		lastLineHeld,
		true,
		`the section holds the final message's last line; it was:\n${section}`,
	);
	assert.equal(
		section.includes("1.25"),
		true,
		`the section holds the cost, 1.25; it was:\n${section}`,
	);
});

// Which field names a refused call, when an input has more than one: the command, if it is a string, before the file
// path; the file path, if it is a string, before the URL. No real tool sends these inputs; they pin down the order.
test("The run's log shows a refused call by its command, else its file path, else its URL", async () => {
	const { logSection }: typeof Scout = await import(SCRIPT.href);
	const result = finalResult([
		{
			tool_name: "Probe",
			tool_use_id: "toolu_01",
			tool_input: { command: "ls -la", file_path: "/etc/hosts" },
		},
		{
			tool_name: "Probe",
			tool_use_id: "toolu_02",
			tool_input: { command: ["ls", "-la"], file_path: "/etc/hosts" },
		},
		{
			tool_name: "Probe",
			tool_use_id: "toolu_03",
			tool_input: { file_path: "/etc/hosts", url: "https://a.test/" },
		},
		{
			tool_name: "Probe",
			tool_use_id: "toolu_04",
			tool_input: { file_path: 7, url: "https://example.org/b" },
		},
	]);
	const section = logSection(
		STARTED,
		ENDED,
		{ result: result, problem: null },
		null,
	);

	assert.deepEqual(linesAfterRefusedHeading(section), [
		"",
		"- Probe: ls -la",
		"- Probe: /etc/hosts",
		"- Probe: /etc/hosts",
		"- Probe: https://example.org/b",
	]);
});

// A command over several lines, or with runs of spaces and tabs, stays on its one list line: each whitespace run
// becomes one space.
test("The run's log turns each stretch of spaces, tabs and line breaks in a refused call into one space", async () => {
	const { logSection }: typeof Scout = await import(SCRIPT.href);
	const result = finalResult([
		{
			tool_name: "Bash",
			tool_use_id: "toolu_01",
			tool_input: {
				command:
					'for id in 2510.01234 2510.05678; do\n  node scripts/scout/arxiv/arxiv.ts "$id"\ndone',
			},
		},
		{
			tool_name: "Bash",
			tool_use_id: "toolu_02",
			tool_input: { command: 'grep  -c\t"date"   site/digests.js' },
		},
	]);
	const section = logSection(
		STARTED,
		ENDED,
		{ result: result, problem: null },
		null,
	);

	assert.deepEqual(linesAfterRefusedHeading(section), [
		"",
		'- Bash: for id in 2510.01234 2510.05678; do node scripts/scout/arxiv/arxiv.ts "$id" done',
		'- Bash: grep -c "date" site/digests.js',
	]);
});

// A refused call longer than 200 characters is cut at 200, followed by "…"; one of exactly 200 is kept whole. The
// long command is "echo " (5 characters) and 25 words of 9 with a space between them, so its first 200 characters end
// in "word-", the start of word-0020.
test('The run\'s log cuts a refused call longer than 200 characters to 200 and adds "…"', async () => {
	const { logSection }: typeof Scout = await import(SCRIPT.href);
	const longCommand =
		"echo word-0001 word-0002 word-0003 word-0004 word-0005 word-0006 word-0007 word-0008 word-0009 word-0010 " +
		"word-0011 word-0012 word-0013 word-0014 word-0015 word-0016 word-0017 word-0018 word-0019 word-0020 " +
		"word-0021 word-0022 word-0023 word-0024 word-0025";
	const command200 =
		"echo word-0001 word-0002 word-0003 word-0004 word-0005 word-0006 word-0007 word-0008 word-0009 word-0010 " +
		"word-0011 word-0012 word-0013 word-0014 word-0015 word-0016 word-0017 word-0018 word-0019 12345";
	const result = finalResult([
		{
			tool_name: "Bash",
			tool_use_id: "toolu_01",
			tool_input: { command: longCommand },
		},
		{
			tool_name: "Bash",
			tool_use_id: "toolu_02",
			tool_input: { command: command200 },
		},
	]);
	const section = logSection(
		STARTED,
		ENDED,
		{ result: result, problem: null },
		null,
	);

	assert.deepEqual(linesAfterRefusedHeading(section), [
		"",
		"- Bash: echo word-0001 word-0002 word-0003 word-0004 word-0005 word-0006 word-0007 word-0008 word-0009 " +
			"word-0010 word-0011 word-0012 word-0013 word-0014 word-0015 word-0016 word-0017 word-0018 word-0019 word-…",
		"- Bash: echo word-0001 word-0002 word-0003 word-0004 word-0005 word-0006 word-0007 word-0008 word-0009 " +
			"word-0010 word-0011 word-0012 word-0013 word-0014 word-0015 word-0016 word-0017 word-0018 word-0019 12345",
	]);
});

// The contract collapses whitespace, then cuts. This command is 207 characters as sent, 150 of them one run of spaces,
// and 58 once collapsed, so it is kept whole. Cutting first would end it in "251…".
test("The run's log collapses the spaces in a refused call before cutting it to 200 characters", async () => {
	const { logSection }: typeof Scout = await import(SCRIPT.href);
	const spacedCommand =
		"node scripts/scout/arxiv/arxiv.ts" +
		" ".repeat(150) +
		"--append site/digests.js 2510.01234";
	const result = finalResult([
		{
			tool_name: "Bash",
			tool_use_id: "toolu_01",
			tool_input: { command: spacedCommand },
		},
	]);
	const section = logSection(
		STARTED,
		ENDED,
		{ result: result, problem: null },
		null,
	);

	assert.deepEqual(linesAfterRefusedHeading(section), [
		"",
		"- Bash: node scripts/scout/arxiv/arxiv.ts --append site/digests.js 2510.01234",
	]);
});

// A run the allow list refused nothing.
test('The run\'s log reads "(none)" under "Refused by the allow list" when permission_denials is empty', async () => {
	const { logSection }: typeof Scout = await import(SCRIPT.href);
	const result = finalResult([]);
	const section = logSection(
		STARTED,
		ENDED,
		{ result: result, problem: null },
		null,
	);

	assertRefusedNone(section);
});

// A result message with no permission_denials field at all.
test('The run\'s log reads "(none)" under "Refused by the allow list" when the result has no permission_denials field', async () => {
	const { logSection }: typeof Scout = await import(SCRIPT.href);
	const result = finalResult([]);
	// The SDK's type makes the field required, so tsc refuses `delete`; Reflect.deleteProperty removes it the same way.
	Reflect.deleteProperty(result, "permission_denials");
	const section = logSection(
		STARTED,
		ENDED,
		{ result: result, problem: null },
		null,
	);

	assertRefusedNone(section);
});

// A run that never gets a session or a result (offline, say): the section says what failed. The refused part is still
// there and reads "(none)".
test('The log of a run with no result says what failed, and reads "(none)" under "Refused by the allow list"', async () => {
	const { logSection }: typeof Scout = await import(SCRIPT.href);
	const failure = "Error: getaddrinfo ENOTFOUND api.anthropic.com";
	const section = logSection(
		STARTED,
		ENDED,
		{ result: null, problem: null },
		failure,
	);

	assert.equal(
		section.includes(failure),
		true,
		`the section says what failed; it was:\n${section}`,
	);
	assertRefusedNone(section);
});

// Every arXiv request answered HTTP 429 or 503 is kept for the run's log: logRun
// lists the refusal record in one run's section, then removes it, so the next run's section lists none.
test("An arXiv request that was refused is listed in the next run's log only, and then cleared", async () => {
	const { logRun, logSection }: typeof Scout = await import(SCRIPT.href);
	const { recordRefusal }: typeof Arxiv = await import(
		new URL("../../scripts/scout/arxiv/api.ts", import.meta.url).href
	);
	const folder = mkdtempSync(join(tmpdir(), "liminal-unit-log-run-"));
	try {
		const refusals = join(folder, "liminal-arxiv-pacing", "refusals");
		const interests = join(folder, "interests.md");
		writeFileSync(
			interests,
			"## Topics\n1. Risks of AI (weight 1.00): x\n\nA paper on none of these topics has weight 0.75.\n",
		);
		const sources = {
			refusals: refusals,
			pool: {},
			interests: interests,
			digests: join(folder, "digests.js"),
		};
		recordRefusal(refusals, {
			time: "2026-11-01T22:09:00.000Z",
			service: "arXiv API",
			status: 429,
			path: "/api/query",
		});
		const ended = new Date("2026-11-01T22:30:00.000Z");
		const outcome = { result: null, problem: null };
		for (let run = 0; run < 2; run += 1) {
			logRun(
				folder,
				"2026-11-02",
				logSection(ended, ended, outcome, null),
				sources,
			);
		}

		const log = readFileSync(
			join(folder, ".scout-logs", "2026-11-02.md"),
			"utf8",
		);
		const parts = log.split("### arXiv refusals\n\n").slice(1);
		assert.equal(parts.length, 2, `two runs' sections:\n${log}`);
		assert.match(
			parts[0] as string,
			/^arXiv refused 1 request:\n- 2026-11-02 05:09:00, arXiv API, HTTP 429, \/api\/query\n/,
		);
		assert.match(parts[1] as string, /^arXiv refused no request\.\n/);
		assert.equal(existsSync(refusals), false, "the refusal record is gone");
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
});

// =====================================================================================================
// stderrFailure: what stderr may say about a failed session
// =====================================================================================================
// What a failed session said stays out of the job log: stderr is the GitHub job
// log, public once the repository is, so a session's own words (its final message, the SDK's error texts) stay in
// .scout-logs/<today>.md, and stderr names only the kind of failure and that file. The failure texts given here are the
// ones runInProcess builds (whatFailed, the stop handler), so the tests pin what each becomes.

const TODAY = "2026-11-05";
const SECRET_LINE = "SECRET-LINE: a sentence quoted from a page the scout read";

// A "success" result with is_error set, as the SDK ends a session whose last turn hit an API error: its result text is
// the error's. Only the fields the scout reads are built, so the type is asserted.
function errorResult(text: string): SDKResultSuccess {
	return {
		type: "result",
		subtype: "success",
		is_error: true,
		result: text,
		total_cost_usd: 0.01,
		num_turns: 1,
		session_id: SESSION_ID,
		permission_denials: [] as SDKPermissionDenial[],
	} as SDKResultSuccess;
}

// A result of a non-success subtype, as the SDK ends a session it stopped early, with its errors.
function stoppedResult(
	subtype: SDKResultError["subtype"],
	errors: string[],
): SDKResultError {
	return {
		type: "result",
		subtype: subtype,
		is_error: true,
		errors: errors,
		total_cost_usd: 0.01,
		num_turns: 1,
		session_id: SESSION_ID,
		permission_denials: [] as SDKPermissionDenial[],
	} as SDKResultError;
}

test("privacy: A session that ended on an error is reported on stderr without the error's text", async () => {
	const { stderrFailure }: typeof Scout = await import(SCRIPT.href);
	const text = `API Error: 400 ${SECRET_LINE}`;
	const outcome = { result: errorResult(text), problem: null };
	const failure = `the session ended on an error: ${text}`;

	const shown = stderrFailure(outcome, failure, TODAY);

	assert.equal(
		shown,
		"the session ended on an error (details in .scout-logs/2026-11-05.md)",
	);
	assert.equal(shown.includes("SECRET-LINE"), false, `stderr's text: ${shown}`);
});

test("privacy: A session the SDK stopped early is reported on stderr by its subtype, without the SDK's error texts", async () => {
	const { stderrFailure }: typeof Scout = await import(SCRIPT.href);
	const outcome = {
		result: stoppedResult("error_max_turns", [SECRET_LINE]),
		problem: null,
	};
	const failure = `the session stopped early (error_max_turns): ${SECRET_LINE}`;

	const shown = stderrFailure(outcome, failure, TODAY);

	assert.equal(
		shown,
		"the session stopped early (error_max_turns) (details in .scout-logs/2026-11-05.md)",
	);
	assert.equal(shown.includes("SECRET-LINE"), false, `stderr's text: ${shown}`);
});

// A session that stopped early and whose SDK then threw: both are in the log's failure; stderr still quotes neither.
test("privacy: A session that stopped early and then threw is reported on stderr without either error text", async () => {
	const { stderrFailure }: typeof Scout = await import(SCRIPT.href);
	const outcome = {
		result: stoppedResult("error_during_execution", [SECRET_LINE]),
		problem: `Claude Code process exited with code 1: ${SECRET_LINE}`,
	};
	const failure = `the session stopped early (error_during_execution): ${SECRET_LINE}; ${outcome.problem}`;

	const shown = stderrFailure(outcome, failure, TODAY);

	assert.equal(shown.includes("SECRET-LINE"), false, `stderr's text: ${shown}`);
	assert.equal(
		shown.includes("the session stopped early (error_during_execution)"),
		true,
		`stderr's text: ${shown}`,
	);
	assert.equal(
		shown.includes(".scout-logs/2026-11-05.md"),
		true,
		`stderr's text: ${shown}`,
	);
});

// The SDK threw before any session ran (no login, offline): there are no session words to hide, and the failure is the
// SDK's own message, which stderr prints as it is.
test("A run the SDK couldn't start has its failure printed as it is", async () => {
	const { stderrFailure }: typeof Scout = await import(SCRIPT.href);
	const failure = "no Claude login found";
	const outcome = { result: null, problem: failure };

	assert.equal(stderrFailure(outcome, failure, TODAY), failure);
});

// A stopped run: the SDK throws its abort error, the result is null, and the stop handler names the signal.
test("A stopped run has its failure printed as it is", async () => {
	const { stderrFailure }: typeof Scout = await import(SCRIPT.href);
	const failure = "the run was stopped (SIGTERM)";
	const outcome = {
		result: null,
		problem: "Claude Code process aborted by user",
	};

	assert.equal(stderrFailure(outcome, failure, TODAY), failure);
});

// A run whose session ended with no result and no thrown error (whatFailed's first case) has nothing to hide either.
test("A session that ended without a final result has its failure printed as it is", async () => {
	const { stderrFailure }: typeof Scout = await import(SCRIPT.href);
	const failure = "the session ended without a final result";

	assert.equal(
		stderrFailure({ result: null, problem: null }, failure, TODAY),
		failure,
	);
});

// A session that cost nothing never reached the model: no tool ran and no page was read, so its error is Claude Code's
// own (measured 2026-11-09 with an empty HOME: "Not logged in · Please run /login", $0.00, 1 turn) and stderr prints it.
test("A session that never reached the model has its error printed as it is", async () => {
	const { stderrFailure }: typeof Scout = await import(SCRIPT.href);
	const text = "Not logged in · Please run /login";
	const result = { ...errorResult(text), total_cost_usd: 0 };
	const failure = `the session ended on an error: ${text}`;

	assert.equal(
		stderrFailure({ result: result, problem: null }, failure, TODAY),
		failure,
	);
});

// The scout's session is set up from the repo alone: the scout's own instructions.
test("The options append scripts/scout/scout.md to Claude Code's own system prompt", async () => {
	const { scoutOptions }: typeof Scout = await import(SCRIPT.href);
	const options = scoutOptions({
		repo: REPO,
		home: HOME,
		scratch: SCRATCH,
		env: ENV,
	});

	assert.deepEqual(options.systemPrompt, {
		type: "preset",
		preset: "claude_code",
		append: readFileSync(join(REPO, "scripts", "scout", "scout.md"), "utf8"),
	});
});

// The scout leaves out every instruction file and reads only scripts/scout/scout.md.
// One pattern matching every path, so no instruction file is named and none can be missed.
test("The options leave out every instruction file: CLAUDE.md, AGENTS.md and any other", async () => {
	const { scoutOptions }: typeof Scout = await import(SCRIPT.href);
	const options = scoutOptions({
		repo: REPO,
		home: HOME,
		scratch: SCRATCH,
		env: ENV,
	});

	assert.deepEqual(settingsOf(options).claudeMdExcludes, ["**"]);
});

// The allow-list checks. The instructions are read
// from the repo's own scripts/scout/scout.md, whole.
test("Every command scripts/scout/scout.md names is on the allow list", () => {
	const instructions = readFileSync(SCOUT_MD, "utf8");
	const commands = commandLinesIn(instructions.split("\n")).map((command) =>
		filledIn(command, "site/digests.js", SCRATCH),
	);
	assert.ok(
		commands.length > 12,
		`scripts/scout/scout.md names more than a dozen commands; found:\n${commands.join("\n")}`,
	);

	const rules = bashAllowRules();
	const unmatched = commands.filter(
		(command) => !rules.some((rule) => ruleMatches(rule, command)),
	);
	assert.deepEqual(unmatched, [], "commands no Bash rule allows");
});

// An allow rule matches the command's text, so a date command that reads a file is refused (2026-11-03).
for (const command of [
	"TZ=Asia/Jakarta date -f /proc/self/environ",
	"TZ=Asia/Jakarta date +%F -f /proc/self/environ",
]) {
	test(`security: The date command with anything but "+%F" is refused by the allow list: ${command}`, () => {
		const allowedBy = bashAllowRules().filter((rule) =>
			ruleMatches(rule, command),
		);

		assert.deepEqual(allowedBy, []);
	});
}

test("The date command reading today's date in Jakarta is allowed", () => {
	const command = "TZ=Asia/Jakarta date +%F";

	assert.ok(
		bashAllowRules().some((rule) => ruleMatches(rule, command)),
		`a Bash rule allows ${command}`,
	);
});

// A dry run of the script, with a token, its scratch folder and cache in a temp folder, and no SDK to load.
async function dryRun(token: string) {
	const folder = tempFolder("liminal-unit-scout-dry-run-");
	const ran = await runScript(scriptPath("scout/scout.ts"), ["--dry-run"], {
		CLAUDE_CODE_OAUTH_TOKEN: token,
		TMPDIR: folder,
		LIMINAL_CACHE: folder,
		SCOUT_SDK: join(folder, "no-sdk.js"),
	});
	return { ...ran, folder: folder };
}
afterAll(removeTempFolders);

test("security: a dry run with the subscription token set is printed with [token removed] in its place", async () => {
	const token = "sk-ant-oat01-unit-test-token-3c9e";
	const ran = await dryRun(token);

	assert.equal(ran.code, 0, ran.stderr);
	assert.ok(!ran.stdout.includes(token), "the token is in the output");
	assert.ok(!ran.stderr.includes(token), "the token is on stderr");
	const printed = JSON.parse(ran.stdout);
	assert.equal(printed.options.env.CLAUDE_CODE_OAUTH_TOKEN, "[token removed]");
});

test("security: a dry run whose output holds the subscription token twice is printed with every copy removed", async () => {
	const token = "sk-ant-oat01-unit-test-token-7d21";
	const folder = tempFolder("liminal-unit-scout-dry-run-");
	// LANG is passed on to the session, so its value is printed a second time.
	const ran = await runScript(scriptPath("scout/scout.ts"), ["--dry-run"], {
		CLAUDE_CODE_OAUTH_TOKEN: token,
		LANG: token,
		TMPDIR: folder,
		LIMINAL_CACHE: folder,
		SCOUT_SDK: join(folder, "no-sdk.js"),
	});

	assert.equal(ran.code, 0, ran.stderr);
	assert.ok(
		!ran.stdout.includes(token),
		"a copy of the token is in the output",
	);
	const printed = JSON.parse(ran.stdout);
	assert.equal(printed.options.env.LANG, "[token removed]");
	assert.equal(printed.options.env.CLAUDE_CODE_OAUTH_TOKEN, "[token removed]");
});

test("security: a subscription token holding a line break is refused with 'CLAUDE_CODE_OAUTH_TOKEN must be one line' before a scratch folder is made", async () => {
	for (const token of [
		"sk-ant-oat01-first\nsecond",
		"sk-ant-oat01-first\rsecond",
	]) {
		const ran = await dryRun(token);

		assert.equal(ran.code, 1, JSON.stringify(token));
		assert.equal(
			ran.stderr,
			"scout.ts: CLAUDE_CODE_OAUTH_TOKEN must be one line\n",
		);
		assert.equal(ran.stdout, "");
		assert.deepEqual(
			readdirSync(ran.folder),
			[],
			"the run made a scratch folder",
		);
	}
});

test("the session's first message holds no disliked paper", async () => {
	const folder = tempFolder("liminal-unit-scout-dislikes-");
	const disliked = {
		id: "arxiv:2609.00001",
		title: "A note on sycophancy",
		abstract: "We note something about sycophancy.",
		date: "2026-10-03",
	};
	writeFileSync(
		join(folder, "feedback.json"),
		JSON.stringify({ liked: [], disliked: [disliked] }),
	);
	const ran = await runScript(scriptPath("scout/scout.ts"), ["--dry-run"], {
		CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-unit-test-token-5b18",
		TMPDIR: folder,
		LIMINAL_CACHE: folder,
		SCOUT_SDK: join(folder, "no-sdk.js"),
	});

	assert.equal(ran.code, 0, ran.stderr);
	const { prompt } = JSON.parse(ran.stdout);
	assert.ok(!prompt.includes(disliked.title), prompt);
	assert.ok(!prompt.includes(disliked.abstract), prompt);
});
