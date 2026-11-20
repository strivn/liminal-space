// The newsfeed's reader for OpenRouter's model list: each new model from the named labs becomes an item.
import { isJsonObject } from "../../../shared/narrow.ts";
import {
	type Item,
	ReadProblem,
	usableDescription,
	WINDOW_MS,
} from "./item.ts";

type Model = { id: string; name: string; created: number; description: string };

// A model as OpenRouter lists it, or null when a field the newsfeed needs is missing.
function modelOf(value: unknown): Model | null {
	if (
		!isJsonObject(value) ||
		typeof value.id !== "string" ||
		typeof value.name !== "string" ||
		typeof value.created !== "number"
	) {
		return null;
	}
	let description = "";
	if (typeof value.description === "string") {
		description = value.description;
	}
	return {
		id: value.id,
		name: value.name,
		created: value.created,
		description: description,
	};
}

// Markdown links reduced to their text: "[Hy4](https://…)" becomes "Hy4".
function withoutLinks(text: string): string {
	return text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
}

// Each model from `providers` created in the window before `now` (ms), its variants ("x:free") folded into its base id.
export function releaseItems(
	models: string,
	providers: string[],
	now: number,
): Item[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(models);
	} catch {
		throw new ReadProblem("answered with something that isn't JSON");
	}
	if (!isJsonObject(parsed) || !Array.isArray(parsed.data)) {
		throw new ReadProblem("answered without a list of models");
	}
	const listed: unknown[] = parsed.data;
	// Every model of a base id: the base itself when listed, and its variants.
	const bases = new Map<string, Model[]>();
	for (const model of listed.map(modelOf)) {
		if (model === null || model.id.startsWith("~")) {
			continue;
		}
		if (!providers.includes(model.id.split("/")[0] as string)) {
			continue;
		}
		const base = model.id.split(":")[0] as string;
		bases.set(base, [...(bases.get(base) || []), model]);
	}
	const items: Item[] = [];
	for (const [base, group] of bases) {
		// A base listed after its variant is still the model first released at the variant's time.
		const created = Math.min(...group.map((m) => m.created));
		const at = new Date(created * 1000);
		const age = now - at.getTime();
		if (age < 0 || age > WINDOW_MS) {
			continue;
		}
		const named = group.find((m) => m.id === base);
		let title = (group[0] as Model).name.replace(/ \([^)]*\)$/, "");
		let description = (group[0] as Model).description;
		if (named !== undefined) {
			title = named.name;
			description = named.description;
		}
		items.push({
			title: title,
			url: `https://openrouter.ai/${base}`,
			at: at,
			authors: [],
			description: usableDescription([withoutLinks(description)]),
			categories: [],
		});
	}
	return items;
}
