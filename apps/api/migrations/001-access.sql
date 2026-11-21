CREATE TABLE calendar (
  id integer PRIMARY KEY CHECK (id = 1),
  password_hash text,
  time_zone text,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
INSERT INTO calendar (id) VALUES (1);
CREATE TABLE owner_sessions (
  secret_hash text PRIMARY KEY,
  created_at timestamptz(3) NOT NULL,
  expires_at timestamptz(3) NOT NULL,
  CHECK (expires_at = created_at + interval '168 hours')
);
CREATE TABLE login_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ip inet NOT NULL,
  attempted_at timestamptz(3) NOT NULL
);
CREATE INDEX login_attempts_ip_time ON login_attempts (ip, attempted_at);
