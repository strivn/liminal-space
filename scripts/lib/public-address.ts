// Whether an address is on the public internet, checked before each fetch: the HTTP helper (http.ts),
// scripts/scout/web/describe.ts and scripts/scout/web/fetch-guard.ts (fulltext.sh's check) share it.
import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { isLocalAddress } from "../../shared/local-address.ts";
import { errorCode } from "../../shared/narrow.ts";

// Why an address isn't fetched: its reason, as the refusal prints it.
export class FetchRefused extends Error {}

// The checked address and port to connect to for `text`, or null for a local address LIMINAL_ALLOW_LOCAL
// names. Throws FetchRefused for an address that isn't on the public internet or can't be resolved.
export async function publicAddress(
	text: string,
): Promise<{ address: string; port: string } | null> {
	// Node reads "\" as "/" and curl doesn't, so "http://8.8.8.8\@127.0.0.1/" names two hosts. Such addresses, and
	// ones holding spaces or control characters, are refused.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point of this check
	if (/[\\\s\x00-\x1f\x7f]/.test(text)) {
		throw new FetchRefused(
			`"${text}" holds a backslash, a space or a control character`,
		);
	}
	const url = new URL(text);
	// URL keeps the brackets of an IPv6 host ("[::1]"); addresses are compared without them.
	const host = url.hostname.replace(/^\[|\]$/g, "");
	let port = url.port;
	if (port === "" && url.protocol === "https:") {
		port = "443";
	}
	if (port === "") {
		port = "80";
	}
	// Test stand-ins only.
	const allowed = (process.env.LIMINAL_ALLOW_LOCAL ?? "").split(",");
	if (allowed.includes(`${host}:${port}`)) {
		return null;
	}
	let addresses: LookupAddress[];
	try {
		addresses = await lookup(host, { all: true, verbatim: true });
	} catch (error) {
		throw new FetchRefused(
			`"${host}" could not be resolved (${errorCode(error)})`,
		);
	}
	// Every address the name resolves to must be public (the ranges: local-address.ts, which the Worker shares).
	for (const entry of addresses) {
		if (isLocalAddress(entry.address)) {
			throw new FetchRefused(`"${host}" is not on the public internet`);
		}
	}
	const first = addresses[0];
	if (first === undefined) {
		throw new FetchRefused(`"${host}" could not be resolved (no address)`);
	}
	return { address: first.address, port: port };
}
