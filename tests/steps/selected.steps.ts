// The owner's marks on papers that shaped their thinking, their public notes, and the public page's Selected.
import { Then, When } from "./world.ts";

When(
	/^(?:the owner )?marks today's (\d+)(?:st|nd|rd|th) paper as shaping their thinking$/,
	async ({ world, browser }, position: string) => {
		throw new Error(
			`not implemented: ${world.dir} ${browser.version()} ${position}`,
		);
	},
);

When(
	/^(?:the owner )?writes the note "(.*)" on it in Selected$/,
	async ({ world, browser }, note: string) => {
		throw new Error(
			`not implemented: ${world.dir} ${browser.version()} ${note}`,
		);
	},
);

When(
	"a visitor opens the public page the next morning",
	async ({ world, browser }) => {
		throw new Error(`not implemented: ${world.dir} ${browser.version()}`);
	},
);

Then("the public page opens on Selected", async ({ world, browser }) => {
	throw new Error(`not implemented: ${world.dir} ${browser.version()}`);
});

Then(
	/^Selected lists today's (\d+)(?:st|nd|rd|th) paper under its OpenAlex topic, with the note "(.*)"$/,
	async ({ world, browser }, position: string, note: string) => {
		throw new Error(
			`not implemented: ${world.dir} ${browser.version()} ${position} ${note}`,
		);
	},
);
