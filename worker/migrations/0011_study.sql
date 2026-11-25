-- The Chinese study of an entry: json is a Study (shared/study-protocol.ts) and id is the entry's id. A study is
-- replaced when the job makes a better one, so unlike an entry it may change; updated is the UTC time it was stored.
CREATE TABLE study (
	id TEXT PRIMARY KEY,
	json TEXT NOT NULL,
	updated TEXT NOT NULL
);
