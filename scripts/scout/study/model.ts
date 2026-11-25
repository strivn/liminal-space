// One question to the model through the Claude Agent SDK, with no tools and none of the machine's own setup.
// The login is CLAUDE_CODE_OAUTH_TOKEN when set, else the machine's Claude login; ANTHROPIC_API_KEY never goes in.
// Tests set STUDY_SDK to a stand-in module that exports query({ prompt, options }); STUDY_MODEL picks another model.
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { SYSTEM_PROMPT } from "./prompt.ts";

const TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
// The only variables the model's process gets: what Claude Code needs to start, and the token.
const PASSED_ENV = ["HOME", "PATH", "USER", "TMPDIR", "LANG", TOKEN_ENV];
const CALL_TIMEOUT_MS = 300_000;

export type ModelAnswer = {
	output: unknown;
	ms: number;
	inputTokens: number;
	outputTokens: number;
};

// What a call cost us, from the SDK's result message.
type Usage = {
	input_tokens: number;
	output_tokens: number;
	cache_creation_input_tokens?: number | null;
	cache_read_input_tokens?: number | null;
};

// The SDK options for one question; `scratch` is an empty folder to run in.
export function studyOptions(
	scratch: string,
	env: Record<string, string | undefined>,
	schema: Record<string, unknown>,
	abortController: AbortController,
): Options {
	const passed: Record<string, string> = {};
	for (const name of PASSED_ENV) {
		const value = env[name];
		if (value !== undefined) {
			passed[name] = value;
		}
	}
	return {
		cwd: scratch,
		tools: [],
		settingSources: [],
		settings: {
			disableClaudeAiConnectors: true,
			autoMemoryEnabled: false,
			disableAllHooks: true,
			disableBundledSkills: true,
		},
		strictMcpConfig: true,
		mcpServers: {},
		plugins: [],
		systemPrompt: { type: "custom", prompt: SYSTEM_PROMPT },
		outputFormat: { type: "json_schema", schema: schema },
		maxTurns: 1,
		persistSession: false,
		permissionMode: "dontAsk",
		model: env.STUDY_MODEL || "sonnet",
		effort: "high",
		env: passed,
		abortController: abortController,
	};
}

// Ask once; a string says why there is no answer. A token in an error never reaches the message.
export async function askModel(
	prompt: string,
	schema: Record<string, unknown>,
	scratch: string,
): Promise<ModelAnswer | string> {
	const sdk: { query: typeof import("@anthropic-ai/claude-agent-sdk").query } =
		await import(process.env.STUDY_SDK || "@anthropic-ai/claude-agent-sdk");
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), CALL_TIMEOUT_MS);
	const started = performance.now();
	try {
		for await (const message of sdk.query({
			prompt: prompt,
			options: studyOptions(scratch, process.env, schema, abort),
		})) {
			if (message.type !== "result") {
				continue;
			}
			if (message.subtype !== "success" || message.is_error) {
				return `the model stopped (${message.subtype})`;
			}
			const usage: Usage = message.usage;
			return {
				output: message.structured_output,
				ms: Math.round(performance.now() - started),
				inputTokens:
					usage.input_tokens +
					(usage.cache_creation_input_tokens ?? 0) +
					(usage.cache_read_input_tokens ?? 0),
				outputTokens: usage.output_tokens,
			};
		}
		return "the model gave no result";
	} catch (error) {
		const reason = error instanceof Error ? error.message : "an error";
		const token = process.env[TOKEN_ENV];
		return `the model call failed: ${token ? reason.replaceAll(token, "[token removed]") : reason}`;
	} finally {
		clearTimeout(timer);
	}
}
