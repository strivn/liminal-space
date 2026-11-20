// The comment column's cards, lined up with what they comment on.

import type { CommentView } from "../comment-board.ts";
import { stackTops } from "../comments.ts";

// Px between comment cards that would overlap.
const CARD_GAP = 8;

// What placing the cards needs from the board.
export type PlacingNeeds = {
	articleOf: (view: CommentView) => HTMLElement;
};

export function createPlacing(needs: PlacingNeeds): {
	placeCards: (view: CommentView) => void;
} {
	const articleOf = needs.articleOf;

	// Place the column's cards level with what they comment on, pushing overlapping ones down, and let the entry
	// grow to hold them.
	function placeCards(view: CommentView) {
		const article = articleOf(view);
		if (view.cards.length === 0) {
			article.style.minHeight = "";
			return;
		}
		const articleTop = article.getBoundingClientRect().top;
		const wanted = view.cards.map(
			(card) => card.anchor.getBoundingClientRect().top - articleTop,
		);
		const heights = view.cards.map((card) => card.node.offsetHeight);
		const tops = stackTops(wanted, heights, CARD_GAP);
		view.cards.forEach((card, i) => {
			card.node.style.top = `${tops[i]}px`;
		});
		const last = tops.length - 1;
		const padding = parseFloat(getComputedStyle(article).paddingBottom);
		// Number() as in stackTops: last is in range, so these are the numbers themselves.
		article.style.minHeight = `${Number(tops[last]) + Number(heights[last]) + padding}px`;
	}

	return { placeCards: placeCards };
}
