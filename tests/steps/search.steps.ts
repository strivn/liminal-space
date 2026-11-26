// The Search sentence in the Feed's sidebar: the subject, kind, venue, time and read blanks, and what the Feed shows.
import { Given, Then, When } from "./world.ts";

Given(
	/^(\d+) of today's papers have the OpenAlex topic "(.*)"$/,
	async ({ world }, count: string, topic: string) => {
		throw new Error(`not implemented: ${world.dir} ${count} ${topic}`);
	},
);

Given(
	/^today's (\d+)(?:st|nd|rd|th) paper has the OpenAlex keyword "(.*)"$/,
	async ({ world }, position: string, keyword: string) => {
		throw new Error(`not implemented: ${world.dir} ${position} ${keyword}`);
	},
);

Given(
	/^today's (\d+)(?:st|nd|rd|th) paper's venue is "(.*)" and its (\d+)(?:st|nd|rd|th) paper's is "(.*)"$/,
	async (
		{ world },
		first: string,
		venue: string,
		second: string,
		other: string,
	) => {
		throw new Error(
			`not implemented: ${world.dir} ${first} ${venue} ${second} ${other}`,
		);
	},
);

When("a visitor opens the public page", async ({ world, browser }) => {
	throw new Error(`not implemented: ${world.dir} ${browser.version()}`);
});

When(
	/^picks "(.*)" as the (subject|kind|venue) in Search$/,
	async ({ world, browser }, choice: string, blank: string) => {
		throw new Error(
			`not implemented: ${world.dir} ${browser.version()} ${choice} ${blank}`,
		);
	},
);

When(
	/^picks "(.*)" and "(.*)" in Search$/,
	async ({ world, browser }, time: string, read: string) => {
		throw new Error(
			`not implemented: ${world.dir} ${browser.version()} ${time} ${read}`,
		);
	},
);

When(
	/^clicks the keyword "(.*)" under today's (\d+)(?:st|nd|rd|th) paper$/,
	async ({ world, browser }, keyword: string, position: string) => {
		throw new Error(
			`not implemented: ${world.dir} ${browser.version()} ${keyword} ${position}`,
		);
	},
);

Then(/^Search reads "(.*)"$/, async ({ world, browser }, words: string) => {
	throw new Error(
		`not implemented: ${world.dir} ${browser.version()} ${words}`,
	);
});

Then(
	/^the Feed shows those (\d+) papers and nothing else$/,
	async ({ world, browser }, count: string) => {
		throw new Error(
			`not implemented: ${world.dir} ${browser.version()} ${count}`,
		);
	},
);

Then(
	/^the Feed shows today's (\d+)(?:st|nd|rd|th)(?: and (\d+)(?:st|nd|rd|th))? papers? and nothing else$/,
	async ({ world, browser }, first: string, second: string | undefined) => {
		throw new Error(
			`not implemented: ${world.dir} ${browser.version()} ${first} ${second}`,
		);
	},
);

Then(
	/^the Feed shows (\d+) papers, every one unread$/,
	async ({ world, browser }, count: string) => {
		throw new Error(
			`not implemented: ${world.dir} ${browser.version()} ${count}`,
		);
	},
);
