-- The notifications already sent: one row per kind and Jakarta day, written before the pushes go
-- out, so a cron that runs again in the same hour sends nothing twice.
CREATE TABLE notification_sends (kind TEXT NOT NULL, date TEXT NOT NULL, PRIMARY KEY (kind, date));
-- The 20:00 reminder asks which papers were read on a day; every lookup has an index (0001_init.sql).
CREATE INDEX read_state_date ON read_state(date);
