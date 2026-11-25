# 📖 Liminal space

<p>
  <img src="docs/screenshot.png" width="76%" alt="The Liminal space page: the reading heatmap and the day's papers in the sidebar; The Geometry of Truth with its abstract, Figure 1, a highlighted passage, and a question to @Claude with Claude's reply">
  <img src="docs/screenshot-phone.png" width="22%" alt="The same paper on a phone: the comments open in a sheet, with the @Claude thread, under the highlighted passage">
</p>

Liminal space is a personal research feed. Every morning an AI agent, the scout, searches arXiv, this year's conference acceptance lists and the news for a short list of topics, and adds what it picks to a web page. The owner reads the page in a browser or on a phone, marks it up, and asks Claude about any entry. Claude then reads the paper's full text and discusses it.

The page has two views. Feed holds the days' entries. Selected holds the papers the owner marked as having shaped their thinking, grouped by their main OpenAlex topic, each with the owner's note. The public page opens on Selected and the owner's copy on Feed.

A day's digest holds:

- at least ten papers on the interested topics,
- one "surprise" paper from outside AI that a science outlet such as Quanta Magazine or Nature wrote about,
- two or three news stories, articles or reports that the scout picks,
- every new post from the blogs and feeds listed in [`feeds.json`](feeds.json).

The topics, search phrases and conferences are in [`interests.md`](interests.md), which a person edits by hand.

The feed is built for one reader. Anyone can read it at [ivan.wiryadi.com/liminal-space](https://ivan.wiryadi.com/liminal-space/).

## Why

This is an attempt to gamify my own reading, that I should at least make a habit of reading up some papers abstract and be aware of current research. 

It is also a side project for building software with agents and models: an agent picks the papers, a second model scores the candidates, and agents wrote the code under a person's direction ([How it was built](#how-it-was-built)).

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/how-it-works-dark.svg">
  <img alt="How Liminal space works: every morning the scout reads your interests and conference lists, searches arXiv and news, and adds entries to the site; you read the page, mark it up, and ask Claude about an item." src="docs/how-it-works-light.svg">
</picture>

## Architecture

The site runs on the free plans of two services. GitHub Actions for the daily search and the builds. Cloudflare serves the page and keeps the data.

The two diagrams show the same parts. The first follows an entry into the site, and the second follows a reader.

![How entries get in: a Worker cron starts scout.yml on GitHub Actions, which pulls the entries from D1 through Cloudflare's API, searches the sources, lets a scoring model and a Claude session choose, and pushes the new entries to the Worker; deploy.yml then builds the static page and uploads it with the Worker.](docs/architecture-sync.svg)

![How the site is used: a reader loads the static page and saves marks, tags and comments through the Worker's reader API; a Claude app reaches the Worker's connector; the Worker reads and writes D1, asks Anthropic for replies and sends notifications.](docs/architecture-web.svg)

## Why Cloudflare and GitHub Actions

So it's free. 

## How it was built

Claude Code.

## Development

You need Node.js 26 (`.nvmrc`) and pnpm 12. To see the page with the public site's entries, install the dependencies:

```bash
pnpm install --frozen-lockfile
```

Then copy the public site's entries and start the preview:

```bash
node scripts/deploy/sync.ts pull site/digests.js && pnpm run preview
```

The page is then at `http://localhost:8787/liminal-space/`. [`CLAUDE.md`](CLAUDE.md) has the commands, the layout of the code, the tests and the branches. Each commit runs Biome, shellcheck and gitleaks through [pre-commit](https://pre-commit.com), and a type check when TypeScript changes. Run `pre-commit install` once per clone.

The code is written for one site, so a copy needs its addresses changed before it runs. Issues are welcome. Bug fixes are likely to be merged, but pull requests that change what the tool does are not.

MIT licence ([`LICENSE`](LICENSE)).
