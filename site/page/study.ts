// Word tooltips on Chinese entries, for a mouse only.

// The pointer the tooltips need.
export const HOVER_QUERY = "(hover: hover) and (pointer: fine)";

// Open a word's tooltip when the pointer rests on it in a studied entry under root, without changing the entry's
// text: the word under the pointer is found by its offset and shown with a CSS highlight. wordsFiles maps an entry's id
// to its words file, as data/index.json names it; fetchJson reads a file of the site's own.
export function startStudy(
	_root: HTMLElement,
	_wordsFiles: ReadonlyMap<string, string>,
	_fetchJson: (path: string) => Promise<unknown>,
): void {
	throw new Error("not implemented");
}
