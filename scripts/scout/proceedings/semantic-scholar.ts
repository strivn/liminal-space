// A paper's abstract from Semantic Scholar's Academic Graph API, for the DOI papers Crossref gives without one.
// Environment: SEMANTIC_SCHOLAR_API and SEMANTIC_SCHOLAR_RETRY_MS (stand-ins for tests).
import { setTimeout as sleep } from "node:timers/promises";
import {
	cutAtWord,
	FIELD_CAPS,
	withoutControlCharacters,
} from "../../../shared/entry-checks.ts";
import { isJsonObject } from "../../../shared/narrow.ts";
import { request } from "../../lib/http.ts";

const SEMANTIC_SCHOLAR_API =
	process.env.SEMANTIC_SCHOLAR_API ||
	"https://api.semanticscholar.org/graph/v1";
// A 429 is asked again this many times, after 5, 10 and 20 seconds: the key's 1 request a second still meets 429s.
const RETRIES = 3;
const RETRY_MS = Number(process.env.SEMANTIC_SCHOLAR_RETRY_MS || 5000);

// What Semantic Scholar gave for one DOI, or why it gave nothing; a problem's words finish "Semantic Scholar ...".
export type AbstractAnswer =
	| { abstract: string }
	| { missing: "no key" | "not found" | "no abstract" }
	| { problem: string };

// One DOI's abstract. The key goes only in the x-api-key header, which request drops on a redirect to another host.
export async function semanticScholarAbstract(
	doi: string,
	key: string | undefined,
): Promise<AbstractAnswer> {
	if (!key) {
		return { missing: "no key" };
	}
	const url = `${SEMANTIC_SCHOLAR_API}/paper/DOI:${doi.split("/").map(encodeURIComponent).join("/")}?fields=abstract`;
	let response = await request(url, { headers: { "x-api-key": key } });
	for (let retry = 0; retry < RETRIES; retry++) {
		if ("problem" in response || response.status !== 429) {
			break;
		}
		// biome-ignore lint/performance/noAwaitInLoops: each retry waits out the one before
		await sleep(RETRY_MS * 2 ** retry);
		response = await request(url, { headers: { "x-api-key": key } });
	}
	if ("problem" in response) {
		return { problem: `${response.problem} (${url})` };
	}
	if (response.status === 404) {
		return { missing: "not found" };
	}
	if (!response.ok) {
		return { problem: `answered HTTP ${response.status} (${url})` };
	}
	let answer: unknown;
	try {
		answer = JSON.parse(response.text());
	} catch {
		return { problem: `answered with something that isn't JSON (${url})` };
	}
	if (!isJsonObject(answer) || typeof answer.abstract !== "string") {
		return { missing: "no abstract" };
	}
	const abstract = withoutControlCharacters(answer.abstract)
		.replace(/\s+/g, " ")
		.trim();
	if (abstract === "") {
		return { missing: "no abstract" };
	}
	return { abstract: cutAtWord(abstract, FIELD_CAPS.abstract) };
}
