// A stand-in for Cloudflare Access's key list: a local server that publishes signing keys and counts every fetch, and
// tokens signed the ways a Worker must refuse (any key, any algorithm, any claims).
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
	exportJWK,
	generateKeyPair,
	type JWK,
	type JWTPayload,
	SignJWT,
} from "jose";

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

// One signing key: the private half signs, the public half is what the server publishes under `kid`.
export type Key = { kid: string; privateKey: PrivateKey; jwk: JWK };

// Two RSA key pairs, made once for the whole run: making one takes the better part of a second.
type Material = "main" | "other";
const pairs = new Map<Material, ReturnType<typeof generateKeyPair>>();
function pairOf(material: Material) {
	let pair = pairs.get(material);
	if (pair === undefined) {
		pair = generateKeyPair("RS256");
		pairs.set(material, pair);
	}
	return pair;
}

export type KeyServer = {
	origin: string;
	// How many times a client fetched the key list.
	fetches: () => number;
	// An RS256 key under `kid`, not published until `publish` is called with it. Keys of the other material are a
	// different key pair from the main one's.
	newKey: (kid: string, material?: Material) => Promise<Key>;
	publish: (key: Key) => void;
	// The status the key list answers; 200 by default.
	answerWith: (status: number) => void;
	close: () => Promise<void>;
};

export async function startKeyServer(): Promise<KeyServer> {
	const published: JWK[] = [];
	let fetched = 0;
	let status = 200;
	const server = http.createServer((_request, response) => {
		fetched += 1;
		response.statusCode = status;
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify({ keys: published }));
	});
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return {
		origin: origin,
		fetches: () => fetched,
		newKey: async (kid, material = "main") => {
			const pair = await pairOf(material);
			const jwk = {
				...(await exportJWK(pair.publicKey)),
				kid: kid,
				alg: "RS256",
			};
			return { kid: kid, privateKey: pair.privateKey, jwk: jwk };
		},
		publish: (key) => {
			published.push(key.jwk);
		},
		answerWith: (code) => {
			status = code;
		},
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
			}),
	};
}

// Seconds since 1970, as JWT times count.
export function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

// An RS256 token with these claims, signed by `key`.
export function signedBy(key: Key, claims: JWTPayload): Promise<string> {
	return new SignJWT(claims)
		.setProtectedHeader({ alg: "RS256", kid: key.kid })
		.sign(key.privateKey);
}

// A token whose header says the algorithm is "none": no signature at all.
export function unsignedToken(claims: JWTPayload, kid: string): string {
	const part = (value: object) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${part({ alg: "none", kid: kid })}.${part(claims)}.`;
}

// A token signed with the shared secret HS256 uses, naming a published key's id.
export function hmacToken(claims: JWTPayload, kid: string): Promise<string> {
	return new SignJWT(claims)
		.setProtectedHeader({ alg: "HS256", kid: kid })
		.sign(
			new TextEncoder().encode("a shared secret of enough length 0123456789"),
		);
}
