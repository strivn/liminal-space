// The days a scenario starts from: their papers and the owner's read marks on them.
import { dateOf, Given, paperOn } from "./world.ts";

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
