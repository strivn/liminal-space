// The days a scenario starts from: their papers and the owner's read marks on them.
import {
	dateOf,
	Given,
	nthPaper,
	type Paper,
	paperByDoi,
	paperOn,
	type World,
} from "./world.ts";

// Each day's papers get their own block of ids: yesterday 1, today 2, the day 2 months ago 3.
const ID_BLOCKS: Record<string, number> = {
	yesterday: 1,
	today: 2,
	"the day 2 months ago": 3,
};

Given(
	/^(yesterday|today|a day 2 months ago) has (\d+) papers$/,
	({ world }, named: string, count: string) => {
		const day = named.replace(/^a day/, "the day");
		const date = dateOf(world, day);
		const idBlock = ID_BLOCKS[day] ?? 0;
		const papers = Array.from({ length: Number(count) }, (_, i) =>
			paperOn(date, idBlock, i + 1),
		);
		world.days.set(date, papers);
	},
);

const TODAY_BLOCK = ID_BLOCKS.today ?? 0;

// Today's `n`th paper (from 1) replaced by `paper`.
function replaceTodays(world: World, n: number, paper: Paper) {
	const papers = world.days.get(world.today) ?? [];
	papers[n - 1] = paper;
}

Given(
	/^today's (\d+)(?:st|nd|rd|th) paper is on arXiv and accepted at NeurIPS (\d+), whose proceedings aren't out yet$/,
	({ world }, position: string, year: string) => {
		const paper = nthPaper(world, world.today, Number(position));
		paper.venue = `NeurIPS ${year}`;
		paper.venue_source = "https://neurips.cc/static/virtual/data/accepted.json";
	},
);

Given(
	/^today's (\d+)(?:st|nd|rd|th) paper is on arXiv and has a published version in NeurIPS's proceedings$/,
	({ world }, position: string) => {
		const paper = nthPaper(world, world.today, Number(position));
		paper.camera_ready = {
			url: `https://proceedings.neurips.cc/paper_files/paper/2026/hash/${position}-Abstract.html`,
			venue: "NeurIPS 2026",
			from: "https://proceedings.neurips.cc/paper_files/paper/2026",
			doi: `10.5555/${position}0001`,
		};
	},
);

Given(
	/^today's (\d+)(?:st|nd|rd|th) and (\d+)(?:st|nd|rd|th) papers come from the ACL Anthology and PoPETs, with no arXiv id$/,
	({ world }, acl: string, popets: string) => {
		replaceTodays(
			world,
			Number(acl),
			paperByDoi(world.today, TODAY_BLOCK, Number(acl), {
				id: "doi:10.18653/v1/2026.acl-long.1",
				source: "ACL Anthology",
				venue: "ACL 2026",
				url: "https://aclanthology.org/2026.acl-long.1/",
			}),
		);
		replaceTodays(
			world,
			Number(popets),
			paperByDoi(world.today, TODAY_BLOCK, Number(popets), {
				id: "doi:10.56553/popets-2026-0002",
				source: "PoPETs",
				venue: "PETS 2026",
				url: "https://petsymposium.org/popets/2026/popets-2026-0002.php",
			}),
		);
	},
);

Given(
	/^today's (\d+)(?:st|nd|rd|th) paper is a journal paper known only by its DOI$/,
	({ world }, position: string) => {
		replaceTodays(
			world,
			Number(position),
			paperByDoi(world.today, TODAY_BLOCK, Number(position), {
				id: "doi:10.1016/j.artint.2026.104001",
				source: "Artificial Intelligence",
				url: "https://doi.org/10.1016/j.artint.2026.104001",
			}),
		);
	},
);

// Read marks go on today's papers from the end of the list, the 15th first, so the papers steps act on stay unread.
Given(
	/^(\d+) of today's papers (?:are|is) read to the (Abstract|Paper)$/,
	({ world }, count: string, depth: string) => {
		const papers = world.days.get(world.today) ?? [];
		const taken = world.pendingReads.length;
		const chosen = papers.slice(
			papers.length - taken - Number(count),
			papers.length - taken,
		);
		for (const paper of chosen) {
			world.pendingReads.push({
				id: paper.id,
				depth: depth === "Abstract" ? "abstract" : "paper",
				date: world.today,
			});
		}
	},
);
