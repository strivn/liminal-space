// Read the data and draw the whole page.

import { isDay } from "../../shared/entry-checks.ts";
import {
	INDEX_PATH,
	type IndexDay,
	SEARCH_PATH,
	type SearchEntry,
	type SiteIndex,
} from "../../shared/site-data-shape.ts";
import { checkDigests } from "./check.ts";
import { createCommentBoard } from "./comment-board.ts";
import { hashIds, renderContents, trackCurrent } from "./contents.ts";
import {
	createMonthLoader,
	fetchJson,
	isOwnerPage,
	type MonthLoader,
	readIndex,
	readSearchFile,
	searchEntriesOf,
	siteFile,
} from "./data.ts";
import { dayLabel, headerDay, jakartaToday, mergeDays } from "./days.ts";
import { el, startStatusRegion, status } from "./dom.ts";
import {
	drawHeatmap,
	drawHeatStrip,
	type EntryControls,
	hideCaptionOnEscape,
	renderEntry,
	type Typesetting,
} from "./entry.ts";
import { createFeedFilter } from "./feed-filter.ts";
import { createFeedbackBoard } from "./feedback-board.ts";
import { refreshIcon } from "./icons.ts";
import { createMonths, skippedWarning } from "./months.ts";
import { notificationButton, showBadge, unreadToday } from "./notifications.ts";
import {
	createSender,
	createStateRefresh,
	loadOwnerState,
	notice as ownerNotice,
	refreshOnReturn,
	SIGNED_IN_AGAIN,
	signInAgainOnce,
} from "./owner.ts";
import { heatmapData, type PageModel } from "./page-model.ts";
import { createPermalinks } from "./permalinks.ts";
import { PHONE_QUERY, startPhoneGestures } from "./phone.ts";
import { drawBarProgress, drawProgress } from "./progress.ts";
import { createReadBoard } from "./read-board.ts";
import {
	refreshKeepingPlace,
	restoreReadingPlace,
	startSavingPlace,
} from "./reading-place.ts";
import { showScoutLogs } from "./scout-logs.ts";
import { createSearch, type Search } from "./search.ts";
import type { View } from "./selected.ts";
import { fetchMarkedPapers, ownerMarkedPapers } from "./selected-data.ts";
import {
	createSelectedView,
	type MarkedPaper,
	markKicker,
	type NoteSaver,
} from "./selected-view.ts";
import { createShelf } from "./shelf.ts";
import { createStandoutBoard } from "./standout-board.ts";
import { startStudy } from "./study.ts";
import { createTagBoard } from "./tag-board.ts";
import { createTakeawayBoard } from "./takeaway-board.ts";
import { contentsGroups } from "./text.ts";
import type { Day, OwnerData, ReadState, Skipped } from "./types.ts";
import { createViews } from "./views.ts";

// A page with no contents to list keeps one centred column: index.html draws the sidebar layout from the first frame,
// and this takes it away.
function narrowPage() {
	const page = document.getElementById("page");
	if (page === null) throw new Error("index.html has no #page");
	page.classList.remove("page--with-contents");
}

// Each studied entry's id and its words file, as the index names them.
function wordsFilesOf(index: SiteIndex): Map<string, string> {
	const files = new Map<string, string>();
	for (const day of index.days) {
		for (const entry of day.entries) {
			if (entry.study !== undefined) files.set(entry.id, entry.study);
		}
	}
	return files;
}

// A file of the site's own as JSON; throws when it doesn't answer 200.
async function readSiteFile(path: string): Promise<unknown> {
	const answer = await fetchJson(path);
	if (answer.status !== 200)
		throw new Error(`${path} answered ${answer.status}`);
	return answer.json;
}

// Read the index, then the newest month's file, and draw the page. Either failing says "Couldn't load digests".
export async function start() {
	// index.html has it.
	const main = document.getElementById("digests");
	if (main === null) throw new Error("index.html has no #digests");
	const failed = () => {
		narrowPage();
		main.append(status("danger", "Couldn't load digests"));
	};

	// The status region goes in first, empty, so a screen reader hears every message written into it later.
	startStatusRegion();
	// aria-busy (set in index.html) says the page is still drawing; it goes once the page is drawn or has said why
	// not, for screen readers and for tests that wait for the drawn page.
	try {
		await drawFromData(main, failed);
	} finally {
		main.removeAttribute("aria-busy");
	}
}

// Read the index and the newest month, then draw; `failed` shows "Couldn't load digests". The owner's page reads its
// saved state alongside and draws with it; when the state can't be read it draws the public page and says so.
async function drawFromData(main: HTMLElement, failed: () => void) {
	let ownerLoad: Promise<OwnerData | "refused" | null> = Promise.resolve(null);
	// The public page's marked papers load alongside the index; the owner's come from their saved state.
	let markedLoad: Promise<MarkedPaper[]> = Promise.resolve([]);
	if (isOwnerPage()) ownerLoad = loadOwnerState();
	else markedLoad = fetchMarkedPapers();
	// The search file loads beside the index.
	const searchLoad = fetchJson(siteFile(SEARCH_PATH));
	const answer = await fetchJson(siteFile(INDEX_PATH));
	let index: SiteIndex | null = null;
	if (answer.status === 200) index = readIndex(answer.json);
	if (index === null) {
		failed();
		return;
	}
	// Fall back to the index's entries.
	const searchAnswer = await searchLoad;
	let searchEntries =
		searchAnswer.status === 200 ? readSearchFile(searchAnswer.json) : null;
	if (searchEntries === null) {
		console.warn(`${SEARCH_PATH} couldn't be read`);
		searchEntries = { entries: searchEntriesOf(index) };
	}
	// Only days with a real date are drawn; the newest of them names the month loaded first.
	const days = index.days.filter((day) => isDay(day.date));
	const loadMonth = createMonthLoader(index);
	const newestDay = days[0];
	let lines: unknown[] = [];
	let olderMonthDays: IndexDay[] = [];
	if (newestDay !== undefined) {
		try {
			lines = await loadMonth(newestDay.month);
		} catch (error) {
			console.error("Newest month not loaded:", error);
			failed();
			return;
		}
		olderMonthDays = days.filter((day) => day.month !== newestDay.month);
	}
	const ownerAnswer = await ownerLoad;
	if (ownerAnswer === "refused" && signInAgainOnce(sessionStorage, location))
		return;
	const owner = ownerAnswer === "refused" ? null : ownerAnswer;
	// Let a later refusal retry.
	if (owner !== null) {
		try {
			sessionStorage.removeItem(SIGNED_IN_AGAIN);
		} catch {
			// No storage, nothing to clear.
		}
	}
	render(
		main,
		lines,
		olderMonthDays,
		loadMonth,
		owner,
		{
			index: index,
			papers: await markedLoad,
		},
		wordsFilesOf(index),
		searchEntries.entries,
	);
	if (isOwnerPage() && owner === null) {
		const header = document.getElementById("freshness");
		if (header === null) throw new Error("index.html has no #freshness");
		header.append(status("warning", "Couldn't load your reading state"));
	}
}

// Draw the page: the newest month's `lines` as days (today open, the rest folded with their entries), then the days
// of older months from the index as folded rows whose entries are drawn when their month loads. With `owner` (the
// owner's page, its saved state) each entry gets its icon rail and comments, and the sidebar its heatmap; without
// (the public page) the page shows entries only. `marked` is the index and the public page's marked papers.
// `searchEntries` is what the Search sentence matches.
function render(
	main: HTMLElement,
	lines: unknown[],
	olderMonthDays: IndexDay[],
	loadMonth: MonthLoader,
	owner: OwnerData | null,
	marked: { index: SiteIndex; papers: MarkedPaper[] },
	wordsFiles: ReadonlyMap<string, string>,
	searchEntries: SearchEntry[],
) {
	// index.html has it.
	const header = document.getElementById("freshness");
	if (header === null) throw new Error("index.html has no #freshness");
	// The public page has no heatmap.
	const heatmap = document.getElementById("heatmap");
	if (owner === null && heatmap !== null) heatmap.remove();

	// Draw only what can be drawn, so every count, the contents and the heatmap agree with the page. What was left out
	// is named in the header, under the freshness line; an older month adds to it when it loads.
	const checked = checkDigests(lines);
	const skipped: Skipped[] = checked.skipped;
	let warning: HTMLElement | null = null;
	if (skipped.length) warning = skippedWarning(skipped);
	const days = mergeDays(checked.lines);
	const newest = days[0];
	if (newest === undefined) {
		if (warning) header.append(warning);
		narrowPage();
		main.append(el("p", { class: "empty" }, "No digests yet"));
		return;
	}

	const today = jakartaToday(new Date());
	const named = headerDay(days, today);
	// headerDay is null only for no days, which returned above.
	if (named === null) throw new Error("No header day for a page with days");
	header.append(named.day);
	if (named.warning !== null) header.append(status("warning", named.warning));
	// The owner's page fills this line by the newest digest's papers read (redraw below).
	let progressLine: HTMLElement | null = null;
	if (owner !== null) {
		progressLine = el("div", { class: "progress" });
		header.append(progressLine);
		// Under the progress line, for a browser that can take notifications and hasn't been asked.
		const turnOnNotifications = notificationButton();
		if (turnOnNotifications !== null) header.append(turnOnNotifications);
	}
	if (warning) header.append(warning);

	// The newest day is open; the older days, the month in view and the header's warning are shared with the pieces below.
	const model: PageModel = {
		newest: newest,
		newestSection: el(
			"section",
			{ class: "day", "data-date": newest.date },
			el("h2", null, dayLabel(newest.date)),
		),
		newestDate: newest.date,
		today: today,
		olderPairs: [],
		header: header,
		skipped: skipped,
		warning: warning,
	};

	// One read state for the whole page: every entry's toggles change it, and the toggles and the heatmap are drawn
	// from it. `toggleViews` holds each entry's toggle redraw. The public page has no saved state: it draws from
	// nothing and sends nothing.
	let saved: OwnerData = {
		read: Object.create(null),
		tags: Object.create(null),
		comments: Object.create(null),
		feedback: Object.create(null),
		takeaways: Object.create(null),
		standouts: Object.create(null),
	};
	if (owner !== null) saved = owner;
	const readState: ReadState = saved.read;
	const toggleViews: (() => void)[] = [];
	const sender = createSender();
	let notice = (text: string) => console.warn(text);
	if (owner !== null) notice = ownerNotice;
	// refreshState is declared below; the board calls it only once Claude has answered.
	const board = createCommentBoard(saved.comments, sender, notice, () =>
		refreshState(),
	);
	// Made once the contents exist.
	let search: Search | null = null;
	const tagBoard = createTagBoard(saved.tags, sender, notice, () =>
		search?.refresh(),
	);
	const feedbackBoard = createFeedbackBoard(saved.feedback, sender, notice);
	const takeawayBoard = createTakeawayBoard(saved.takeaways, sender);
	const standoutBoard = createStandoutBoard(saved.standouts, sender, notice);
	const redraw = () => {
		for (const showPressed of toggleViews) showPressed();
		search?.refresh();
		if (owner !== null) {
			if (progressLine !== null)
				drawProgress(progressLine, newest.entries, readState);
			// index.html has the phone bar's line.
			const barLine = document.querySelector<HTMLElement>(
				".phone-bar__progress",
			);
			if (barLine === null) throw new Error("index.html has no bar line");
			drawBarProgress(barLine, newest.entries, readState);
			const days = heatmapData(model);
			drawHeatmap(heatmap, days, readState, today, openHeatmapDay);
			drawHeatStrip(
				document.getElementById("heat-strip"),
				days,
				readState,
				today,
				openHeatmapDay,
			);
			drawShelf();
		}
		// The icon's badge: today's papers not yet read, from the days the page drew.
		if (owner !== null) {
			showBadge(unreadToday(days, readState, today)).catch((error) =>
				console.error("The app badge failed:", error),
			);
		}
	};
	if (owner !== null) hideCaptionOnEscape(heatmap);

	// After a read press: pressing "Paper" on a paper also clears its "To read"; unpressing "Paper" doesn't bring it
	// back. Only papers have read toggles, so every press here is a paper's.
	const readBoard = createReadBoard(
		readState,
		sender,
		notice,
		(id) => {
			const mark = readState[id];
			if (mark && mark.depth === "paper") tagBoard.clear(id, "toRead");
			redraw();
		},
		redraw,
	);
	// The owner's page gives each entry its icon rail and comments; the public page none.
	let controls: EntryControls | null = null;
	if (owner !== null) {
		controls = {
			readState: readState,
			onReadChange: (entry, depth) => readBoard.press(entry.id, depth),
			toggleViews: toggleViews,
			board: board,
			tagBoard: tagBoard,
			feedbackBoard: feedbackBoard,
			standoutBoard: standoutBoard,
			takeawayBoard: takeawayBoard,
		};
	}
	// A day's entries in the contents' order, papers first, so the page reads in the same order as the contents.
	const publicMarks = new Set(marked.papers.map((paper) => paper.entry.id));
	// Ad hoc ids among entries drawn.
	const adHocIds = new Set<string>();
	const dayEntries = (day: Day, typesetting: Typesetting) =>
		contentsGroups(day.entries)
			.flatMap((group) => group.entries)
			.map((entry) => {
				if (entry.ad_hoc === true) adHocIds.add(entry.id);
				const article = renderEntry(entry, controls, typesetting);
				if (owner === null && publicMarks.has(entry.id)) markKicker(article);
				return article;
			});
	// tracker and feedFilter come later.
	const { drawDays, fillMonth, showDayError, loadMonths } = createMonths(
		model,
		{
			loadMonth: loadMonth,
			dayEntries: dayEntries,
			drawComments: (details) => board.drawIn(details),
			collectContents: () => tracker.collect(),
			redraw: redraw,
			refilter: () => feedFilter.refresh(),
		},
	);

	drawDays(main, days, olderMonthDays);

	// redraw draws the shelf; the page's last step calls redraw, after every older day is in place.
	const { drawShelf } = createShelf(model, {
		olderMonthDays: olderMonthDays,
		readState: readState,
		loadMonth: loadMonth,
		fillMonth: fillMonth,
	});

	// Comments are drawn once the entries are in the page, where their lines can be measured, and before a permalink
	// scrolls to an entry whose cards may make it taller. If drawing them fails, the page says so and the contents,
	// permalinks and arrow keys below still work.
	if (owner !== null) {
		try {
			board.start();
		} catch (error) {
			console.error("Comments not shown:", error);
			header.append(status("danger", "Couldn't show comments"));
		}
	}

	// Take the site's state as the page's own and redraw; a change still on its way to the site keeps what the page
	// shows for its entry.
	function applyState(fresh: OwnerData) {
		readBoard.replace(fresh.read);
		tagBoard.replace(fresh.tags);
		feedbackBoard.replace(fresh.feedback);
		takeawayBoard.replace(fresh.takeaways);
		standoutBoard.replace(fresh.standouts);
		board.replace(fresh.comments);
		redraw();
	}
	const refreshState = createStateRefresh(sender, applyState);

	// Selected is drawn each time it shows, and again when a mark or a note the site refused is undone while it shows.
	// The Feed's own listeners (the contents, the permalinks) come after the menu's, so a link to an entry finds the
	// Feed showing; the Feed measures itself again when it comes back.
	const selectedRoot = document.getElementById("selected-view");
	if (selectedRoot === null)
		throw new Error("index.html has no #selected-view");
	let saveNote: NoteSaver | null = null;
	if (owner !== null) saveNote = standoutBoard.setNote;
	const selectedView = createSelectedView(selectedRoot, saveNote);
	const reportSelected = (error: unknown) =>
		console.error("Selected not drawn:", error);
	let drawing = 0;
	async function drawSelected() {
		const drawn = ++drawing;
		let papers = marked.papers;
		if (owner !== null)
			papers = await ownerMarkedPapers(
				standoutBoard.marks(),
				marked.index,
				loadMonth,
			);
		if (drawn === drawing) selectedView.draw(papers);
	}
	// After the filter: mark, place comments.
	const afterFilter = () => {
		tracker.update();
		board.placeAll();
	};
	let shownView: View = "feed";
	standoutBoard.onChange(() => {
		if (shownView === "selected") drawSelected().catch(reportSelected);
	});
	// Logs is read once, the first time it shows.
	let logsDrawn = false;
	const views = createViews(owner !== null, (view) => {
		shownView = view;
		if (view === "selected") drawSelected().catch(reportSelected);
		else if (view === "feed") afterFilter();
		else if (!logsDrawn) {
			logsDrawn = true;
			const logsRoot = document.getElementById("logs-view");
			if (logsRoot === null) throw new Error("index.html has no #logs-view");
			showScoutLogs(logsRoot).catch((error) =>
				console.error("The scout logs failed:", error),
			);
		}
	});

	const contents = renderContents(newest, model.olderPairs);
	const tracker = trackCurrent(contents);
	// index.html has the bar.
	const phoneBar = document.querySelector<HTMLElement>(".phone-bar");
	if (phoneBar === null) throw new Error("index.html has no .phone-bar");
	startPhoneGestures({
		main: main,
		bar: phoneBar,
		contents: contents,
		sheet: board.sheet,
		sheetHandle: board.sheetHandle,
		dismissSheet: board.dismissSheet,
	});

	// The Search sentence.
	const searchRoot = document.getElementById("search");
	if (searchRoot === null) throw new Error("index.html has no #search");
	let shownNow: ReadonlySet<string> = new Set();
	const feedFilter = createFeedFilter(
		{
			main: main,
			newest: newest,
			newestSection: model.newestSection,
			older: model.olderPairs,
			contents: contents,
			onFilter: () => afterFilter(),
		},
		() => search?.reset(),
	);
	search = createSearch(searchRoot, model.newestDate, {
		entries: () => searchEntries,
		marksOf:
			owner === null
				? null
				: (id) => ({
						// Old depth "read" counts as abstract.
						read:
							readState[id] === undefined
								? "unread"
								: readState[id].depth === "paper"
									? "paper"
									: "abstract",
						tags: tagBoard.labelsOf(id),
						adHoc: adHocIds.has(id),
					}),
		loadMonths: loadMonths,
		onChange: (shown, narrowed) => {
			shownNow = shown;
			feedFilter.show(shown, narrowed);
		},
	});

	// Bring the sentence to the day's month.
	async function openHeatmapDay(date: string) {
		const dayShown = searchEntries.some(
			(entry) => entry.date === date && shownNow.has(entry.id),
		);
		if (!dayShown) search?.showDay(date);
		const pair = model.olderPairs.find((older) => older.day.date === date);
		if (pair !== undefined) {
			pair.details.open = true;
			pair.details.scrollIntoView({ block: "start" });
		} else if (date === model.newestDate)
			model.newestSection.scrollIntoView({ block: "start" });
	}

	createPermalinks(model, {
		loadMonth: loadMonth,
		isShown: (id) => shownNow.has(id),
		showDay: (date) => search?.showDay(date),
		fillMonth: fillMonth,
		showDayError: showDayError,
	}).start();
	if (owner !== null) refreshOnReturn(refreshState);
	views.showOpening();
	startStudy(main, wordsFiles, readSiteFile);
	// Last, so the contents, permalinks and arrow keys work even if drawing the heatmap fails.
	redraw();
	// The reading place: restored, then kept; entries begin at the phone bar's bottom edge, else at the window's top.
	const barBottom = () => {
		if (!window.matchMedia(PHONE_QUERY).matches) return 0;
		return (
			Number.parseFloat(getComputedStyle(phoneBar).top) + phoneBar.offsetHeight
		);
	};
	restoreReadingPlace(barBottom(), hashIds().length > 0, Date.now());
	const keepPlace = startSavingPlace(main, barBottom);
	// Refresh reloads the page and keeps the reading place.
	const refresh = phoneBar.querySelector<HTMLElement>(".phone-bar__refresh");
	if (refresh === null) throw new Error("index.html has no Refresh button");
	refresh.append(refreshIcon());
	refresh.addEventListener("click", () => refreshKeepingPlace(keepPlace));
}
