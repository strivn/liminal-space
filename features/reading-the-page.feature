Feature: Reading the page
  The owner reads, marks and comments on papers; a visitor sees the same papers without the owner's reading.

  Background:
    Given yesterday has 10 papers
    And today has 15 papers
    And 3 of today's papers are read to the Abstract
    And 1 of today's papers is read to the Paper
    And today has an entry in Chinese, "估值 410 亿美元，贝佐斯打造「物理世界的 OpenAI」", with its words prepared

  Scenario: Both pages show the same papers, only the owner's shows the reading, and Chinese words can be studied
    When a visitor opens the public page and the owner opens their page
    Then both show today's 15 papers in the same order
    And only the owner's page has Abstract, Paper, OK, Like, Dislike and Comment buttons
    And only the owner's page says today's square has 4 of 15 read, with a crown
    And only the owner's page says yesterday's square has 0 of 10 read, with no crown
    When the visitor hovers "估值" in the Chinese entry's title
    Then the visitor sees "gūzhí" under "估值", and a second later "valuation"
    And the visitor sees "估" drawn with "gū" under it and "值" drawn with "zhí" under it
    And the visitor sees that "亻" gives "估" its meaning and "古" its sound
    When the visitor hovers "贝佐斯" in the Chinese entry's title
    Then the visitor sees "Bèizuǒsī" and "Bezos", with no drawn characters
    When the visitor hovers a word in the title of today's 1st paper
    Then no word tooltip opens
    When the visitor clicks "估值" in the Chinese entry's title
    Then the Chinese entry's article opens

  @owner
  Scenario: Clicking a title in Contents brings that paper to the top
    When the owner opens their page
    And clicks the 8th title of today in Contents
    Then today's 8th paper is at the top of the window

  @owner
  Scenario: Reading a paper in depth, giving it OK, commenting and highlighting all stay after a reload
    When the owner opens yesterday on the heatmap
    And marks yesterday's 2nd paper as read to the Paper
    And gives it OK
    And comments "Check the baseline." on it
    And highlights the first sentence of its abstract
    And comments "Is this the main claim?" on the second sentence of its abstract
    And reloads the page
    And opens yesterday on the heatmap
    Then yesterday's 2nd paper shows read to the Paper and OK
    And yesterday's square has 1 of 10 read, with a crown
    And the paper shows the comment "Check the baseline."
    And the paper shows the comment "Is this the main claim?" quoting the second sentence of its abstract
    And the first sentence of its abstract shows highlighted
    And today's square still has 4 of 15 read
    And the public page shows none of it

  @owner
  Scenario: A press made after the owner's sign-in ended is undone and says it wasn't saved
    When the owner opens their page
    And the owner's sign-in ends
    And marks today's 8th paper as read to the Paper
    Then the page says "Not saved"
    And today's square still has 4 of 15 read
    When the owner signs in again
    And marks today's 8th paper as read to the Paper
    And reloads the page
    Then today's square has 5 of 15 read

  @owner
  Scenario: A link to a paper in an older month opens on that paper, and Back returns to the reading place
    Given a day 2 months ago has 5 papers
    When the owner opens their page
    And clicks the 12th title of today in Contents
    And follows a link to the 3rd paper of the day 2 months ago
    Then that paper is at the top of the window
    When the owner goes back
    Then today's 12th paper is at the top of the window

  @owner
  Scenario: A narrow window with a mouse keeps the desktop page
    Given the window is 500px wide
    When the owner opens their page
    Then the page has no bar with the last 7 days

  @owner
  Scenario: A paper the owner selects shows with their note on the public page's Selected
    When the owner opens their page
    And selects today's 2nd paper
    And writes the note "Changed how I read monitor results." on it in Selected
    And a visitor opens the public page the next morning
    Then the public page opens on Selected
    And Selected lists today's 2nd paper under its OpenAlex topic, with the note "Changed how I read monitor results."
