<!--
Release pull request, develop into main. Title: "release: develop into main, <what it brings> (<YYYY-MM-DD>)".
Merge with a merge commit, never a squash.

Rules for this description:
- One bullet per change the reader notices, tagged:
  Features: [Feature] a capability of the page or the owner's page, [UI] a look or layout change,
  [Scout] the scout, [Deployment] Cloudflare, the Worker's setup, integrations.
  Maintenance: [Security], [Speed], [Tests], [CI], [Docs].
- Under each bullet: one bullet per stack ("Stack in #N", or "Stack #S in #N"), and under it one bullet per PR,
  "#n <what it does>". A PR outside any stack is its own bullet at the stack's level.
- Never write an @ followed by a name, such as a model or a scenario tag: GitHub notifies that account.
- Leave out which secrets exist and what the merge runs.
- Security Review: low findings count as no issues. Describe each medium or high finding and the PR that fixes it.
-->

# Features

* [Feature] <what the reader can now do>
  * Stack in #<integration PR>
    * #<n> <what it does>
  * #<n> <what it does>
* [UI] <what looks or sits differently>
  * #<n> <what it does>
* [Scout] <what the scout does differently>
  * #<n> <what it does>
* [Deployment] <what changed in Cloudflare, the Worker's setup or an integration>
  * #<n> <what it does>

# Maintenance

* [Security] <what is now refused or kept out>
  * #<n> <what it does>
* [Speed] <what is faster or smaller>
  * #<n> <what it does>
* [Tests] <what the tests check differently>
  * #<n> <what it does>
* [CI] <what the workflows do differently>
  * #<n> <what it does>
* [Docs] <what the instructions now say>
  * #<n> <what it does>

# Security Review

Opus reviewed every change in this release and found no issues.
