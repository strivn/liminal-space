-- One cloud scout run's log (.scout-logs/<date>.md), private like the owner's state: written through
-- the sync route, read only on the owner route. id is the run's <run id>-<attempt>; updated is when it was stored, as
-- an ISO time. Storing a log removes those dated more than 30 days before it, through scout_logs_date.
CREATE TABLE scout_logs (id TEXT PRIMARY KEY, date TEXT NOT NULL, log TEXT NOT NULL, updated TEXT NOT NULL);
CREATE INDEX scout_logs_date ON scout_logs(date);
