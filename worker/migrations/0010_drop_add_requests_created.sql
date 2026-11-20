-- The index on add_requests(created) served only the add_status tool, which is gone; the databases that ran 0002 drop it.
DROP INDEX IF EXISTS add_requests_created;
