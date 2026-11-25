-- The papers the owner marked as having shaped their thinking, with a public note. A null date is an unmarked paper
-- that keeps its note for when it is marked again.
CREATE TABLE standouts (entry_id TEXT PRIMARY KEY, date TEXT, note TEXT NOT NULL DEFAULT '');
