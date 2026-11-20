// Loaded with `node --import` before a script under test, so the script can't reach the network: every fetch() and every
// socket connection is noted on stderr and refused before it connects. A step that must see "no request was made" looks
// for the note; a script that tries a real site (example.com, arxiv.org) is stopped. Python analogue: a sitecustomize
// that monkeypatches urllib and socket.
import fs from "node:fs";
import net from "node:net";

// The note's start on a stderr line, which the tests that load this file look for.
const NOTE = "no-network.ts: blocked ";

// Write straight to stderr (file descriptor 2), so the note lands even when the script exits right after.
function note(what: string): void {
	fs.writeSync(2, `${NOTE + what}\n`);
}

// fetch() notes its target and fails the way fetch fails on a refused connection: a TypeError with a cause.
globalThis.fetch = async function blockedFetch(resource) {
	let target = String(resource);
	if (resource instanceof Request) {
		target = resource.url;
	}
	note(`fetch ${target}`);
	throw new TypeError("fetch failed", {
		cause: new Error("the tests block the network"),
	});
};

// http.get, https.get, net.connect and tls.connect all open their socket through Socket.prototype.connect.
net.Socket.prototype.connect = function blockedConnect() {
	note("a socket connection");
	throw new Error("the tests block the network");
};
