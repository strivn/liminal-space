// Run by tests/unit/claude-ask.test.ts with tests/fixtures/no-network.ts loaded before it: asks Claude at Anthropic's real
// address, which the network guard refuses, and prints how the answer ended on the last line of stdout.
import { streamAnswer } from "../../worker/src/claude.ts";

const outcome = await streamAnswer(
	{ baseUrl: "https://api.anthropic.com", apiKey: "sk-ant-test-guard" },
	{
		entryId: "arxiv:2601.00001",
		title: "A paper",
		authors: [],
		venue: null,
		abstract: null,
		passage: null,
		thread: [{ author: "owner", text: "@Claude what does this mean?" }],
		paperUrls: ["https://arxiv.org/pdf/2601.00001"],
	},
	() => {},
);
console.log(JSON.stringify(outcome));
