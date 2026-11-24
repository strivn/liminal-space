Feature: The morning's papers arrive
  A paper the morning scripts add shows on both pages.

  Scenario: A lab's blog post shows the figure the scout picked, not its cover image
    Given OpenAI's blog has the post "Combatting adversarial distillation" with a cover image and a diagram
    When the morning scripts add the post, the scout picks its diagram and the day is pushed
    Then the public page shows the diagram under the post's description
    And the diagram opens the post

  Rule: A paper's title opens its published version when its proceedings list it, and its arXiv page otherwise

    Scenario: A paper added this morning shows on both pages and opens its published version
      Given arXiv has the paper "Attention Is All You Need"
      And NeurIPS 2017 accepted it and its proceedings list it
      When the morning scripts add it and push the day
      Then the public page shows "Attention Is All You Need" under today
      And the owner's page shows "Attention Is All You Need" under today
      And its title opens its NeurIPS 2017 proceedings page, with arXiv still linked

    Scenario: A paper only on arXiv opens its arXiv page
      Given arXiv has the paper "Chain of Thought Monitorability: A New and Fragile Opportunity for AI Safety"
      When the morning scripts add it and push the day
      Then the public page shows "Chain of Thought Monitorability: A New and Fragile Opportunity for AI Safety" under today
      And its title opens its arXiv page
