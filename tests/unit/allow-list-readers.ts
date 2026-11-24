// Readers of the scout's instructions (scripts/scout/scout.md) and of .claude/settings.json's allow list, for scout.test.ts.
import fs from "node:fs";
import path from "node:path";
import { isJsonObject } from "../../shared/narrow.ts";

const ROOT = path.join(import.meta.dirname, "..", "..");

// The day the filled-in commands give for D.
const FILL_DATE = "2026-10-10";

// Code that runs one of the repo's scripts, and is not a whole family such as `node scripts/scout/arxiv/arxiv.ts ...`, where "..."
// stands for any arguments: no one filled-in command stands for such a family.
function isACommand(code: string): boolean {
	const runsAScript =
		code.startsWith("node scripts/") || code.startsWith("scripts/");
	const namesAFamily = /^(node )?scripts\/\S+ \.\.\.$/.test(code);
	return runsAScript && !namesAFamily;
}

// The command lines written as code in these lines: inline code spans (`...`), and lines indented by 4 spaces or more
// (Markdown's indented code blocks, also inside list items), that run a script.
export function commandLinesIn(lines: string[]): string[] {
	const commands: string[] = [];
	for (const text of lines) {
		for (const match of text.matchAll(/`([^`]+)`/g)) {
			const code = match[1];
			if (code !== undefined && isACommand(code)) {
				commands.push(code);
			}
		}
		const indented = text.match(/^ {4,}(\S.*)$/);
		if (indented !== null && indented[1] !== undefined) {
			const code = indented[1].trim();
			if (isACommand(code)) {
				commands.push(code);
			}
		}
	}
	return commands;
}

// A command line with its placeholders filled in: D (after --date) and <date> a real date, <digests file> the digests
// file, each <id> an arXiv id (a trailing " ..." that repeats the last argument dropped), <scratchpad> and <your
// scratchpad directory> a scratch path, the venue's "<Conference> <year>", a <...URL...> or <url> a URL, <doi> a DOI,
// <n> a number, and <summary> a sentence holding an apostrophe, written '\'' as the instructions say. A placeholder left over
// throws, naming the line, so a new one is filled in here on purpose.
export function filledIn(
	command: string,
	digestsFile: string,
	scratch: string,
): string {
	let filled = command
		.replace(/--date D(?= |$)/g, `--date ${FILL_DATE}`)
		.replaceAll("<date>", FILL_DATE)
		.replaceAll("<digests file>", digestsFile)
		.replaceAll("<id>", "2507.11473")
		.replaceAll("<your scratchpad directory>", scratch)
		.replaceAll("<scratchpad>", scratch)
		.replaceAll("<Conference> <year>", "ACL 2026")
		.replaceAll("<url>", "https://example.com/news/1")
		.replaceAll("<doi>", "10.1038/s41586-026-00001-1")
		.replaceAll("<n>", "1")
		.replaceAll("<summary>", "The brain'\\''s map of time.")
		.replace(/<[^<>]*URL[^<>]*>/g, "https://example.com/source");
	if (filled.endsWith(" ...")) {
		filled = filled.slice(0, -" ...".length);
	}
	if (/<[^<>]*>|(^| )D( |$)/.test(filled)) {
		throw new Error(`a placeholder is left in ${command}: ${filled}`);
	}
	return filled;
}

// The Bash rules of .claude/settings.json's permissions.allow, each as the text inside "Bash(...)".
export function bashAllowRules(): string[] {
	const settings: unknown = JSON.parse(
		fs.readFileSync(path.join(ROOT, ".claude", "settings.json"), "utf8"),
	);
	if (!isJsonObject(settings) || !isJsonObject(settings.permissions)) {
		throw new Error(".claude/settings.json has no permissions object");
	}
	const allow = settings.permissions.allow;
	if (!Array.isArray(allow)) {
		throw new Error(".claude/settings.json has no permissions.allow list");
	}
	const listed: unknown[] = allow;
	const rules: string[] = [];
	for (const rule of listed) {
		if (
			typeof rule === "string" &&
			rule.startsWith("Bash(") &&
			rule.endsWith(")")
		) {
			rules.push(rule.slice("Bash(".length, -1));
		}
	}
	return rules;
}

// Whether a Bash rule's text matches a command, as https://code.claude.com/docs/en/permissions ("Wildcard patterns",
// read 2026-10-12) says: "A rule with no `*` matches one exact command." A trailing " *" matches the text before it
// followed by a space and any text ("A `*` in a Bash rule matches any text, including spaces"; "The space before a
// trailing `*` is part of the rule"), and "A `*` at the end, with a space before it, also matches the bare command ...
// only when the trailing `*` is the rule's only wildcard". "The `:*` suffix is an equivalent way to write a trailing
// wildcard". The allow list holds only these shapes; any other throws rather than being guessed at.
export function ruleMatches(rule: string, command: string): boolean {
	const wildcards = rule.split("*").length - 1;
	if (wildcards === 0) {
		return rule === command;
	}
	let base: string | null = null;
	if (wildcards === 1 && rule.endsWith(" *")) {
		base = rule.slice(0, -" *".length);
	}
	if (wildcards === 1 && rule.endsWith(":*")) {
		base = rule.slice(0, -":*".length);
	}
	if (base === null) {
		throw new Error(
			`the rule Bash(${rule}) has a wildcard shape this test doesn't read`,
		);
	}
	return command === base || command.startsWith(`${base} `);
}
