-- A highlight: a thread on a passage the owner marked, which may hold no comments. 1 for a
-- highlight, 0 for a thread that goes with its last comment; every thread stored before reads as 0.
ALTER TABLE threads ADD COLUMN highlight INTEGER NOT NULL DEFAULT 0;
