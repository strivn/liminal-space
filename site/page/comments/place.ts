// The comment column's cards, lined up with what they comment on.

import type { CommentView } from "../comment-board.ts";
import { stackTops } from "../comments.ts";

// Px between comment cards that would overlap.
const CARD_GAP = 8;

// What placing the cards needs from the board.
export type PlacingNeeds = {
	views: () => Iterable<CommentView>;
	articleOf: (view: CommentView) => HTMLElement;
};

// The anchor's top, title unstuck.
function naturalTop(anchor: Element): number {
	const top = anchor.getBoundingClientRect().top;
	const title = anchor.closest(".entry__title");
	const text = title?.parentElement;
	if (!title || !text) return top;
	const titleTop =
		text.getBoundingClientRect().top +
		parseFloat(getComputedStyle(title).marginTop);
	return top - (title.getBoundingClientRect().top - titleTop);
}

export function createPlacing(needs: PlacingNeeds): {
	placeAll: () => void;
} {
	const views = needs.views;
	const articleOf = needs.articleOf;
	// Re-place when a card resizes.
	const watched = new Set<Element>();
	const resizes = new ResizeObserver(() => placeAll());

	function watch(cards: Element[]) {
		for (const node of watched) {
			if (node.isConnected) continue;
			resizes.unobserve(node);
			watched.delete(node);
		}
		for (const node of cards) {
			if (watched.has(node)) continue;
			resizes.observe(node);
			watched.add(node);
		}
	}

	// Stack column cards in page order.
	function placeAll() {
		const shown: CommentView[] = [];
		for (const view of views()) {
			const hidden = articleOf(view).closest("[hidden], details:not([open])");
			if (view.cards.length > 0 && hidden === null) shown.push(view);
		}
		shown.sort((a, b) =>
			articleOf(a).compareDocumentPosition(articleOf(b)) &
			Node.DOCUMENT_POSITION_FOLLOWING
				? -1
				: 1,
		);
		// Last card's bottom, page coordinates.
		let floor = Number.NEGATIVE_INFINITY;
		const all: Element[] = [];
		for (const view of shown) {
			const articleTop = articleOf(view).getBoundingClientRect().top;
			const wanted = view.cards.map(
				(card) => naturalTop(card.anchor) - articleTop,
			);
			const heights = view.cards.map((card) => card.node.offsetHeight);
			const pageTop = articleTop + window.scrollY;
			const tops = stackTops(
				wanted,
				heights,
				CARD_GAP,
				floor + CARD_GAP - pageTop,
			);
			view.cards.forEach((card, i) => {
				card.node.style.top = `${tops[i]}px`;
				all.push(card.node);
			});
			const last = tops.length - 1;
			floor = pageTop + Number(tops[last]) + Number(heights[last]);
		}
		watch(all);
	}

	return { placeAll: placeAll };
}
