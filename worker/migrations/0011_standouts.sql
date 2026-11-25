-- Marked papers; a null date keeps the note.
CREATE TABLE standouts (entry_id TEXT PRIMARY KEY, date TEXT, note TEXT NOT NULL DEFAULT '');
