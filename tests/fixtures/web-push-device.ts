// A device and its push service, for the tests of the Worker's notifications (notify.test.ts).
// The device holds the keys a browser's subscription has and decrypts what the Worker sends it, as RFC 8291 describes
// (aes128gcm, https://www.rfc-editor.org/rfc/rfc8291). The push service is a local server that records each push it is
// given and answers with the status a test chose, or never answers.
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

// A VAPID key pair in the form the Worker's secrets hold: the public key as 65 raw bytes and the
// private key as the JWK's "d", both base64url.
export function newVapidKeys(): { publicKey: string; privateKey: string } {
	const keys = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
	const jwk = keys.privateKey.export({ format: "jwk" });
	return {
		publicKey: Buffer.concat([
			Buffer.from([4]),
			Buffer.from(jwk.x ?? "", "base64url"),
			Buffer.from(jwk.y ?? "", "base64url"),
		]).toString("base64url"),
		privateKey: jwk.d ?? "",
	};
}

// What a subscription holds, as POST push saves it: p256dh and auth are base64url text.
export type Subscription = { endpoint: string; p256dh: string; auth: string };

export type Device = {
	subscription: Subscription;
	// The JSON a push body carries once decrypted; throws for a body that isn't this device's.
	decrypt(body: Buffer): unknown;
};

// A device with fresh keys, subscribed at `endpoint`.
export function newDevice(endpoint: string): Device {
	const keys = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
	const jwk = keys.privateKey.export({ format: "jwk" });
	const publicKey = Buffer.concat([
		Buffer.from([4]),
		Buffer.from(jwk.x ?? "", "base64url"),
		Buffer.from(jwk.y ?? "", "base64url"),
	]);
	const authSecret = crypto.randomBytes(16);
	return {
		subscription: {
			endpoint: endpoint,
			p256dh: publicKey.toString("base64url"),
			auth: authSecret.toString("base64url"),
		},
		decrypt(body) {
			// The header: salt (16), record size (4), key id length (1), the server's public key (65), then the record.
			const salt = body.subarray(0, 16);
			const idLength = body.readUInt8(20);
			const serverPublic = body.subarray(21, 21 + idLength);
			const record = body.subarray(21 + idLength);

			const ecdh = crypto.createECDH("prime256v1");
			ecdh.setPrivateKey(Buffer.from(jwk.d ?? "", "base64url"));
			const shared = ecdh.computeSecret(serverPublic);
			const keyInfo = Buffer.concat([
				Buffer.from("WebPush: info\0"),
				publicKey,
				serverPublic,
			]);
			const secret = Buffer.from(
				crypto.hkdfSync("sha256", shared, authSecret, keyInfo, 32),
			);
			const key = Buffer.from(
				crypto.hkdfSync(
					"sha256",
					secret,
					salt,
					Buffer.from("Content-Encoding: aes128gcm\0"),
					16,
				),
			);
			const nonce = Buffer.from(
				crypto.hkdfSync(
					"sha256",
					secret,
					salt,
					Buffer.from("Content-Encoding: nonce\0"),
					12,
				),
			);
			const decipher = crypto.createDecipheriv("aes-128-gcm", key, nonce);
			decipher.setAuthTag(record.subarray(record.length - 16));
			const padded = Buffer.concat([
				decipher.update(record.subarray(0, record.length - 16)),
				decipher.final(),
			]);
			// The record ends in a delimiter byte 0x02 (the last record) and zero padding after it.
			const end = padded.lastIndexOf(2);
			return JSON.parse(padded.subarray(0, end).toString("utf8"));
		},
	};
}

// One push the service was given.
export type PushRequest = {
	path: string;
	headers: http.IncomingHttpHeaders;
	body: Buffer;
};

// A push service. `answers` maps a path to the status it answers with (201 when absent) and `silent` lists the paths it
// never answers; a non-201 answer carries a reason as JSON, as Apple's does. `redirects` maps a path to the address a 302
// sends the sender to. `handle` answers one request of a server.
export type PushService = {
	requests: PushRequest[];
	answers: Map<string, number>;
	silent: Set<string>;
	redirects: Map<string, string>;
	handle(
		request: http.IncomingMessage,
		response: http.ServerResponse,
	): Promise<void>;
};

export function createPushService(): PushService {
	const requests: PushRequest[] = [];
	const answers = new Map<string, number>();
	const silent = new Set<string>();
	const redirects = new Map<string, string>();
	return {
		requests: requests,
		answers: answers,
		silent: silent,
		redirects: redirects,
		async handle(request, response) {
			const chunks: Buffer[] = [];
			for await (const chunk of request) {
				chunks.push(chunk as Buffer);
			}
			const path = request.url ?? "";
			requests.push({
				path: path,
				headers: request.headers,
				body: Buffer.concat(chunks),
			});
			if (silent.has(path)) {
				return;
			}
			const location = redirects.get(path);
			if (location !== undefined) {
				response.writeHead(302, { location: location });
				response.end();
				return;
			}
			const status = answers.get(path) ?? 201;
			response.writeHead(status, { "content-type": "application/json" });
			if (status === 201) {
				response.end();
			} else {
				response.end(JSON.stringify({ reason: `Answered${status}` }));
			}
		},
	};
}

// A push service listening on 127.0.0.1.
export type PushServer = PushService & {
	origin: string;
	close(): Promise<void>;
};

export async function startPushService(): Promise<PushServer> {
	const service = createPushService();
	const sockets = new Set<import("node:net").Socket>();
	const server = http.createServer((request, response) => {
		service.handle(request, response).catch((error: unknown) => {
			console.error("the stand-in push service failed:", error);
			response.destroy();
		});
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	return {
		...service,
		origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		close: () =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) {
					socket.destroy();
				}
				server.close(() => resolve());
			}),
	};
}
