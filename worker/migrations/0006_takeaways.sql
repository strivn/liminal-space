-- The owner's takeaways: what they keep from an entry in their own words, and the recall question whose
-- answer it is (NULL when they gave none), private like the owner's other tables. source names where it was saved:
-- 'claude.ai' or 'ChatGPT' through the connector's propose_takeaway, 'page' on the owner's page. created and edited are
-- UTC times; an edit changes takeaway, recall_question and edited only. takeaways_entry finds one entry's takeaways
-- for the connector's search and get_digest.
CREATE TABLE takeaways (
	id TEXT PRIMARY KEY,
	entry_id TEXT NOT NULL,
	takeaway TEXT NOT NULL,
	recall_question TEXT,
	created TEXT NOT NULL,
	edited TEXT,
	source TEXT NOT NULL
);
CREATE INDEX takeaways_entry ON takeaways(entry_id);
