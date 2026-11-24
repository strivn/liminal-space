@owner
Feature: Asking Claude in a comment
  A comment that mentions @Claude gets Claude's answer as a reply in the same thread.

  Background:
    Given today has 15 papers

  Rule: Claude's reply shows its formatting and is kept

    Scenario: Claude's reply shows bold, math, a list and a link, sits beside its paper, and stays after a reload
      Given the window is 1400px wide
      And Claude will answer "**Loss** is $L = \sum_i x_i$.\n\n- cut into frames\n- follow the path\n\nSee [the paper](https://arxiv.org/abs/2610.30182)."
      When the owner scrolls halfway down today's 5th paper
      And the owner comments "@Claude what is the loss?" on today's 5th paper
      Then the comment card is level with the paper's title, and the paper is no taller than its text
      And Claude's reply shows its first 3 lines and "Show more"
      When the owner reloads the page
      Then the thread "@Claude what is the loss?" shows folded, with "1 reply"
      When the owner opens "1 reply" and "Show more"
      Then Claude's reply shows under the question
      And it shows "Loss" in bold, the formula typeset, a list of 2 items and a link to "https://arxiv.org/abs/2610.30182"

  Rule: Typing "@" offers the mentions a comment can make

    Scenario: Typing "@" suggests "@Claude", and Tab accepts it
      When the owner types "what is this @" in a new comment on today's 5th paper
      Then the comment box suggests "Claude" after the "@"
      When the owner presses Tab
      Then the comment box reads "what is this @Claude "

    Scenario: "@Claude" shows in Claude's orange while typing and once saved
      When the owner comments "@Claude what is this?" on today's 5th paper
      Then "@Claude" shows in Claude's orange in the comment box and in the saved comment

    # On hold: the phone interaction is not designed yet.
    # @phone
    # Scenario: On a phone, a tap on the suggestion fills it in
    #   When a reader types "@" in a new comment
    #   And taps the "@Claude" suggestion
    #   Then the comment box reads "@Claude "

  # On hold: how Claude answers needs the real model, which makes these regression and stability tests.
  # Rule: Claude answers from the paper itself
  #
  #   @live
  #   Scenario: Claude reads the paper before answering a question the abstract can't answer
  #     Given the paper "Detecting AI Training in Datacentre Power" from arXiv
  #     When a reader asks "@Claude what is Viterbi tracking, and what is wandering iteration cadence?"
  #     Then Claude's reply names the section of the paper it relies on
  #     And the reply never says what Claude did or didn't read
  #
  #   @live
  #   Scenario: Claude looks on the web before saying whether a finding is new
  #     Given the paper "Rethinking SAE Evaluation" from arXiv
  #     When a reader asks "@Claude is the dominance finding new?"
  #     Then Claude searched the web before replying
  #
  # Rule: Claude's reply is quick to read
  #
  #   @live
  #   Scenario: A two-part question gets a short answer, with each term in bold
  #     Given the paper "Detecting AI Training in Datacentre Power" from arXiv
  #     When a reader asks "@Claude what is Viterbi tracking, and what is wandering iteration cadence?"
  #     Then Claude's reply is at most 120 words
  #     And "Viterbi tracking" and "iteration cadence" show in bold
  #
  #   @live
  #   Scenario: A simple question gets a shorter answer
  #     Given the paper "Curvature-Aware Clipping" from arXiv
  #     When a reader asks "@Claude what does DPSGD stand for?"
  #     Then Claude's reply is at most 60 words
