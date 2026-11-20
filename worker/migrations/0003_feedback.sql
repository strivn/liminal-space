-- The owner's like or dislike of an entry, one row per entry; date is the day pressed in Asia/Jakarta.
-- sync.ts pull --database reads the last 30 days of them through feedback_date.
CREATE TABLE feedback (entry_id TEXT PRIMARY KEY, mark TEXT NOT NULL, date TEXT NOT NULL);
CREATE INDEX feedback_date ON feedback(date);
