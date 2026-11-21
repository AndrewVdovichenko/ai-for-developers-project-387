-- PostgreSQL text cannot represent U+0000; JSON strings preserve the full input.
-- Count decoded code points without converting the value back into PostgreSQL text.
CREATE FUNCTION json_string_length(value json) RETURNS integer
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT char_length(regexp_replace(value::text,
    '\\u[dD][89aAbB][0-9a-fA-F]{2}\\u[dD][c-fC-F][0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4}|\\.', 'x', 'g')) - 2
$$;
ALTER TABLE event_types DROP CONSTRAINT event_types_name_check;
ALTER TABLE event_types DROP CONSTRAINT event_types_description_check;
ALTER TABLE event_types ALTER COLUMN description DROP DEFAULT;
ALTER TABLE event_types ALTER COLUMN name TYPE json USING to_json(name);
ALTER TABLE event_types ALTER COLUMN description TYPE json USING to_json(description);
ALTER TABLE event_types ALTER COLUMN description SET DEFAULT '""'::json;
ALTER TABLE event_types ADD CONSTRAINT event_types_name_check
  CHECK (json_typeof(name) = 'string' AND json_string_length(name) BETWEEN 1 AND 100);
ALTER TABLE event_types ADD CONSTRAINT event_types_description_check
  CHECK (json_typeof(description) = 'string' AND json_string_length(description) <= 2000);
