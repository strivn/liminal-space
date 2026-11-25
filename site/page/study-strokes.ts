// A character's strokes drawn with Hanzi Writer: a file of its own, fetched the first time a tooltip has a character.
import { default as HanziWriter } from "hanzi-writer";
import type { CharDrawing } from "../../shared/site-data-shape.ts";

// Hanzi Writer's own speed and pause, adjusted so a stroke takes about 20% longer to draw.
const STROKE_SPEED = 1.4 / 1.2;
const STROKE_PAUSE_MS = 108;
// A drawing is played this many times, this long apart.
const ROUNDS = 3;
const ROUND_GAP_MS = 2000;
const BOX_PIXELS = 62;
const BOX_PADDING = 4;

export type StrokeDrawing = {
	// Draw the character again, from the first stroke.
	play: () => void;
	// Stop drawing and drop what is waiting.
	stop: () => void;
};

// Draw `character` in `box` from its Hanzi Writer data. With `animate` it is drawn at once; without, it is shown still
// until `play` is called. Colours follow the box's own text colour and its --mark-muted.
export function drawStrokes(
	box: HTMLElement,
	character: string,
	drawing: CharDrawing,
	animate: boolean,
): StrokeDrawing {
	const style = getComputedStyle(box);
	const writer = HanziWriter.create(box, character, {
		width: BOX_PIXELS,
		height: BOX_PIXELS,
		padding: BOX_PADDING,
		showOutline: true,
		showCharacter: !animate,
		strokeAnimationSpeed: STROKE_SPEED,
		delayBetweenStrokes: STROKE_PAUSE_MS,
		strokeColor: style.color || "#555",
		outlineColor: style.getPropertyValue("--mark-muted").trim() || "#ddd",
		charDataLoader: (_character, onLoad) => onLoad(drawing),
	});
	let timer = 0;
	let stopped = false;
	function round(left: number) {
		void writer.animateCharacter({
			onComplete: ({ canceled }) => {
				if (canceled || stopped || left <= 1) return;
				timer = window.setTimeout(() => round(left - 1), ROUND_GAP_MS);
			},
		});
	}
	function play() {
		window.clearTimeout(timer);
		stopped = false;
		round(ROUNDS);
	}
	function stop() {
		stopped = true;
		window.clearTimeout(timer);
		writer.pauseAnimation().catch(() => undefined);
	}
	if (animate) play();
	return { play: play, stop: stop };
}
