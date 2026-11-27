<!--
Title (typed in the field above, not here): Conventional Commits, one change,
imperative, stands alone. "feat(rpc): delete the FizzBuzz RPC", not "Deleted...",
not "Fix bug", not "Phase 1".
If it needs an "and", it is two PRs.

Rules for this description:
- First sentence of every section is the whole answer. Lines after it are optional depth.
- Plain clauses. No em dashes. No semicolon fragment stacking. **No theatrics, no drama, no slogan-style labels or sentences.**
- Say each thing once. If two sections would repeat, cut one.
- Scale to the diff: a 3-line change gets a 3-line description. In a big PR, one
  sentence per specific thing, as bullet points.
- Every claim carries its evidence: a number, a test name, a log line.
- One name per concept, held constant.
-->

## Requirement / Issue (Why)
<!-- What you want, one sentence. Then at most a line or two on why it matters now. -->

## Solution (What)
<!-- The behavior change, one sentence. Then the details a user would notice. -->

## Implementation (How)
<!-- Numbered trace: start from the user action, walk the code path to the result.
     Name code as module.function so each step is findable. Tag each step (new) or
     (existing); a (new) step says where it lives, e.g. (new, actions.py).
     Fold small failure handling into the steps. -->
1.

## Verify
<!-- Test count and gates in one line, with the commands. Then the strongest evidence:
     device results, measurements, the break that proved each security or privacy test. -->

## Performance
<!-- Base <sha> vs this PR. A row per measure that applies; delete the rest.
     Every cost the feature does not explain gets a cause and a fix or follow-up. -->
| Measure | Base | This PR | Delta | Explained by |
|---|---|---|---|---|
| This PR's tests: mean per test | n/a | | | |
| This PR's tests: slowest setup step | n/a | | | |
| Feature CPU time / peak memory (RSS) | | | | |
| Product budget (payload, cold start, rows read) | | | | |

## Stack
<!-- Every PR in a stack. Drafts name positions until the PRs exist. -->
PR N of M. Depends on #X. Enables #Y.

## Caveats
<!-- Known limits and first guesses. Delete the section if none. -->

<!-- Sections below only when real. Delete otherwise.

## Exception handling
What can go wrong and what the code does about it, when too big to fold into How.

## Breaking changes
Migration or reinstall required, and how.

## Notes for reviewer
Where to look hardest, what you are unsure of.

## Out of scope
What this deliberately skips and where it is handled instead.

## Files
- `path/to/file` and one plain line each, when the diff spans enough files that a map helps.
-->
