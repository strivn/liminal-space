-- Who wrote each comment: 'owner' for a comment saved through the owner's page, 'claude' for
-- Claude's reply saved by the ask route. A comment stored before this column existed was the owner's, so the default
-- gives every stored comment 'owner'.
ALTER TABLE comments ADD COLUMN author TEXT NOT NULL DEFAULT 'owner';
