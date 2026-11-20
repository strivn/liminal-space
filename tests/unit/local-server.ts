// Local HTTP servers on 127.0.0.1 for the tests of programs that fetch; nothing here reaches another host.
// Registers servers with the guard.
import assert from "node:assert/strict";
import http from "node:http";

export type Handler = (
	incoming: http.IncomingMessage,
	outgoing: http.ServerResponse,
) => void;

const open: http.Server[] = [];
const allowed = new Set<string>();

// Allow one more port.
export function allowLocal(port: number): void {
	allowed.add(`127.0.0.1:${port}`);
	process.env.LIMINAL_ALLOW_LOCAL = [...allowed].join(",");
}

// Listens on a free port.
async function listen(handler: Handler): Promise<string> {
	const server = http.createServer(handler);
	open.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");
	return `127.0.0.1:${address.port}`;
}

// A local server running `handler`; the address of its root.
export async function serve(handler: Handler): Promise<string> {
	const host = await listen(handler);
	allowLocal(Number(host.split(":")[1]));
	return `http://${host}`;
}

// A server the guard refuses.
export async function serveUnlisted(handler: Handler): Promise<string> {
	const host = await listen(handler);
	allowed.delete(host);
	process.env.LIMINAL_ALLOW_LOCAL = [...allowed].join(",");
	return `http://${host}`;
}

// Closes every server started so far, so their ports refuse connections.
export async function closeServers(): Promise<void> {
	for (const server of open.splice(0)) {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
}
