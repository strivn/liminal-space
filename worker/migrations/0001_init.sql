-- Every table Liminal space keeps, with an index for every lookup: D1 bills rows examined, not rows returned.

-- One row per entry. seq is the order entries were added in; json is the entry exactly as a digests line holds it.
CREATE TABLE entries (
	id TEXT PRIMARY KEY,
	date TEXT NOT NULL,
	seq INTEGER NOT NULL UNIQUE,
	json TEXT NOT NULL,
	updated TEXT NOT NULL
);
CREATE INDEX entries_date ON entries(date);

-- The owner's read marks, tags and comments, one row per entry or thread so two devices never overwrite each other.
CREATE TABLE read_state (entry_id TEXT PRIMARY KEY, depth TEXT NOT NULL, date TEXT NOT NULL);
CREATE TABLE tags (entry_id TEXT PRIMARY KEY, to_read INTEGER NOT NULL, learn_first INTEGER NOT NULL);
CREATE TABLE threads (
	id TEXT PRIMARY KEY,
	entry_id TEXT NOT NULL,
	field TEXT,
	passage TEXT,
	occurrence INTEGER,
	created TEXT NOT NULL
);
CREATE INDEX threads_entry ON threads(entry_id);
CREATE TABLE comments (
	id TEXT PRIMARY KEY,
	thread_id TEXT NOT NULL,
	text TEXT NOT NULL,
	created TEXT NOT NULL,
	edited TEXT
);
CREATE INDEX comments_thread ON comments(thread_id);

-- Adds asked for from a Claude app, waiting for or done by add.yml.
CREATE TABLE add_requests (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL,
	payload TEXT NOT NULL,
	status TEXT NOT NULL,
	created TEXT NOT NULL,
	finished TEXT,
	result TEXT
);
CREATE INDEX add_requests_status ON add_requests(status);
