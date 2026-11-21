-- json preserves every parsed JSON string, including escaped U+0000.
-- jsonb rejects those strings before final request validation can be saved.
ALTER TABLE operations ALTER COLUMN parameters TYPE json USING parameters::json;
ALTER TABLE operations ALTER COLUMN body TYPE json USING body::json;
