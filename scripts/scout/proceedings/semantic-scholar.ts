// A paper's abstract from Semantic Scholar's Academic Graph API, for the DOI papers Crossref gives without one.
// Environment: SEMANTIC_SCHOLAR_API (a stand-in for tests).
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
	const response = await request(url, { headers: { "x-api-key": key } });
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
