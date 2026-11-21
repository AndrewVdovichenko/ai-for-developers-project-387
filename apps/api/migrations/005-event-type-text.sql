-- Return form fields to ordinary text. Decoding fails atomically if an existing
-- value contains U+0000; no data is silently removed or rewritten.
ALTER TABLE event_types DROP CONSTRAINT event_types_name_check;
ALTER TABLE event_types DROP CONSTRAINT event_types_description_check;
ALTER TABLE event_types ALTER COLUMN description DROP DEFAULT;
ALTER TABLE event_types ALTER COLUMN name TYPE text USING name #>> '{}';
ALTER TABLE event_types ALTER COLUMN description TYPE text USING description #>> '{}';
ALTER TABLE event_types ALTER COLUMN description SET DEFAULT '';
ALTER TABLE event_types ADD CONSTRAINT event_types_name_check
  CHECK (char_length(name) BETWEEN 1 AND 100);
ALTER TABLE event_types ADD CONSTRAINT event_types_description_check
  CHECK (char_length(description) <= 2000);
DROP FUNCTION json_string_length(json);
