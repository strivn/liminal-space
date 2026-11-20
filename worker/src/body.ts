// Reading a request's body: its bytes within a limit, then the JSON they hold. Shared by the sync, owner and mcp routes.

// The body's bytes, or null when it is larger than `maxBytes`. Content-Length is trusted only to refuse early:
// the bytes are counted as they arrive, so a body longer than its header says is still caught.
export async function readBody(
	request: Request,
	maxBytes: number,
): Promise<Uint8Array | null> {
	const declared = Number(request.headers.get("Content-Length") || "0");
	if (declared > maxBytes) {
		return null;
	}
	if (request.body === null) {
		return new Uint8Array(0);
	}
	const chunks: Uint8Array[] = [];
	let total = 0;
	const reader = request.body.getReader();
	while (true) {
		// biome-ignore lint/performance/noAwaitInLoops: a stream gives its chunks one after another
		const chunk = await reader.read();
		if (chunk.done) {
			break;
		}
		total += chunk.value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			return null;
		}
		chunks.push(chunk.value);
	}
	// Join the chunks into one block of bytes.
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

// What a body's bytes hold as JSON. Throws for bytes that aren't UTF-8 (fatal: they never turn into replacement
// characters) or text that isn't JSON.
export function jsonOf(bytes: Uint8Array): unknown {
	const text = new TextDecoder("utf-8", {
		fatal: true,
		ignoreBOM: false,
	}).decode(bytes);
	return JSON.parse(text);
}
