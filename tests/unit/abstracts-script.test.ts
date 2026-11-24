// Unit tests for the program scripts/scout/proceedings/abstracts.ts, against a Semantic Scholar stand-in on 127.0.0.1.
import { describe, test } from "vitest";

describe("abstracts from Semantic Scholar", () => {
	test.todo(
		"a DOI paper of the run's day without an abstract gets Semantic Scholar's abstract, and the file's other lines stay as they were",
	);

	test.todo(
		"a paper that has an abstract, an arXiv paper and a paper of an earlier day are not asked about",
	);

	test.todo(
		"a paper Semantic Scholar doesn't know, or knows without an abstract, is named and stays without one",
	);

	test.todo(
		"without a Semantic Scholar key nothing is asked, the missing key is named and the run exits 1",
	);

	test.todo(
		"a Semantic Scholar that refuses the key or answers an error is named, the paper stays without an abstract and the run exits 1",
	);

	test.todo(
		"security: the Semantic Scholar key goes only in the x-api-key header and never appears in what the run prints",
	);
});
