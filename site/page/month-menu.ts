// The month selector: Salience's dropdown, a button plus a listbox the page draws, so the open list never comes from
// the operating system. The button keeps focus while the list is open; aria-activedescendant names the marked
// option. Keys follow the listbox pattern: Enter, Space or an arrow opens it, arrows move, Enter picks, Escape closes.
import { el } from "./dom.ts";

// A month to choose: "2026-10" and "October 2026".
export type MonthOption = { value: string; label: string };

// What the page needs: the box to place, and a way to show a month chosen elsewhere (null for All months).
export type MonthMenu = {
	root: HTMLElement;
	setValue: (value: string | null) => void;
};

// The text the selector shows while All months is on.
const ALL_MONTHS = "All months";

export function monthMenu(
	months: MonthOption[],
	selected: string | null,
	onPick: (value: string) => void,
): MonthMenu {
	const label = el(
		"span",
		{ id: "month-label", class: "visually-hidden" },
		"Month",
	);
	// A select-only combobox (WAI-ARIA APG): the role that lets the button name its marked option with
	// aria-activedescendant while it keeps focus.
	const button = el("button", {
		type: "button",
		id: "month-button",
		role: "combobox",
		class: "select",
		"aria-haspopup": "listbox",
		"aria-expanded": "false",
		"aria-controls": "month-list",
		"aria-labelledby": "month-label month-button",
	});
	const list = el("ul", {
		id: "month-list",
		class: "menu",
		role: "listbox",
		"aria-labelledby": "month-label",
		hidden: "",
	});
	const options = months.map((month) =>
		el(
			"li",
			{
				id: `month-option-${month.value}`,
				class: "menu__option",
				role: "option",
				"data-value": month.value,
				"aria-selected": "false",
			},
			month.label,
		),
	);
	list.append(...options);
	const root = el(
		"div",
		{ class: "dropdown month-select" },
		label,
		button,
		list,
	);
	let active = -1;

	// Show `value` in the button and tick its option; null shows All months with nothing ticked.
	function setValue(value: string | null) {
		button.dataset.value = value || "";
		button.textContent = ALL_MONTHS;
		for (const option of options) {
			const isIt = option.dataset.value === value;
			option.setAttribute("aria-selected", String(isIt));
			if (isIt) button.textContent = option.textContent;
		}
	}

	// Mark the option at `index`, wrapping round the list.
	function mark(index: number) {
		active = (index + options.length) % options.length;
		for (const [at, option] of options.entries())
			option.classList.toggle("is-active", at === active);
		const marked = options[active];
		if (marked !== undefined) {
			button.setAttribute("aria-activedescendant", marked.id);
			marked.scrollIntoView({ block: "nearest" });
		}
	}

	// Open the list with the ticked month marked (the first when none is), or close it.
	function open(on: boolean) {
		list.hidden = !on;
		button.setAttribute("aria-expanded", String(on));
		if (!on) {
			button.removeAttribute("aria-activedescendant");
			return;
		}
		const ticked = options.findIndex(
			(option) => option.getAttribute("aria-selected") === "true",
		);
		mark(Math.max(ticked, 0));
	}

	// Pick an option: show it, close the list, hand focus back to the button and tell the page.
	function pick(option: HTMLElement | undefined) {
		if (option === undefined) return;
		const value = option.dataset.value || "";
		setValue(value);
		open(false);
		button.focus();
		onPick(value);
	}

	button.addEventListener("click", () => {
		open(list.hasAttribute("hidden"));
	});
	button.addEventListener("keydown", (event) => {
		let step = 0;
		if (event.key === "ArrowDown") step = 1;
		if (event.key === "ArrowUp") step = -1;
		if (step !== 0) {
			event.preventDefault();
			if (list.hidden) open(true);
			else mark(active + step);
		} else if (event.key === "Enter" || event.key === " ") {
			if (list.hidden) return;
			event.preventDefault();
			pick(options[active]);
		} else if (event.key === "Escape" && !list.hidden) {
			event.preventDefault();
			open(false);
		}
	});
	for (const option of options)
		option.addEventListener("click", () => {
			pick(option);
		});
	// A click anywhere outside the selector closes the list.
	document.addEventListener("click", (event) => {
		if (event.target instanceof Node && !root.contains(event.target))
			open(false);
	});

	setValue(selected);
	return { root: root, setValue: setValue };
}
