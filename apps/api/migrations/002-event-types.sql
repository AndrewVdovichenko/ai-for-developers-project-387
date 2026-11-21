CREATE TABLE event_types (
  id uuid PRIMARY KEY,
  creation_order bigint GENERATED ALWAYS AS IDENTITY UNIQUE NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 1 AND 1440)
);
CREATE TABLE operations (
  subject text NOT NULL,
  key uuid NOT NULL,
  action text NOT NULL,
  parameters jsonb NOT NULL,
  status integer NOT NULL CHECK (status BETWEEN 200 AND 499),
  body jsonb NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (subject, key)
);
