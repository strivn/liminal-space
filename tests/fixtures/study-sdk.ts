// A stand-in for the Claude Agent SDK in the study job's tests. STUDY_STAND_IN names a JSON file
// { log: path, rules: [{ when, answers, delayMs? }] }: a call whose prompt holds `when` gets the next of the rule's
// answers (the last one again after that), and every call is appended to the log with its options and times.
import { appendFileSync, readFileSync } from "node:fs";

type Rule = { when: string; answers: unknown[]; delayMs?: number };
type Config = { log: string; rules: Rule[] };

const used = new Map<string, number>();

function result(fields: Record<string, unknown>) {
	return {
		type: "result",
		is_error: false,
		usage: { input_tokens: 10, output_tokens: 5 },
		...fields,
	};
}

export async function* query(call: {
	prompt: string;
	options: Record<string, unknown>;
}) {
	const path = process.env.STUDY_STAND_IN ?? "";
	const config: Config = JSON.parse(readFileSync(path, "utf8"));
	const startedAt = Date.now();
	const index = config.rules.findIndex((rule) =>
		call.prompt.includes(rule.when),
	);
	const rule = config.rules[index];
	if (rule === undefined) {
		yield result({ subtype: "error_during_execution" });
		return;
	}
	const key = `${path}#${index}`;
	const count = used.get(key) ?? 0;
	used.set(key, count + 1);
	await new Promise((resolve) => setTimeout(resolve, rule.delayMs ?? 0));
	appendFileSync(
		config.log,
		`${JSON.stringify({ prompt: call.prompt, options: call.options, startedAt: startedAt, endedAt: Date.now() })}\n`,
	);
	yield result({
		subtype: "success",
		structured_output: rule.answers[Math.min(count, rule.answers.length - 1)],
	});
}
