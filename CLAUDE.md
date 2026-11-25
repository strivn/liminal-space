# CLAUDE.md

This file guides coding agents and people working in this repository. `AGENTS.md` is a symlink to it.

## What this is

Liminal space is a personal research feed for one reader, served at ivan.wiryadi.com/liminal-space/. Each morning
a Claude Agent SDK session, the scout, finds papers, news and reports and appends them to `site/digests.js` through
the scripts in `scripts/`. Its instructions are `scripts/scout/scout.md`, not this file. The scripts copy every entry's
metadata from arXiv and publishers' pages; nothing is typed by hand. A Cloudflare Worker stores the entries in D1,
and a static page draws them. The owner's copy of the page, behind Cloudflare Access, also saves read marks, tags,
likes, comments, highlights and takeaways through the Worker.

```
GitHub Actions: scout.yml (daily), add.yml (connector requests)
  scripts/scout/scout.ts ─► scripts/scout/arxiv/arxiv.ts, proceedings.ts, digests.ts, … ─► site/digests.js
  scripts/deploy/sync.ts push ─► Worker /liminal-space/api/sync/push ─► D1
  scripts/deploy/build-site.ts ─► dist/liminal-space/ (page, the owner's copy, data/index.json + data/months/*.json)
Browser: site/app.ts + site/page/*.ts
  public page ─GET data/*.json      owner page ─GET/POST the owner API ─► Worker ─► D1
Worker crons ─► GitHub workflow_dispatch (scout.yml 22:00 and 23:00 UTC, add.yml every 15 min)
claude.ai connector ─► Worker /liminal-space/mcp (search, get_digest, add requests that add.yml carries out)
```

The daily run, in the order `scout.yml` runs it:

1. `sync.ts count` stops the run when today already has its ten topic papers.
2. `sync.ts pull` copies D1 into `site/digests.js`, and the step before it restores `.cache/`.
3. `newsfeed.ts` reads `feeds.json`, `digests.ts add` appends its items and `describe.ts` copies the descriptions of
   items that came without one, while `search.ts` fills the candidate pool.
4. `score.ts` scores the pool.
5. `scout.ts` runs the scout, which adds papers and items through `arxiv.ts`, `proceedings.ts`, `surprise.ts` and
   `digests.ts`, and enriches them with `first-page.ts`, `figure.ts`, `describe.ts` and `fulltext.sh`.
6. `abstracts.ts` adds Semantic Scholar's abstract to the day's DOI papers that came without one, and `camera-ready.ts`
   links today's conference papers to their published versions, read from the proceedings files in `interests.md`
   (every paper on Mondays). Then `sync.ts push` sends the new lines to D1, `.cache/` is saved without `feedback.json`,
   and `sync.ts log` sends the scout's log.
7. A last job calls `deploy.yml`, which applies the D1 migrations, runs `sync.ts pull` and `build-site.ts`, and
   deploys the page.

## Commands

Node 26 and pnpm 12 (`packageManager` in package.json).

```bash
pnpm install --frozen-lockfile
pnpm run build                    # bundle site/app.ts, site/sw.ts and site/page/ into site/app.js, sw.js, claude-markdown.js and
                                  # study-strokes.js (Hanzi Writer, fetched on the first tooltip), and site/styles.css with site/style/ into site/style.css
pnpm run build:site               # build plus dist/ from site/digests.js
pnpm run preview                  # build:site, then wrangler dev on port 8787
pnpm run typecheck                # tsc on the root, site, service worker, tests and worker projects
pnpm exec biome check --write <files>
pnpm run test:unit                # Vitest, tests/unit/
pnpm exec vitest run tests/unit/app.test.ts -t "<test name>"
pnpm exec playwright install webkit  # once: the browser the phone scenarios (@phone) run in
pnpm run test:e2e                 # build, bddgen, then Playwright runs features/*.feature: @phone in headless WebKit
                                  # on a phone's screen (project phone), the rest in headless Chrome (project chrome)
pnpm exec bddgen && pnpm exec playwright test --grep "<scenario name>"
```

- Chrome and WebKit won't start inside the Bash sandbox (they need their own profile and Mach ports): run the e2e
  commands with the sandbox off. Chrome's own sandbox stays on (`chromiumSandbox: true` in `playwright.config.ts`).

- `site/digests.js` is gitignored, so a new worktree has none. Symlink the main checkout's copy into the worktree's
  `site/` before building or previewing there.

## Architecture

- `scripts/`: Node TypeScript CLIs, run directly with `node` (no build step), grouped by purpose. A program is a file
  with an `if (import.meta.main)` block; the modules beside it serve that group.
  - `scout/`: the daily run. `scout.ts` runs the session with its instructions `scout.md`; `search.ts` fills the
    candidate pool (the plan's pieces in `plan/`), `score.ts` scores it and `surprise.ts` lists the surprise paper's
    candidates. One folder per source: `arxiv/` (`arxiv.ts` appends papers, `figure.ts` and `first-page.ts` read their
    HTML), `proceedings/`, `newsfeed/`, `news/` (Google News), `hugging-face/`, and `web/` (`describe.ts` copies a
    publisher's description, `fulltext.sh` fetches an item's full text, checked by `fetch-guard.ts`).
  - `digests/`: `digests.ts` answers questions about the digests file, adds items to it and checks every line.
  - `deploy/`: building the site (`build-site.ts`), syncing with D1 (`sync.ts`) and the connector's add requests
    (`add-requests.ts`).
  - `lib/`: what every group shares: the CLI exit and paths (`cli.ts`), one HTTP helper (`http.ts`) and its public
    address check (`public-address.ts`), the run date, the owner's feedback, HTML reading and `constants.json`.
  No program imports another program, `lib/` imports only `lib/` and `shared/`, only `scout/` imports from `scout/`,
  and only `cli.ts` in `lib/` calls `process.exit`; `tests/unit/layout.test.ts` checks all four. Outside `scripts/`,
  only tests import from it.
- `shared/`: the files the scripts, the Worker and the page all import, which import nothing from `scripts/`,
  `site/` or `worker/` (`tests/unit/layout.test.ts` checks it): `narrow.ts`, `entry-checks.ts` (what a digest line and
  an entry may hold), `entry-groups.ts`, `entry-markdown.ts`, `arxiv-id.ts`, `local-address.ts`, `site-data-shape.ts`
  and the Worker request shapes and limits in `owner-protocol.ts`, `push-protocol.ts`, `log-protocol.ts`,
  `connector-protocol.ts` and `notify-protocol.ts`.
- `site/`: the page. `index.html`, `app.ts`, which esbuild bundles with the modules in `site/page/` (the comment
  board's pieces in `site/page/comments/`) into `app.js`, and the stylesheet: `styles.css` imports one file per part
  of the page from `site/style/`, and the build bundles them into `style.css`, which is build output like `app.js`.
  `sw.ts` is the owner's service worker, built into `sw.js`. The same page serves the public copy and
  the owner's copy; it knows which from its address. `site/katex/` is vendored KaTeX for TeX in
  titles and abstracts. On a mouse, `site/page/study.ts` opens a tooltip for the word under the pointer in a Chinese
  entry's title or description, from the words file the index names; it changes none of the entry's text.
- `worker/src/`: the Cloudflare Worker (`wrangler.jsonc`): sync, owner, connector (MCP) and log routes, Access
  checks, and the crons that dispatch GitHub workflows. `index.ts` holds the route table (`ROUTES`), which
  `routes.ts` dispatches through the path, method, token and same-site checks in that order; each route's handler
  sits in its module (`owner/` for the owner's checks, writes, reads and handlers; `mcp-tools.ts` for the connector's
  tools). `worker/migrations/` holds the D1 schema.
- `tests/unit/` holds the Vitest tests, `tests/support/` the Worker harness some of them share, `tests/fixtures/`
  the stand-in pages and files. The page's DOM tests run under jsdom (`// @vitest-environment jsdom`); jsdom lays
  nothing out, so sizes, scrolling and text selection are left to the scenarios in Chrome.
- `features/` holds the owner's reviewed scenarios, which playwright-bdd runs (`playwright.config.ts`) with the steps
  in `tests/steps/`, grouped by concept. `tests/steps/world.ts` gives each scenario the built page served by the real
  Worker with its own D1 (`tests/support/cloud.ts`), the digests pushed with `sync.ts`, and stand-ins for Access,
  Anthropic's API and arXiv; Chrome reaches the Worker through a route at the site's own address. Every scenario
  fails on any console error a page logged, a Content-Security-Policy violation included.

Rules that hold across folders:

- `site/digests.js` changes only through the scripts. Each line is `digest(<JSON>);` and is checked by
  `shared/entry-checks.ts`; the Worker runs the same checks.
- "Today" is the date in Asia/Jakarta, in the scripts (`scripts/lib/run-date.ts`) and on the page (`site/page/days.ts`).
- A push never changes or removes a stored entry: `worker/src/push.ts` inserts with `ON CONFLICT DO NOTHING`.
- `WORKER_PATHS` in `worker/src/index.ts` must equal `assets.run_worker_first` in `wrangler.jsonc`;
  `tests/unit/worker-routes.test.ts` checks it.
- Every Worker route checks the Access token itself. Owner POSTs also need the owner's email, the site's Origin and
  the header `X-Liminal: 1`, which `site/page/owner.ts` sends.
- Workflows the Worker dispatches always run on `main` (`worker/src/schedule.ts`).

## Phone and desktop

The page targets the latest Chromium on a desktop, so Chromium-only features are fine there, and Apple's WebKit on a
phone, so the phone layout must work in the latest Safari engine.

The page has a second layout for a phone: a touch screen narrower than 600px, `PHONE_QUERY` in `site/page/phone.ts`
and the same media query in `site/style/phone.css`. It has a sticky bar with the last 7 days and Contents, each
entry's buttons in a row, a swipe left that marks an entry read, and comments in a sheet from the bottom (the side
panel's own dialog with the `comment-panel--sheet` class, set in `site/page/sheet.ts`). Every phone rule and
gesture sits behind that query, so a window with a mouse keeps the desktop page; keep it that way when changing
either. On any touch screen, Highlight and Comment sit in a bar at the bottom. The page runs under the iPhone's status
bar and home indicator (`viewport-fit=cover`); phone rules keep clear of them with `env(safe-area-inset-*)`, which is
0 on a desktop.

## Tests and commits

- A scenario describes something the owner asked for, in the words they would use to ask for it, checked from the
  outside, at any layer. Only scenarios the owner approved are added. Edge cases, error paths, limits, formats and
  security checks are unit tests. Scenarios live in `features/<name>.feature` and hold behaviour only.
- Commits follow Conventional Commits. Approved scenarios, step stubs and test names go in `test(...)` commits. No
  commit carries `[skip ci]`.
- Gherkin and Playwright are for end-to-end journeys only; everything else is a Vitest unit test.
- A comment is one short intent line saying what the block does, 5 words at most. Skip it when the code explains
  itself: would a junior engineer be confused without it? No decision-log comments (why, when, what was tried).
- pre-commit runs Biome, shellcheck and gitleaks on each commit, and one `typecheck` hook (`pnpm run typecheck`: the
  root, site, service worker, tests and Worker projects) whenever a TypeScript, tsconfig or package.json file changes.
- Tests run locally: while building, the ones a change adds or touches; before a merge into `develop`, the unit tests
  (`pnpm run test:unit`) and every scenario (`pnpm run test:e2e`, sandbox off), unless the owner says to skip a run.
- On GitHub, every pull request runs the type check, Biome and the unit tests, and a pull request into `develop` or
  `main` also runs the scenarios (`checks.yml`). Nothing merges into `develop` or `main` before all of them pass.

## Branches and releases

`develop` is staging and `main` is production. Work reaches `develop` only through pull requests, and every push to
`develop` deploys staging. Production changes only through the pull request
from `develop` into `main`. Its description follows `.github/PULL_REQUEST_TEMPLATE/release.md`.

- Claude merges into `develop`, as `claude-ivn`, once the local tests and GitHub's checks pass. The owner then tries
  the change on staging, and decides between more fixes and a release. Never hand the owner local test commands.
- A merge into `main` needs the owner's explicit approval, each time. Never commit or push to `main`, and open the
  release pull request only when the owner asks for it.
- Every merge is a merge commit, never a squash.

Open and merge pull requests with `gh stack` (`gh stack merge <n> --merge -y`). Stacked PRs are enabled on this
repository and have worked all along. When `gh stack` says "Stacked PRs are not enabled", the Bash sandbox is
blocking its check, not GitHub: run every `gh stack` command with the sandbox off. Never fall back to plain `gh pr create` because of that message.
