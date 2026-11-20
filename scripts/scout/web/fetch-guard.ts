// Checks for scripts/scout/web/fulltext.sh, which runs it before each fetch and before writing: is an address on the public
// internet (scripts/lib/public-address.ts), and is an output folder a temporary folder. Bash has no address-range or
// path tools, Node does.
// Usage:
//   node scripts/scout/web/fetch-guard.ts url <url>     prints "::<address>:<port>" to pin curl to (curl --connect-to),
//                                                    or nothing for a local address LIMINAL_ALLOW_LOCAL names
//   node scripts/scout/web/fetch-guard.ts folder <dir>  prints the folder's real path, when it is inside TMPDIR or the
//                                                    system's temporary folder (/private/tmp on macOS, /tmp on Linux)
// On a refusal it prints the reason to standard error and exits 1.
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { isIP } from "node:net";
import { basename, dirname, join, resolve, sep } from "node:path";
import { FetchRefused, publicAddress } from "../../lib/public-address.ts";

const USAGE =
	"usage: node scripts/scout/web/fetch-guard.ts url <url> | folder <dir>";

function refuse(reason: string): never {
	console.error(reason);
	process.exit(1);
}

// Check one address and print what curl should connect to.
async function checkUrl(text: string) {
	let checked: { address: string; port: string } | null;
	try {
		checked = await publicAddress(text);
	} catch (error) {
		if (error instanceof FetchRefused) {
			refuse(error.message);
		}
		throw error;
	}
	if (checked === null) {
		return;
	}
	// Pin curl to the address just checked: "--connect-to ::<address>:<port>" matches every host and port, so curl
	// connects there whatever host it reads from the URL, and a second DNS answer can't point it elsewhere.
	let address = checked.address;
	if (isIP(address) === 6) {
		address = `[${address}]`;
	}
	console.log(`::${address}:${checked.port}`);
}

// The real path of a folder that may not exist yet: the real path of its nearest existing parent, plus the rest.
function realPathOf(folder: string) {
	let existing = resolve(folder);
	const rest = [];
	while (!existsSync(existing)) {
		rest.unshift(basename(existing));
		existing = dirname(existing);
	}
	return join(realpathSync(existing), ...rest);
}

// The system's temporary folder, as refusals name it: /private/tmp on macOS (its /tmp links there), /tmp elsewhere.
function systemTemp() {
	if (process.platform === "darwin") {
		return "/private/tmp";
	}
	return "/tmp";
}

// The temporary folders output may go to; macOS adds its per-user temp folder.
function temporaryRoots() {
	const roots = [realPathOf(systemTemp())];
	if (process.env.TMPDIR) {
		roots.push(realPathOf(process.env.TMPDIR));
	}
	if (process.platform === "darwin") {
		const userTemp = execFileSync("getconf", ["DARWIN_USER_TEMP_DIR"], {
			encoding: "utf8",
		}).trim();
		if (userTemp !== "") {
			roots.push(realPathOf(userTemp));
		}
	}
	return roots;
}

function checkFolder(folder: string) {
	const real = realPathOf(folder);
	for (const root of temporaryRoots()) {
		if (real === root || real.startsWith(root.replace(/\/+$/, "") + sep)) {
			console.log(real);
			return;
		}
	}
	const refusal = `"${folder}" is not inside TMPDIR or ${systemTemp()}`;
	if (real === resolve(folder)) {
		refuse(refusal);
	}
	refuse(`${refusal}: it resolves to ${real}`);
}

// Run only when called as a script, not when imported.
if (import.meta.main) {
	const [command, value] = process.argv.slice(2);
	if (command === "url" && value) {
		await checkUrl(value);
	} else if (command === "folder" && value) {
		checkFolder(value);
	} else {
		refuse(USAGE);
	}
}
