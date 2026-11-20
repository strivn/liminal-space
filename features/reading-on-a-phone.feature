@phone @owner
Feature: Reading on a phone
  The owner reads, marks and comments on papers on a phone.

  Background:
    Given today has 15 papers

  Scenario: The bar with the last 7 days stays while scrolling, and Contents jumps to a paper
    When the owner opens their page
    And clicks the 10th title of today in Contents
    Then today's 10th paper is at the top of the window
    And the bar with the last 7 days is at the top of the window

  Scenario: A swipe marks a paper read, and a highlight and a comment made on the phone stay after a reload
    When the owner opens their page
    And swipes today's 2nd paper to the left
    And highlights the first sentence of its abstract
    And comments "Is this the main claim?" on the second sentence of its abstract
    And reloads the page
    Then today's 2nd paper shows read to the Abstract
    And the first sentence of its abstract shows highlighted
    And the paper shows the comment "Is this the main claim?" quoting the second sentence of its abstract

  Scenario: A comment is written in a sheet at the bottom of the window
    When the owner types "Check the baseline." in a new comment on today's 2nd paper
    Then the comment box is in a sheet at the bottom of the window
