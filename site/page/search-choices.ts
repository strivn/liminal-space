// The choice panel's words per blank.
import type { SearchEntry } from "../../shared/site-data-shape.ts";
import { venueOf } from "../../shared/venue.ts";
import { el } from "./dom.ts";
import { iconSvg, type RailIcon } from "./icons.ts";
import type { Sentence } from "./search.ts";

export type Blank = "kind" | "subject" | "venue" | "time" | "read";

// What a panel reads and calls.
export type PanelContext = {
	sentence: Sentence;
	entries: readonly SearchEntry[];
	today: string;
	typed: string;
	count: (change: Partial<Sentence>) => number;
	pick: (change: Partial<Sentence>, closes: boolean) => void;
	type: (text: string) => void;
	done: () => void;
};

// Topics this big list up front.
const BIG_TOPIC = 5;
// Keywords listed, and found by typing.
const KEYWORDS_LISTED = 14;
const KEYWORDS_FOUND = 24;

export const KINDS: { id: Sentence["kind"]; word: string }[] = [
	{ id: "all", word: "everything" },
	{ id: "paper", word: "papers" },
	{ id: "reading", word: "news and articles" },
];

const READS: {
	id: NonNullable<Sentence["marks"]["read"]>;
	word: string;
	icon: RailIcon;
}[] = [
	{ id: "unread", word: "unread", icon: "unread" },
	{ id: "abstract", word: "abstract read", icon: "abstract" },
	{ id: "paper", word: "paper read", icon: "paper" },
];

const TAGS: { name: string; icon: RailIcon }[] = [
	{ name: "To read", icon: "toRead" },
	{ name: "Learn first", icon: "learnFirst" },
];

const NOTES: {
	id: "commented" | "highlighted";
	word: string;
	icon: RailIcon;
}[] = [
	{ id: "commented", word: "commented", icon: "comment" },
	{ id: "highlighted", word: "highlighted", icon: "highlighter" },
];

// Entry months, newest first.
export function monthsOf(entries: readonly SearchEntry[], today: string) {
	const months = new Set(entries.map((entry) => entry.date.slice(0, 7)));
	months.add(today.slice(0, 7));
	return [...months].sort().reverse();
}

// The time blank's words.
export function timeWord(time: string, today: string): string {
	if (time === "today") return "today";
	if (time === "week") return "in the last week";
	if (time === "any") return "any time";
	const month = time.slice(2);
	if (month === today.slice(0, 7)) return "this month";
	const sameYear = month.slice(0, 4) === today.slice(0, 4);
	const name = new Intl.DateTimeFormat("en-GB", {
		month: "long",
		year: sameYear ? undefined : "numeric",
		timeZone: "UTC",
	}).format(new Date(`${month}-01T00:00:00Z`));
	return `in ${name}`;
}

let wordCount = 0;

type WordOptions = {
	key: string;
	icon?: RailIcon;
	quiet?: boolean;
	// A radio, else a toggle.
	single?: boolean;
	// Accessible name, if not the label.
	name?: string;
	// Pickable even when it shows none.
	always?: boolean;
};

// One choice with its count.
function word(
	label: string,
	count: number,
	pressed: boolean,
	press: () => void,
	options: WordOptions,
) {
	const id = `search-count-${++wordCount}`;
	const cut = label.lastIndexOf(" ");
	const button = el(
		"button",
		{
			type: "button",
			class: options.quiet
				? "search__word search__word--quiet"
				: "search__word",
			"data-key": options.key,
			"aria-label": options.name ?? label,
			"aria-describedby": id,
		},
		options.icon === undefined ? null : iconSvg(options.icon),
		label.slice(0, cut + 1),
		el(
			"span",
			{ class: "search__nowrap" },
			label.slice(cut + 1),
			el("sup", { "aria-hidden": "true" }, String(count)),
		),
		el(
			"span",
			{ id: id, class: "visually-hidden" },
			`${count} ${count === 1 ? "entry" : "entries"}`,
		),
	);
	if (options.single) {
		button.setAttribute("role", "radio");
		button.setAttribute("aria-checked", String(pressed));
		button.tabIndex = pressed ? 0 : -1;
	} else {
		button.setAttribute("aria-pressed", String(pressed));
	}
	if (count === 0 && !pressed && !options.always) button.disabled = true;
	button.addEventListener("click", press);
	return button;
}

// Radios with arrow-key movement.
function radioGroup(name: string, ...children: (Node | null)[]) {
	const group = el(
		"div",
		{ class: "search__words", role: "radiogroup", "aria-label": name },
		...children,
	);
	group.addEventListener("keydown", (event) => {
		const steps: Record<string, number> = {
			ArrowDown: 1,
			ArrowRight: 1,
			ArrowUp: -1,
			ArrowLeft: -1,
		};
		const step = steps[event.key];
		if (step === undefined) return;
		const radios = [
			...group.querySelectorAll<HTMLButtonElement>(
				'[role="radio"]:not(:disabled)',
			),
		];
		const at = radios.indexOf(document.activeElement as HTMLButtonElement);
		const next = radios[(at + step + radios.length) % radios.length];
		if (at === -1 || next === undefined) return;
		event.preventDefault();
		next.focus();
	});
	return group;
}

function groupLabel(text: string) {
	return el("span", { class: "search__group" }, text);
}

export function kindPanel(ctx: PanelContext): Node[] {
	return [
		radioGroup(
			"Kind",
			...KINDS.map((kind) =>
				word(
					kind.word,
					ctx.count({ kind: kind.id }),
					ctx.sentence.kind === kind.id,
					() => ctx.pick({ kind: kind.id }, true),
					{ key: `kind:${kind.id}`, single: true },
				),
			),
		),
	];
}

export function timePanel(ctx: PanelContext): Node[] {
	const choices = [
		"today",
		"week",
		...monthsOf(ctx.entries, ctx.today).map((month) => `m:${month}`),
		"any",
	];
	return [
		radioGroup(
			"Time",
			...choices.map((time) =>
				word(
					timeWord(time, ctx.today),
					ctx.count({ time: time }),
					ctx.sentence.time === time,
					() => ctx.pick({ time: time }, true),
					{
						key: `time:${time}`,
						single: true,
						quiet: !time.startsWith("m:"),
					},
				),
			),
		),
	];
}

// A track's word.
function trackWord(track: string): string {
	return track === "" ? "main track" : track;
}

export function venuePanel(ctx: PanelContext): Node[] {
	const tracks = new Map<string, Map<string, string>>();
	for (const entry of ctx.entries) {
		if (entry.venue === null) continue;
		const written = venueOf(entry.venue);
		const known = tracks.get(written.conference) ?? new Map<string, string>();
		known.set(written.track, written.label);
		tracks.set(written.conference, known);
	}
	const venue = ctx.sentence.venue;
	const pick = (key: string) => () => ctx.pick({ venue: key }, true);
	const conferences = [...tracks.entries()].sort(([a], [b]) =>
		a.localeCompare(b),
	);
	const rows = conferences.map(([conference, own]) => {
		const row = el(
			"span",
			null,
			word(
				conference,
				ctx.count({ venue: conference }),
				venue === conference,
				pick(conference),
				{ key: `venue:${conference}`, single: true },
			),
		);
		// Tracks beyond the main one.
		if (own.size > 1 || !own.has("")) {
			const sorted = [...own.entries()].sort(([a], [b]) => a.localeCompare(b));
			row.append(
				el(
					"span",
					{ class: "search__tracks" },
					...sorted.map(([track, label]) => {
						const key = `${conference}|${track}`;
						return word(
							trackWord(track),
							ctx.count({ venue: key }),
							venue === key,
							pick(key),
							{ key: `venue:${key}`, single: true, name: label },
						);
					}),
				),
			);
		}
		return row;
	});
	return [
		radioGroup(
			"Venue",
			word("any venue", ctx.count({ venue: "" }), venue === "", pick(""), {
				key: "venue:",
				single: true,
				quiet: true,
			}),
			conferences.length > 0 ? groupLabel("Conferences") : null,
			...rows,
		),
	];
}

export function readPanel(ctx: PanelContext): Node[] {
	const marks = ctx.sentence.marks;
	const patch = (change: Partial<Sentence["marks"]>) => ({
		marks: { ...marks, ...change },
	});
	const toggled = (tag: string) =>
		marks.tags.includes(tag)
			? marks.tags.filter((other) => other !== tag)
			: [...marks.tags, tag];
	return [
		groupLabel("Read"),
		radioGroup(
			"Read",
			word(
				"read or not",
				ctx.count(patch({ read: null })),
				marks.read === null,
				() => ctx.pick(patch({ read: null }), false),
				{ key: "read:", single: true, quiet: true },
			),
			...READS.map((read) =>
				word(
					read.word,
					ctx.count(patch({ read: read.id })),
					marks.read === read.id,
					() => ctx.pick(patch({ read: read.id }), false),
					{ key: `read:${read.id}`, single: true, icon: read.icon },
				),
			),
		),
		groupLabel("Tagged"),
		el(
			"div",
			{ class: "search__words", role: "group", "aria-label": "Tagged" },
			...TAGS.map((tag) =>
				word(
					tag.name,
					ctx.count(
						marks.tags.includes(tag.name)
							? {}
							: patch({ tags: toggled(tag.name) }),
					),
					marks.tags.includes(tag.name),
					() => ctx.pick(patch({ tags: toggled(tag.name) }), false),
					{ key: `tag:${tag.name}`, icon: tag.icon },
				),
			),
		),
		groupLabel("Notes"),
		el(
			"div",
			{ class: "search__words", role: "group", "aria-label": "Notes" },
			...NOTES.map((note) =>
				word(
					note.word,
					ctx.count(marks[note.id] ? {} : patch({ [note.id]: true })),
					marks[note.id],
					() => ctx.pick(patch({ [note.id]: !marks[note.id] }), false),
					{ key: `note:${note.id}`, icon: note.icon },
				),
			),
		),
		groupLabel("Added"),
		el(
			"div",
			{ class: "search__words", role: "group", "aria-label": "Added" },
			word(
				"ad hoc",
				ctx.count(marks.adHoc ? {} : patch({ adHoc: true })),
				marks.adHoc,
				() => ctx.pick(patch({ adHoc: !marks.adHoc }), false),
				{ key: "adhoc", icon: "adhoc", always: true },
			),
		),
	];
}

// Names by entry count.
function tally(names: Iterable<string>): [string, number][] {
	const counts = new Map<string, number>();
	for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
	return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

// The subject blank's box and words.
export function subjectPanel(ctx: PanelContext): {
	nodes: Node[];
	drawWords: () => void;
} {
	const list = el("div", { class: "search__words search__words--subjects" });
	const subjects = ctx.sentence.subjects;
	const topics = tally(
		ctx.entries.flatMap((entry) => (entry.topic ? [entry.topic.name] : [])),
	);
	const fieldOf = new Map(
		ctx.entries.flatMap((entry) =>
			entry.topic ? [[entry.topic.name, entry.topic.field] as const] : [],
		),
	);
	const fields = tally(
		ctx.entries.flatMap((entry) => (entry.topic ? [entry.topic.field] : [])),
	).map(([field]) => field);
	const keywords = tally(ctx.entries.flatMap((entry) => entry.keywords));

	function subjectWord(key: string, label: string, quiet = false) {
		const on = subjects.includes(key);
		const next = on
			? subjects.filter((other) => other !== key)
			: [...subjects, key];
		return word(
			label,
			ctx.count({ subjects: next }),
			on,
			() => ctx.pick({ subjects: next }, false),
			{ key: `subject:${key}`, quiet: quiet },
		);
	}

	const input = el("input", {
		type: "search",
		class: "search__box",
		"aria-label": "Find a topic or keyword",
		enterkeyhint: "done",
		autocomplete: "off",
		spellcheck: "false",
	});
	input.value = ctx.typed;
	input.addEventListener("input", () => ctx.type(input.value.trim()));
	input.addEventListener("keydown", (event) => {
		if (event.key !== "Enter") return;
		const typed = ctx.typed.toLowerCase();
		const topic = topics.find(([name]) => name.toLowerCase().startsWith(typed));
		const keyword = keywords.find(([name]) => name.toLowerCase() === typed);
		let found: string | null = null;
		if (typed !== "" && topic !== undefined) found = `t:${topic[0]}`;
		else if (typed !== "" && keyword !== undefined) found = `k:${keyword[0]}`;
		if (found !== null && !subjects.includes(found)) {
			ctx.pick({ subjects: [...subjects, found] }, false);
		}
		ctx.done();
	});

	function drawFound(typed: string) {
		const has = (name: string) => name.toLowerCase().includes(typed);
		const foundTopics = topics.filter(([name]) => has(name));
		const foundFields = fields.filter(has);
		const foundKeywords = keywords
			.filter(([name]) => has(name))
			.slice(0, KEYWORDS_FOUND);
		if (!foundTopics.length && !foundFields.length && !foundKeywords.length) {
			list.replaceChildren(
				el("p", { class: "search__none" }, "No topic or keyword matches."),
			);
			return;
		}
		const nodes: Node[] = [];
		if (foundTopics.length || foundFields.length) {
			nodes.push(
				groupLabel("Topics (OpenAlex)"),
				...foundTopics.map(([name]) => subjectWord(`t:${name}`, name)),
				...foundFields.map((field) =>
					subjectWord(`f:${field}`, `anything in ${field}`, true),
				),
			);
		}
		if (foundKeywords.length) {
			nodes.push(
				groupLabel("Keywords (OpenAlex)"),
				...foundKeywords.map(([name]) => subjectWord(`k:${name}`, name)),
			);
		}
		list.replaceChildren(...nodes);
	}

	function drawListed() {
		const big = topics.filter(([, count]) => count >= BIG_TOPIC);
		const small = topics
			.filter(([, count]) => count < BIG_TOPIC)
			.map(([name]) => name);
		const smallOn = small.some((name) => subjects.includes(`t:${name}`));
		const tail = el("details", { class: "search__tail" });
		if (smallOn) tail.open = true;
		tail.append(
			el("summary", null, `More topics (${small.length})`),
			el(
				"div",
				{ class: "search__words" },
				...fields.flatMap((field) => [
					subjectWord(`f:${field}`, `anything in ${field}`, true),
					...small
						.filter((name) => fieldOf.get(name) === field)
						.map((name) => subjectWord(`t:${name}`, name)),
				]),
			),
		);
		const picked = subjects.filter((key) => key.startsWith("k:"));
		const nodes: Node[] = [
			word(
				"any subject",
				ctx.count({ subjects: [] }),
				subjects.length === 0,
				() => ctx.pick({ subjects: [] }, false),
				{ key: "subject:", quiet: true },
			),
		];
		if (topics.length) {
			nodes.push(
				groupLabel("Topics (OpenAlex)"),
				...big.map(([name]) => subjectWord(`t:${name}`, name)),
			);
			if (small.length) nodes.push(tail);
		}
		if (picked.length) {
			nodes.push(
				groupLabel("Picked keywords"),
				...picked.map((key) => subjectWord(key, key.slice(2))),
			);
		}
		if (keywords.length) {
			nodes.push(
				groupLabel("Keywords (OpenAlex)"),
				...keywords
					.slice(0, KEYWORDS_LISTED)
					.map(([name]) => subjectWord(`k:${name}`, name)),
			);
		}
		const classified = ctx.entries.some((entry) => entry.topic !== null);
		const waiting = ctx.entries.some(
			(entry) => entry.type === "paper" && entry.topic === null,
		);
		if (classified && waiting) {
			nodes.push(
				groupLabel("Not in OpenAlex yet"),
				subjectWord("none", "no topic yet", true),
			);
		}
		list.replaceChildren(...nodes);
	}

	function drawWords() {
		const typed = ctx.typed.toLowerCase();
		if (typed === "") drawListed();
		else drawFound(typed);
	}
	drawWords();

	const nodes: Node[] = [input, list];
	if (subjects.length > 1) {
		const join = (which: Sentence["join"]) =>
			el(
				"button",
				{ type: "button", "aria-pressed": String(ctx.sentence.join === which) },
				which === "or" ? "any" : "all",
			);
		const any = join("or");
		const all = join("and");
		any.addEventListener("click", () => ctx.pick({ join: "or" }, false));
		all.addEventListener("click", () => ctx.pick({ join: "and" }, false));
		nodes.push(
			el(
				"p",
				{ class: "search__join", role: "group", "aria-label": "Entries about" },
				"Entries about ",
				any,
				" / ",
				all,
			),
		);
	}
	return { nodes: nodes, drawWords: drawWords };
}
