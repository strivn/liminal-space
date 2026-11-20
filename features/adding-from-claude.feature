Feature: Adding a paper from Claude
  A paper the owner asks Claude to add shows on both pages a few minutes later.

  Scenario: A paper Claude adds is queued, and shows on both pages once the add run has carried it out
    Given arXiv has the paper "Attention Is All You Need"
    When Claude adds it through the connector
    Then Claude is told it is queued and to check the page in a few minutes
    When the add run carries the request out
    Then the public page shows "Attention Is All You Need" under today
    And the owner's page shows "Attention Is All You Need" under today
