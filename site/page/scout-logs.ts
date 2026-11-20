// The scout's logs on the owner's page: one folded "Scout logs" panel below the days, each stored run's log as the
// scout wrote it, newest first. The public page never asks for them.

import type { ScoutLog } from "../../shared/log-protocol.ts";
import { isJsonObject } from "../../shared/narrow.ts";
import { fetchJson } from "./data.ts";
import { dayLabel } from "./days.ts";
import { el, status } from "./dom.ts";

// The owner route, relative to the owner's page.
const LOGS_PATH = "../api/owner/logs";

// The runs the site holds, newest first as it sends them, or null when they can't be read.
async function loadScoutLogs(): Promise<ScoutLog[] | null> {
	const answer = await fetchJson(LOGS_PATH);
	const json = answer.json;
	if (answer.status !== 200 || !isJsonObject(json) || !Array.isArray(json.logs))
		return null;
	const runs: ScoutLog[] = [];
	for (const run of json.logs) {
		if (
			isJsonObject(run) &&
			typeof run.id === "string" &&
			typeof run.date === "string" &&
			typeof run.log === "string" &&
			typeof run.updated === "string"
		)
			runs.push({
				id: run.id,
				date: run.date,
				log: run.log,
				updated: run.updated,
			});
	}
	return runs;
}

// One run: its date and run id, then its log as text, never as HTML.
function runNode(run: ScoutLog): HTMLElement {
	return el(
		"section",
		{ class: "scout-log" },
		el(
			"h3",
			{ class: "scout-log__date" },
			`${dayLabel(run.date)} · run ${run.id}`,
		),
		el("pre", { class: "scout-log__text" }, run.log),
	);
}

// The panel's rows: every run, or why there are none.
function panelBody(runs: ScoutLog[] | null): HTMLElement[] {
	if (runs === null) return [status("warning", "Couldn't load the scout logs")];
	if (runs.length === 0)
		return [
			el("p", { class: "scout-logs__none" }, "No runs in the last 30 days"),
		];
	return runs.map(runNode);
}

// Read the logs and put the folded panel right after `main`, below the days in the same column: it moves nothing, and
// main holds only days.
export async function showScoutLogs(main: HTMLElement): Promise<void> {
	const runs = await loadScoutLogs();
	let count = "";
	if (runs !== null && runs.length === 1) count = " · 1 run";
	if (runs !== null && runs.length > 1) count = ` · ${runs.length} runs`;
	const panel = el(
		"div",
		{ class: "scout-logs" },
		el(
			"details",
			null,
			el("summary", null, `Scout logs${count}`),
			...panelBody(runs),
		),
	);
	main.after(panel);
}
