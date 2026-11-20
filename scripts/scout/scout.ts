// Run the Liminal scout through the Claude Agent SDK on the owner's subscription, with its own instructions (scripts/scout/scout.md,
// added to Claude Code's system prompt), the project's allow list and none of the owner's personal setup: no CLAUDE.md,
// auto memory, hooks, plugins, skills or MCP.
// Usage: node scripts/scout/scout.ts --dry-run | --foreground
// --foreground (GitHub Actions, scout.yml) runs the session in this process, prints the final message, and exits 0 only
// when the session ended well; scout.yml's concurrency group keeps to one run at a time.
// The session signs in with CLAUDE_CODE_OAUTH_TOKEN, passed to the session when set; ANTHROPIC_API_KEY never is. A
// token holding a line break stops the run before any session starts:
// "scout.ts: CLAUDE_CODE_OAUTH_TOKEN must be one line". The token's value never reaches the log or the output: any
// place it would appear reads "[token removed]".
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
	HookCallback,
	HookJSONOutput,
	Options,
	SDKPermissionDenial,
	SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { errorCode } from "../../shared/narrow.ts";
import { readDigestsText } from "../digests/digests-file.ts";
import { REPO } from "../lib/cli.ts";
import CONSTANTS from "../lib/constants.json" with { type: "json" };
import { feedbackPath } from "../lib/feedback.ts";
import type { Refusal } from "./arxiv/api.ts";
import { readRefusals, refusalRecord } from "./arxiv/api.ts";
import { samplesPart, todaysPicks } from "./plan/jev-samples.ts";
import type { Pool } from "./plan/pool.ts";
import { readPool } from "./plan/pool.ts";

const USAGE = "usage: node scripts/scout/scout.ts --dry-run | --foreground";
const JAKARTA_DATE = new Intl.DateTimeFormat("en-CA", {
	timeZone: CONSTANTS.timeZone,
});
// h23, not h24: midnight reads 00:00:00.
const JAKARTA_TIME = new Intl.DateTimeFormat("en-GB", {
	timeZone: CONSTANTS.timeZone,
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	hourCycle: "h23",
});
// The only environment variables the scout's session gets; Claude Code keeps its own files under HOME.
// API keys and Claude Code's own variables (plugin folders, parent-session markers) stay out.
const PASSED_ENV = ["HOME", "PATH", "USER", "TMPDIR", "LANG"];
// The owner's subscription token, made with "claude setup-token": the scout's login. Passed to the session when set. ANTHROPIC_API_KEY never is: any model call runs on the subscription.
const TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
// What the token's value reads as wherever this script prints or logs it.
const TOKEN_REMOVED = "[token removed]";
// The module the session comes from. SCOUT_SDK names a stand-in for scenarios: it exports query({ prompt, options }),
// an async iterable of SDK messages, and ends its session when options.abortController is aborted.
const SDK_MODULE = process.env.SCOUT_SDK || "@anthropic-ai/claude-agent-sdk";
// How long a stopped run waits for its session to end before it cleans up and ends anyway (the limit is 5 s).
// The SDK sends the claude CLI SIGTERM 2 s after the abort; this leaves that a chance to work first.
const STOP_GRACE_MS = 4000;
// What the first message names.
type PromptRun = { today: string; scratch: string };

// What one run's SDK options are made from: the repo, the home folder, the scratch folder and the environment.
type OptionsRun = {
	repo: string;
	home: string;
	scratch: string;
	env: Record<string, string | undefined>;
};

// How a run ended, for a foreground run to print: the session's final message, and what failed (null when nothing did).
type RunEnd = { finalMessage: string | null; failure: string | null };

// How a session ended: the final result message, and what the SDK threw.
export type Outcome = {
	result: SDKResultMessage | null;
	problem: string | null;
};

// The scout's instructions: the text of scripts/scout/scout.md in the repo, which scoutOptions appends to Claude Code's
// own system prompt.
export function scoutInstructions(repo: string): string {
	return readFileSync(join(repo, "scripts", "scout", "scout.md"), "utf8");
}

// The scout's first message.
export function scoutPrompt(run: PromptRun): string {
	return (
		`You are the Liminal scout. Today is ${run.today}. ` +
		`Your scratchpad directory is ${run.scratch}: write temporary files, such as items.json, there.`
	);
}

// A command that starts by setting a variable, as a shell reads it: NAME=, NAME+= or NAME[index]=, after any blanks.
const LEADING_ASSIGNMENT = /^\s*[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;
// The one command with a leading assignment, allowed only as written.
const DATE_COMMAND = `TZ=${CONSTANTS.timeZone} date +%F`;

// Why a Bash command may not run: shell syntax outside single quotes. A redirect's target is only checked against
// the Edit rules and the working folder, so "node scripts/x.ts > scripts/deploy/sync.ts" passes a rule for
// "node scripts/x.ts *". The scout's commands need none of this syntax, so it is refused before the allow list sees
// the command. Returns null when the command may go on, or what was found: a redirect, a pipe, "&&", ";", "&",
// "$(", a bare "$", a backquote, a backslash, "{", "}", "(", ")", a newline, an unbalanced quote, or a variable
// assignment at the start (any but "TZ=Asia/Jakarta date +%F"). Text inside single quotes is inert; inside double
// quotes only "$", a backquote and "\" count. Outside quotes "\'" is a literal quote, so an apostrophe in a
// single-quoted summary can be written '\''; any other backslash is refused.
export function shellSyntaxProblem(command: string): string | null {
	let quote: "none" | "single" | "double" = "none";
	for (let i = 0; i < command.length; i++) {
		const char = command[i];
		// A line break splits a command into two, quoted or not.
		if (char === "\n" || char === "\r") {
			return "a newline";
		}
		// Inside single quotes everything is inert until the closing quote.
		if (quote === "single") {
			if (char === "'") {
				quote = "none";
			}
			continue;
		}
		// Inside double quotes the shell still expands "$", a backquote and "\".
		if (quote === "double") {
			if (char === '"') {
				quote = "none";
			} else if (char === "$") {
				return '"$" in quotes';
			} else if (char === "`") {
				return "a backquote in quotes";
			} else if (char === "\\") {
				return 'a "\\" in quotes';
			}
			continue;
		}
		// Outside quotes: open a quote, or name the first piece of shell syntax.
		if (char === "'") {
			quote = "single";
		} else if (char === '"') {
			quote = "double";
		} else if (char === ">" || char === "<") {
			return "a redirect";
		} else if (char === "|") {
			return "a pipe";
		} else if (char === "&") {
			return command[i + 1] === "&" ? '"&&"' : '"&"';
		} else if (char === ";") {
			return '";"';
		} else if (char === "$") {
			return command[i + 1] === "(" ? '"$("' : '"$"';
		} else if (char === "`") {
			return "a backquote";
		} else if (char === "\\" && command[i + 1] === "'") {
			i += 1;
		} else if (char === "\\") {
			return "a backslash";
		} else if (char === "{" || char === "}" || char === "(" || char === ")") {
			return `"${char}"`;
		}
	}
	// A quote still open at the end would swallow the next line.
	if (quote !== "none") {
		return "an unbalanced quote";
	}
	// A leading NAME=value sets a variable for the script that follows: NODE_OPTIONS=--require=<file> would load a
	// file the session wrote, LIMINAL_ALLOW_LOCAL opens the fetch guard. Only the date command goes on, as written.
	if (LEADING_ASSIGNMENT.test(command) && command !== DATE_COMMAND) {
		return "a variable assignment";
	}
	return null;
}

// The PreToolUse hook that runs shellSyntaxProblem on every Bash call: a problem denies the call, with the problem as
// the reason the session sees; any other tool, or a Bash call without command text, is left to the allow list. The
// SDK runs a callback hook as it is (no fail-closed option in 0.3.316), so a failure of the check itself denies too.
export const refuseShellSyntax: HookCallback = async (input) => {
	try {
		if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "Bash") {
			return {};
		}
		const toolInput: unknown = input.tool_input;
		let command: string | null = null;
		if (
			typeof toolInput === "object" &&
			toolInput !== null &&
			"command" in toolInput &&
			typeof toolInput.command === "string"
		) {
			command = toolInput.command;
		}
		let problem = "the Bash call has no command text";
		if (command !== null) {
			const found = shellSyntaxProblem(command);
			if (found === null) {
				return {};
			}
			problem = found;
		}
		return denyBash(problem);
	} catch (error) {
		return denyBash(
			`the shell-syntax check failed: ${errorCode(error) || "error"}`,
		);
	}
};

// A PreToolUse answer that denies the call, with its reason.
function denyBash(reason: string): HookJSONOutput {
	return {
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason: reason,
		},
	};
}

// The SDK options for one scout run, from { repo, home, scratch, env }.
export function scoutOptions(run: OptionsRun): Options {
	// Copy only the listed variables; a missing LANG would leave tools without UTF-8.
	const env: Record<string, string> = {};
	for (const name of PASSED_ENV) {
		if (run.env[name] !== undefined) {
			env[name] = run.env[name];
		}
	}
	env.LANG = run.env.LANG || "en_US.UTF-8";
	// The subscription token, when this process has one.
	const token = run.env[TOKEN_ENV];
	if (token) {
		env[TOKEN_ENV] = token;
	}
	// No background commands: the session ends with the model's turn, so nobody would read their output.
	env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
	// search.ts takes about 5 minutes and waits up to 15 more when arXiv refuses; Claude Code stops a command after
	// 10 minutes unless this allows more.
	env.BASH_MAX_TIMEOUT_MS = "1800000";
	// Claude Code removes credentials, the subscription token among them, from the environment of every command it
	// starts. It turns this on by itself only when it sees GITHUB_ACTIONS, which PASSED_ENV keeps out.
	env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = "1";

	return {
		cwd: run.repo,
		// Only the repo's .claude/settings.json: its allow list. User and local settings stay out.
		settingSources: ["project"],
		// The scout's own instructions, scripts/scout/scout.md, are added to Claude Code's system prompt.
		systemPrompt: {
			type: "preset",
			preset: "claude_code",
			append: scoutInstructions(run.repo),
		},
		settings: {
			// No instruction file at all: not the user's CLAUDE.md, which the project source still loads, nor the repo's
			// CLAUDE.md or AGENTS.md, which Claude Code reads when CLAUDE.md is left out. The scout reads only scout.md.
			claudeMdExcludes: ["**"],
			disableClaudeAiConnectors: true,
			autoMemoryEnabled: false,
			disableAllHooks: true,
			disableBundledSkills: true,
			permissions: {
				// In a permission rule "//" starts an absolute path; a single "/" would be relative to the repo.
				allow: [`Edit(/${run.scratch}/**)`, `Read(/${run.scratch}/**)`],
				// Without cd, every command runs in the repo, never a script the session wrote in the scratch folder.
				// No Edit deny: Claude Code's sandbox makes each Edit deny unwritable for the commands too. The Write and
				// Edit tools reach only the scratch folder through the allow list, shellSyntaxProblem refuses a redirect,
				// and the sandbox keeps the commands out of scripts/, .github/, .claude/, package.json and .git's hooks.
				// The Read denies keep the owner's marks (read marks, likes, dislikes) from a session that can fetch any
				// address; the scripts read them as child processes. /proc holds the session's own environment.
				deny: [
					"Bash(cd *)",
					`Read(/${join(run.repo, "site", "digests.read.json")})`,
					`Read(/${resolve(feedbackPath())})`,
					"Read(//proc/**)",
				],
			},
		},
		// Shell syntax is refused before the allow list reads the command; disableAllHooks leaves this hook running.
		hooks: { PreToolUse: [{ matcher: "Bash", hooks: [refuseShellSyntax] }] },
		additionalDirectories: [run.scratch],
		strictMcpConfig: true,
		mcpServers: {},
		plugins: [],
		// Nobody is there to answer a permission question: refuse whatever the allow list doesn't allow.
		permissionMode: "dontAsk",
		model: "opus",
		effort: "medium",
		env: env,
	};
}

// "dry-run" for "--dry-run", "foreground" for "--foreground". Anything else, no argument included, stops here with the
// usage line, before a scratch folder is made.
function parseArgs(args: string[]) {
	if (args.length === 1 && args[0] === "--dry-run") {
		return "dry-run";
	}
	if (args.length === 1 && args[0] === "--foreground") {
		return "foreground";
	}
	console.error(USAGE);
	process.exit(1);
}

// The text with every copy of the subscription token's value replaced by "[token removed]". Everything this script
// prints or logs goes through it: a final message or an SDK error could quote the token.
function withoutToken(text: string) {
	const token = process.env[TOKEN_ENV];
	if (!token) {
		return text;
	}
	return text.replaceAll(token, TOKEN_REMOVED);
}

// Stop before any session when the subscription token holds a line break; this says which variable to fix.
function refuseWrappedToken() {
	const token = process.env[TOKEN_ENV];
	if (token && (token.includes("\n") || token.includes("\r"))) {
		console.error(`scout.ts: ${TOKEN_ENV} must be one line`);
		process.exit(1);
	}
}

// "2026-10-06 08:30:12", in Jakarta time like the digest dates.
function jakartaTime(date: Date) {
	return `${JAKARTA_DATE.format(date)} ${JAKARTA_TIME.format(date)}`;
}

// Run the scout's session to its end. Returns { result, problem }: the final result message, and what went wrong when
// the SDK threw (network, login, a crashed process).
async function runSession(prompt: string, options: Options) {
	const outcome: Outcome = { result: null, problem: null };
	try {
		// Loaded only for a real run, so --dry-run works without the SDK installed.
		const sdk: {
			query: typeof import("@anthropic-ai/claude-agent-sdk").query;
		} = await import(SDK_MODULE);
		// `for await` reads the messages as the session streams them.
		for await (const message of sdk.query({
			prompt: prompt,
			options: options,
		})) {
			if (message.type === "result") {
				outcome.result = message;
			}
		}
	} catch (error) {
		// A thrown value that isn't an Error leaves problem empty, as its missing message did before.
		if (error instanceof Error) {
			outcome.problem = error.message;
		}
	}
	return outcome;
}

// What went wrong in a finished session, or null when it succeeded.
// A "success" result with is_error set ended on an API error (offline, login): its result text names it.
// The SDK can also throw after an error result; both are named, the result first.
function whatFailed(outcome: Outcome) {
	const problems: string[] = [];
	const result = outcome.result;
	if (result === null && !outcome.problem) {
		problems.push("the session ended without a final result");
	}
	if (result !== null && result.subtype !== "success") {
		let message = `the session stopped early (${result.subtype})`;
		if (result.errors && result.errors.length > 0) {
			message += `: ${result.errors.join("; ")}`;
		}
		problems.push(message);
	}
	if (result !== null && result.subtype === "success" && result.is_error) {
		problems.push(`the session ended on an error: ${result.result}`);
	}
	if (outcome.problem) {
		problems.push(outcome.problem);
	}
	if (problems.length === 0) {
		return null;
	}
	return problems.join("; ");
}

// One refused tool call as a list line: the tool, then what it reached for (a command, a file, a URL, or its input).
function refusedLine(denial: SDKPermissionDenial) {
	const input = denial.tool_input || {};
	let what = JSON.stringify(input);
	if (typeof input.command === "string") {
		what = input.command;
	} else if (typeof input.file_path === "string") {
		what = input.file_path;
	} else if (typeof input.url === "string") {
		what = input.url;
	}
	// One line per refusal, however many lines the command had.
	what = what.replace(/\s+/g, " ");
	// Array.from splits by code point, so a cut never lands between the two halves of one code point (a surrogate pair);
	// a flag or family emoji, made of several code points, can still be split.
	const characters = Array.from(what);
	if (characters.length > 200) {
		what = `${characters.slice(0, 200).join("")}…`;
	}
	return `- ${denial.tool_name}: ${what}`;
}

// The session's final message without trailing white space, or null when it gave none.
function finalMessage(outcome: Outcome) {
	const result = outcome.result;
	if (result && "result" in result && result.result) {
		return result.result.trimEnd();
	}
	return null;
}

// One run's section of .scout-logs/<date>.md: times, outcome, cost, turns, the final message, and the tool calls the allow list refused (nobody sees those while the scout runs).
export function logSection(
	started: Date,
	ended: Date,
	outcome: Outcome,
	failure: string | null,
): string {
	const result = outcome.result;
	const lines = [`## Run started ${JAKARTA_TIME.format(started)}`, ""];
	lines.push(`- Started: ${jakartaTime(started)} (Asia/Jakarta)`);
	lines.push(`- Ended: ${jakartaTime(ended)} (Asia/Jakarta)`);
	if (failure) {
		lines.push(`- Outcome: failed, ${failure}`);
	} else {
		lines.push("- Outcome: success");
	}
	if (result) {
		lines.push(`- Cost: $${result.total_cost_usd.toFixed(2)}`);
		lines.push(`- Turns: ${result.num_turns}`);
	} else {
		lines.push("- Cost and turns: unknown, the session gave no result");
	}
	lines.push("", "### Final message", "");
	lines.push(finalMessage(outcome) || "(none)");
	lines.push("", "### Refused by the allow list", "");
	let denials: SDKPermissionDenial[] = [];
	if (result && result.permission_denials) {
		denials = result.permission_denials;
	}
	if (denials.length === 0) {
		lines.push("(none)");
	}
	for (const denial of denials) {
		lines.push(refusedLine(denial));
	}
	return `${lines.join("\n")}\n`;
}

// What the end of a run adds to its log section comes from: the arXiv refusal record (arxiv.ts's refusalRecord), the
// candidate pool as the run leaves it, and the files interests.md and site/digests.js.
export type RunSources = {
	refusals: string;
	pool: Pool;
	interests: string;
	digests: string;
};

// The run's "arXiv refusals" part: how many requests arXiv refused, then one line each with its time in Jakarta, the
// service, the status and the path, in the order they came.
function refusalsPart(refusals: Refusal[]) {
	const lines = ["### arXiv refusals", ""];
	if (refusals.length === 0) {
		lines.push("arXiv refused no request.");
	} else if (refusals.length === 1) {
		lines.push("arXiv refused 1 request:");
	} else {
		lines.push(`arXiv refused ${refusals.length} requests:`);
	}
	for (const refusal of refusals) {
		lines.push(
			`- ${jakartaTime(new Date(refusal.time))}, ${refusal.service}, HTTP ${refusal.status}, ${refusal.path}`,
		);
	}
	return `${lines.join("\n")}\n`;
}

// An error's message, which for an fs error names the file; the value itself for anything thrown that isn't an Error.
function reasonOf(error: unknown) {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

// The run's "Jev samples" part (lib/jev-samples.ts); a file that can't be read is named in its place.
function samplesOf(sources: RunSources, today: string) {
	try {
		const interests = readFileSync(sources.interests, "utf8");
		const picked = todaysPicks(readDigestsText(sources.digests), today);
		return samplesPart(sources.pool, interests, picked, today);
	} catch (error) {
		return `### Jev samples\n\nNo samples: ${reasonOf(error)}.\n`;
	}
}

// Add the run's section to the day's log, followed by what `sources` say about the run: samples of Jev's ranking, then
// the requests arXiv refused. Then remove the refusal record so the next run starts with none. A record that can't be
// read is named in the log in place of its refusals.
export function logRun(
	repo: string,
	today: string,
	section: string,
	sources: RunSources,
): void {
	let refusals: string;
	try {
		refusals = refusalsPart(readRefusals(sources.refusals));
	} catch (error) {
		// readRefusals throws fs errors and its own "is not a regular file"; their messages name the file.
		refusals = `### arXiv refusals\n\nThe refusal record can't be read: ${reasonOf(error)}.\n`;
	}
	writeLog(
		repo,
		today,
		`${section}\n${samplesOf(sources, today)}\n${refusals}`,
	);
	try {
		rmSync(sources.refusals, { force: true });
	} catch (error) {
		console.error(
			`scout.ts: can't remove the refusal record ${sources.refusals} (${errorCode(error)})`,
		);
	}
}

// Add the run's section to the day's log; a second run the same day adds a second section.
function writeLog(repo: string, today: string, section: string) {
	const folder = join(repo, ".scout-logs");
	const file = join(folder, `${today}.md`);
	try {
		mkdirSync(folder, { recursive: true });
		let separator = "";
		if (existsSync(file)) {
			separator = "\n";
		}
		appendFileSync(file, withoutToken(separator + section));
	} catch (error) {
		// exitCode, not exit(): the final message may still be on its way to stdout.
		console.error(
			`scout.ts: can't write the log ${file} (${errorCode(error)})`,
		);
		process.exitCode = 1;
	}
}

async function main(args: string[]) {
	const mode = parseArgs(args);
	refuseWrappedToken();

	const today = JAKARTA_DATE.format(new Date());

	// A fresh scratch folder per run, given by its real path: an allow rule matches a symlinked path unreliably.
	const scratch = realpathSync(mkdtempSync(join(tmpdir(), "liminal-scout-")));
	const prompt = scoutPrompt({ today: today, scratch: scratch });
	const options = scoutOptions({
		repo: REPO,
		home: homedir(),
		scratch: scratch,
		env: process.env,
	});

	if (mode === "dry-run") {
		// A hook is a function, which JSON leaves out: it is printed by its name, so the dry run shows it.
		console.log(
			withoutToken(
				JSON.stringify(
					{ prompt: prompt, options: options },
					(_key, value: unknown) => {
						if (typeof value === "function") {
							return value.name;
						}
						return value;
					},
					2,
				),
			),
		);
		return;
	}

	await runInProcess(REPO, today, scratch, prompt, options);
}

// What stderr may say about a failed session: the job log is public once the repository is, so the session's own
// words (its final message, the SDK's error texts) stay in .scout-logs/<today>.md, and stderr names only the kind of
// failure and that file. A run stopped by a signal or one the SDK couldn't start has no session words to hide, and
// its failure text is printed as it is. So has a session that cost nothing: it never reached the model, so no tool ran
// and no page was read, and its error is Claude Code's own (no login, a refused token).
export function stderrFailure(
	outcome: Outcome,
	failure: string,
	today: string,
): string {
	const result = outcome.result;
	if (result === null || result.total_cost_usd === 0) {
		return failure;
	}
	const where = `(details in .scout-logs/${today}.md)`;
	if (result.subtype !== "success") {
		return `the session stopped early (${result.subtype}) ${where}`;
	}
	if (result.is_error) {
		return `the session ended on an error ${where}`;
	}
	return failure;
}

// A run's ending, for whoever ran it (the workflow): the final message on stdout, what failed on stderr, both without
// the token and without the session's own words (stderrFailure).
function printRunEnd(end: RunEnd) {
	if (end.finalMessage !== null) {
		console.log(withoutToken(end.finalMessage));
	}
	if (end.failure !== null) {
		console.error(withoutToken(`scout.ts: the run failed: ${end.failure}`));
	}
}

// A real run, in this process: run the session to its end, log it, remove the scratch folder, and print how it ended.
// SIGTERM or SIGINT aborts the session and ends the process within 5 seconds, with the same clean-up; a stopped run
// still prints how it ended before its process ends.
async function runInProcess(
	repo: string,
	today: string,
	scratch: string,
	prompt: string,
	options: Options,
): Promise<void> {
	const started = new Date();

	// Log the run, then remove the scratch folder; once only, whichever way the run ends.
	let finished = false;
	function finish(outcome: Outcome, failure: string | null) {
		if (finished) {
			return;
		}
		finished = true;
		logRun(repo, today, logSection(started, new Date(), outcome, failure), {
			refusals: refusalRecord(),
			pool: readPool(),
			interests: join(repo, "interests.md"),
			digests: join(repo, "site", "digests.js"),
		});
		// Nothing in the scratch folder is needed once the run is logged, whether it succeeded or failed.
		rmSync(scratch, { recursive: true, force: true });
	}

	// A signal aborts the session through its AbortController. If the session hasn't ended by STOP_GRACE_MS,
	// the run logs, cleans up and ends its process anyway. unref(): the timer alone doesn't keep it alive.
	const controller = new AbortController();
	let stoppedBy: string | null = null;
	function stop(signal: NodeJS.Signals) {
		if (stoppedBy) {
			return;
		}
		stoppedBy = signal;
		controller.abort();
		const timer = setTimeout(() => {
			const failure = `the run was stopped (${signal}); the session didn't end in time`;
			finish({ result: null, problem: null }, failure);
			printRunEnd({ finalMessage: null, failure: failure });
			process.exit(1);
		}, STOP_GRACE_MS);
		timer.unref();
	}
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);

	const outcome = await runSession(prompt, {
		...options,
		abortController: controller,
	});
	let failure = whatFailed(outcome);
	if (stoppedBy) {
		failure = `the run was stopped (${stoppedBy})`;
	}
	finish(outcome, failure);
	// A stopped run's failure names the signal, not the session, so it is printed as it is.
	let shownFailure: string | null = null;
	if (stoppedBy) {
		shownFailure = failure;
	} else if (failure !== null) {
		shownFailure = stderrFailure(outcome, failure, today);
	}
	printRunEnd({ finalMessage: finalMessage(outcome), failure: shownFailure });
	// A stopped run ends now: what the aborted session left running would otherwise keep the process going.
	if (stoppedBy) {
		process.exit(1);
	}
	if (failure) {
		process.exitCode = 1;
	}
}

// Run only when called as a script, not when imported.
if (import.meta.main) {
	await main(process.argv.slice(2));
}
