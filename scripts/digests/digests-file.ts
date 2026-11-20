// Read a digests file line by line and write back only the lines a script changed (describe.ts, figure.ts).
import { randomBytes } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { normalizeId } from "../../shared/arxiv-id.ts";
import { readLines } from "../../shared/entry-checks.ts";
import { errorCode } from "../../shared/narrow.ts";

// One non-blank line of the digests file: its index in the file's lines and what parseLine read from it.
export type ParsedLine = { index: number; digest: unknown };

// A digests file as readDigests reads it: every line, and each non-blank line's digest.
export type DigestsFile = { lines: string[]; digests: ParsedLine[] };

// The file's lines, and each non-blank line's digest with its line index. The first line that doesn't load stops the
// run through `stop`, with its number counting from 1 and parseLine's "doesn't load ..." words, which never quote it.
export function readDigests(
	file: string,
	stop: (lineNumber: number, problem: string) => never,
): DigestsFile {
	const text = readFileSync(file, "utf8");
	const digests: ParsedLine[] = [];
	for (const line of readLines(text)) {
		if (line.problem !== undefined) {
			stop(line.number, line.problem);
		}
		digests.push({ index: line.number - 1, digest: line.digest });
	}
	return { lines: text.split("\n"), digests: digests };
}

// A digests file's text; "" when the file doesn't exist yet, and any other read error is thrown.
export function readDigestsText(file: string): string {
	try {
		return readFileSync(file, "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT") {
			return "";
		}
		throw error;
	}
}

// One day's line as the scripts write it, without its line break.
export function digestLine(date: string, entries: unknown[]): string {
	return `digest(${JSON.stringify({ date: date, entries: entries })});`;
}

// Add one day's line to the file's end (a missing file is created), after a line break when the last line has none.
// appendFileSync opens the file a symlink points to, so a link stays a link. Any read or write error is thrown.
export function appendDigestLine(
	file: string,
	date: string,
	entries: unknown[],
): void {
	// A hand edit can leave the last line without its line break; the new line must not join it.
	let lineBreak = "";
	const current = readDigestsText(file);
	if (current.length > 0 && !current.endsWith("\n")) {
		lineBreak = "\n";
	}
	appendFileSync(file, `${lineBreak}${digestLine(date, entries)}\n`);
}

// The ids a digests text holds: arXiv ids as "2507.11473" (no "arxiv:", no version), and "doi:" and "url:" ids as written.
export type DigestIds = { arxiv: Set<string>; other: Set<string> };

// JSON escapes quotes inside strings, so these patterns only match real "id" keys.
export function idsInText(text: string): DigestIds {
	const arxiv = new Set<string>();
	for (const match of text.matchAll(/"id"\s*:\s*"arxiv:([^"]+)"/g)) {
		if (match[1] !== undefined) {
			arxiv.add(normalizeId(match[1]));
		}
	}
	const other = new Set<string>();
	for (const match of text.matchAll(/"id"\s*:\s*"((?:doi|url):[^"]*)"/g)) {
		if (match[1] !== undefined) {
			other.add(match[1]);
		}
	}
	return { arxiv: arxiv, other: other };
}

// Rewrite only the lines whose index is in changedLines; every other line keeps its exact bytes. `read` is
// readDigests's result, with its digests' entries already changed. A write that fails stops the run through `stop`,
// with the real file's path and the error's code.
export function writeChangedLines(
	file: string,
	read: DigestsFile,
	changedLines: Set<number>,
	stop: (realPath: string, code: string | undefined) => never,
) {
	for (const { index, digest } of read.digests) {
		if (changedLines.has(index)) {
			read.lines[index] = `digest(${JSON.stringify(digest)});`;
		}
	}
	// Replace the file whole: a temporary file in the real file's folder, then a rename over the real file. A rename
	// within one folder swaps the file in one step, so an interrupted run leaves the old file whole. Through a
	// symlink, the file it points to is replaced and the link stays a link.
	const real = realpathSync(file);
	// A random name no one can know ahead, opened with "wx": the open fails when anything, a link included, is
	// already at that path, so the write can't be steered into another file.
	const temporary = join(
		dirname(real),
		`.${basename(real)}.${randomBytes(8).toString("hex")}.tmp`,
	);
	try {
		// The rename swaps in the temporary file's mode, so it takes the real file's: read, write and execute bits.
		const mode = statSync(real).mode & 0o777;
		// Created with that mode, the copy is never more open than the real file, even before the chmod.
		writeFileSync(temporary, read.lines.join("\n"), { flag: "wx", mode: mode });
		// The umask strips bits from a new file's mode; chmod puts them back.
		chmodSync(temporary, mode);
		renameSync(temporary, real);
	} catch (error) {
		// EEXIST: the name was taken, so what is there isn't this run's to remove.
		if (errorCode(error) !== "EEXIST") {
			rmSync(temporary, { force: true }); // force: no error when the temporary file was never made
		}
		stop(real, errorCode(error));
	}
}
