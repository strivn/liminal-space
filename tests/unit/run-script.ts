// Helpers for tests that run a script in a child process against local stand-ins and a temp folder.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Ran = { code: number; stdout: string; stderr: string };

const folders: string[] = [];

// A new temp folder, removed by removeTempFolders.
export function tempFolder(prefix: string): string {
	const folder = mkdtempSync(join(tmpdir(), prefix));
	folders.push(folder);
	return folder;
}

// Removes every folder tempFolder made.
export function removeTempFolders(): void {
	for (const folder of folders.splice(0)) {
		rmSync(folder, { recursive: true, force: true });
	}
}

// The script's absolute path from its path under scripts/.
export function scriptPath(name: string): string {
	return new URL(`../../scripts/${name}`, import.meta.url).pathname;
}

// Runs `node <script> <args>` with the given environment on top of this one; the exit code, stdout and stderr.
export function runScript(
	script: string,
	args: string[],
	env: Record<string, string> = {},
	cwd: string = process.cwd(),
): Promise<Ran> {
	return new Promise((resolve) => {
		execFile(
			process.execPath,
			[script, ...args],
			{ env: { ...process.env, ...env }, timeout: 120_000, cwd: cwd },
			(error, stdout, stderr) => {
				let code = 0;
				if (error !== null) {
					code = 1;
					if (typeof error.code === "number") {
						code = error.code;
					}
				}
				resolve({ code: code, stdout: stdout, stderr: stderr });
			},
		);
	});
}

// One digests-file line as the scripts write it.
export function digestText(date: string, entries: unknown[]): string {
	return `digest(${JSON.stringify({ date: date, entries: entries })});`;
}

// The entries of a digests-file line, read back.
export function entriesOfLine(line: string): Record<string, unknown>[] {
	const digest = JSON.parse(line.slice("digest(".length, -");".length));
	return digest.entries;
}
