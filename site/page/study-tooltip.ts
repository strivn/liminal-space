// The tooltip of one word: the word and its pinyin, its meaning a second later, and each character's strokes and parts.
import type { CharFile } from "../../shared/site-data-shape.ts";
import type { StudyWord } from "../../shared/study-protocol.ts";
import { el } from "./dom.ts";
import type { StrokeDrawing } from "./study-strokes.ts";

// The pause before the meaning shows, so the reader can guess it first.
const MEANING_DELAY_MS = 1000;
// Between the tooltip and the word it explains.
const GAP_PX = 8;
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const HAN = /\p{Script=Han}/u;

export type TooltipEnv = {
	// A character's file once, shared by every word that uses it; null when it didn't load.
	charFile: (character: string) => Promise<CharFile | null>;
};

export type Tooltip = {
	element: HTMLElement;
	// Put the tooltip under or over the word's box (viewport coordinates), inside the column.
	place: (word: DOMRect, column: DOMRect) => void;
	close: () => void;
};

// Hanzi Writer comes in its own file, fetched the first time a tooltip needs it; a failed fetch is tried again.
let strokesFile: Promise<typeof import("./study-strokes.ts")> | null = null;
function loadStrokes() {
	if (strokesFile === null) {
		strokesFile = import("./study-strokes.js");
		strokesFile.catch(() => {
			strokesFile = null;
		});
	}
	return strokesFile;
}

// The pinyin of a word as written: its syllables joined, a name with a capital.
export function pinyinOf(word: StudyWord): string {
	const pinyin = word.syllables.join("");
	if (!word.name) return pinyin;
	return pinyin.charAt(0).toUpperCase() + pinyin.slice(1);
}

function marksOf(word: StudyWord): HTMLElement | null {
	let text: string | null = null;
	if (word.name) text = "Name, written for its sound";
	else if (!word.inDictionary) text = "Not in the dictionary";
	if (text === null) return null;
	return el(
		"div",
		{ class: "study-tip__marks" },
		el("span", { class: "study-tip__mark" }, text),
	);
}

// The lines under a character: its definition, its parts with what each gives it, and Make Me a Hanzi's note.
function bodyOf(character: string, file: CharFile): HTMLElement {
	const body = el(
		"div",
		{ class: "study-char__body" },
		el(
			"div",
			{ class: "study-char__name" },
			el("b", null, character),
			file.dictionary?.definition ?? "",
		),
	);
	for (const part of file.parts) {
		const details = [part.pinyin?.[0], part.definition]
			.filter((text) => text !== undefined && text !== "")
			.join(" · ");
		const line = el(
			"div",
			{ class: "study-part" },
			el("b", null, part.character),
			details,
		);
		if (part.role !== undefined) {
			const tag = part.role === "semantic" ? "meaning" : "sound";
			line.append(el("span", { class: `study-tag study-tag--${tag}` }, tag));
		}
		body.append(line);
	}
	const hint = file.dictionary?.etymology?.hint;
	if (hint !== undefined && hint !== "") {
		body.append(el("div", { class: "study-note" }, `Make Me a Hanzi: ${hint}`));
	}
	return body;
}

// Open the tooltip of `word`, not yet in the page: append `element` where the caller wants it.
export function createTooltip(word: StudyWord, env: TooltipEnv): Tooltip {
	const animate = !matchMedia?.(REDUCED_MOTION).matches;
	const meaning = el("span", {
		class: "study-tip__meaning",
		"data-waiting": "",
	});
	if (word.meaning !== "") {
		meaning.append(word.meaning);
		if (word.meaningFrom === "model")
			meaning.append(el("span", { class: "study-tip__by" }, "by Claude"));
	}
	const element = el(
		"div",
		{ class: "study-tip", role: "tooltip" },
		el(
			"div",
			{ class: "study-tip__head" },
			el("span", { class: "study-tip__word" }, word.text),
			el("span", { class: "study-tip__pinyin" }, pinyinOf(word)),
			meaning,
		),
		marksOf(word),
	);
	const timers: number[] = [];
	const drawings: StrokeDrawing[] = [];
	let closed = false;
	timers.push(
		window.setTimeout(
			() => meaning.removeAttribute("data-waiting"),
			MEANING_DELAY_MS,
		),
	);

	// One block per Han character, in order, each filled once its file is here.
	let place: () => void = () => undefined;
	if (!word.name) {
		[...word.text].forEach((character, index) => {
			if (!HAN.test(character)) return;
			const block = el("div", { class: "study-char" });
			block.hidden = true;
			element.append(block);
			void env.charFile(character).then(async (file) => {
				if (closed || file === null) return;
				const drawing = file.drawing;
				const box = el("div", {
					class: "study-strokes",
					role: "button",
					tabindex: "0",
					title: "Draw again",
					"aria-label": `Draw ${character} again`,
				});
				block.append(
					el(
						"div",
						{ class: "study-char__drawing" },
						drawing === null ? null : box,
						el(
							"span",
							{ class: "study-char__pinyin" },
							word.syllables[index] ?? "",
						),
					),
					bodyOf(character, file),
				);
				block.hidden = false;
				place();
				if (drawing === null) return;
				try {
					const strokes = await loadStrokes();
					if (closed) return;
					const drawn = strokes.drawStrokes(box, character, drawing, animate);
					drawings.push(drawn);
					box.addEventListener("click", drawn.play);
					box.addEventListener("keydown", (event) => {
						if (event.key !== "Enter" && event.key !== " ") return;
						event.preventDefault();
						drawn.play();
					});
					if (!animate)
						box.append(
							el(
								"span",
								{ class: "study-strokes__replay", "aria-hidden": "true" },
								"▶",
							),
						);
				} catch (error) {
					console.warn("The strokes did not load:", error);
				}
			});
		});
	}

	return {
		element: element,
		place: (anchor, column) => {
			// The roomier side, never switched.
			const above = anchor.top > window.innerHeight - anchor.bottom;
			const put = () => {
				const scrollX = window.scrollX;
				const scrollY = window.scrollY;
				element.style.maxWidth = `${column.width}px`;
				const width = element.offsetWidth;
				const left = Math.min(anchor.left, column.right - width);
				element.style.left = `${Math.max(column.left, left) + scrollX}px`;
				const top = above
					? anchor.top - GAP_PX - element.offsetHeight
					: anchor.bottom + GAP_PX;
				element.style.top = `${top + scrollY}px`;
			};
			place = put;
			put();
		},
		close: () => {
			closed = true;
			for (const timer of timers) window.clearTimeout(timer);
			for (const drawing of drawings) drawing.stop();
			element.remove();
		},
	};
}
