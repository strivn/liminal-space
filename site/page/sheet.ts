// What the comment and takeaway panels share as modal dialogs: closing on a press and release outside, and, as a
// sheet on a phone, standing on the on-screen keyboard.
import { el } from "./dom.ts";
import { keyboardInset } from "./phone.ts";

// Whether a point, in px from the window's corner, lies inside a box.
function isInside(box: DOMRect, x: number, y: number): boolean {
	return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
}

// Close `dialog` when a pointer press and its release both land outside its box. A click's target is the dialog both
// for the dimmed page (the backdrop) and for the dialog's own padding, such as a sheet's padding below Save, so the
// target can't tell them apart; the positions can. A press inside that ends outside is a drag, such as a selection.
// One path for every browser: closedby="any" is Chromium's only (no Safari on the iPhone). The press is read on the
// document, before any handler in the page can stop it, and the dialog keeps no pointer listener of its own, which
// only the phone's gestures add.
export function closeOnPressOutside(dialog: HTMLDialogElement): void {
	let pressedOutside = false;
	document.addEventListener(
		"pointerdown",
		(event) => {
			if (!dialog.open) return;
			pressedOutside = !isInside(
				dialog.getBoundingClientRect(),
				event.clientX,
				event.clientY,
			);
		},
		true,
	);
	dialog.addEventListener("click", (event) => {
		const releasedOutside = !isInside(
			dialog.getBoundingClientRect(),
			event.clientX,
			event.clientY,
		);
		if (event.target === dialog && pressedOutside && releasedOutside)
			dialog.close();
		pressedOutside = false;
	});
}

// Start and stop keeping `sheet` above the on-screen keyboard: start when it opens as a sheet, stop when it closes.
export type KeyboardFit = { start: () => void; stop: () => void };

// The keyboard fit of `sheet`: its --keyboard-inset is how far the keyboard reaches up, from the visual viewport,
// which style.css's sheet rules turn into bottom padding.
export function keyboardFit(sheet: HTMLElement): KeyboardFit {
	function fit() {
		const viewport = window.visualViewport;
		if (viewport === null) return;
		const inset = keyboardInset(
			window.innerHeight,
			viewport.height,
			viewport.offsetTop,
		);
		sheet.style.setProperty("--keyboard-inset", `${inset}px`);
	}
	function start() {
		if (window.visualViewport === null) return;
		window.visualViewport.addEventListener("resize", fit);
		window.visualViewport.addEventListener("scroll", fit);
	}
	function stop() {
		if (window.visualViewport !== null) {
			window.visualViewport.removeEventListener("resize", fit);
			window.visualViewport.removeEventListener("scroll", fit);
		}
		sheet.style.removeProperty("--keyboard-inset");
	}
	return { start: start, stop: stop };
}

// A panel's dialog and the parts its board reaches: the body the board draws into, the handle a phone swipes by, and
// the close button.
export type Panel = {
	dialog: HTMLDialogElement;
	body: HTMLElement;
	handle: HTMLElement;
	closeButton: HTMLButtonElement;
	// Mark the dialog a sheet or not, and, if it is closed, start the keyboard fit of a sheet and show it modally.
	open: (asSheet: boolean) => void;
};

// Build the comment panel's dialog, with `extraClass` beside its class, and wire Close, a press outside and the
// keyboard fit; `onClose` runs once the dialog has closed and its body is empty. The caller adds panel.dialog to the page.
export function createPanel(options: {
	titleId: string;
	title: string;
	extraClass?: string;
	onClose: () => void;
}): Panel {
	const body = el("div", { class: "comment-panel__body" });
	const handle = el("div", {
		class: "comment-panel__handle",
		"aria-hidden": "true",
	});
	const closeButton = el(
		"button",
		{ type: "button", class: "comment-panel__close", "aria-label": "Close" },
		"×",
	);
	let dialogClass = "comment-panel";
	if (options.extraClass !== undefined)
		dialogClass = `comment-panel ${options.extraClass}`;
	const dialog = el(
		"dialog",
		{ class: dialogClass, "aria-labelledby": options.titleId },
		el(
			"div",
			{ class: "comment-panel__inner", tabindex: "-1" },
			handle,
			el(
				"div",
				{ class: "comment-panel__head" },
				el("h2", { id: options.titleId }, options.title),
				closeButton,
			),
			body,
		),
	);
	const keyboard = keyboardFit(dialog);
	closeButton.addEventListener("click", () => dialog.close());
	closeOnPressOutside(dialog);
	dialog.addEventListener("close", () => {
		keyboard.stop();
		body.replaceChildren();
		options.onClose();
	});
	function open(asSheet: boolean) {
		dialog.classList.toggle("comment-panel--sheet", asSheet);
		if (dialog.open) return;
		// The sheet stands on the on-screen keyboard.
		if (asSheet) keyboard.start();
		dialog.showModal();
	}
	return {
		dialog: dialog,
		body: body,
		handle: handle,
		closeButton: closeButton,
		open: open,
	};
}
