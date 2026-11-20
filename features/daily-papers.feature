Feature: The morning's papers arrive
  A paper the morning scripts add shows on both pages.

  Scenario: A paper added this morning shows on the public page and the owner's page
    Given arXiv has the paper "Attention Is All You Need"
    When the morning scripts add it and push the day
    Then the public page shows "Attention Is All You Need" under today
    And the owner's page shows "Attention Is All You Need" under today
