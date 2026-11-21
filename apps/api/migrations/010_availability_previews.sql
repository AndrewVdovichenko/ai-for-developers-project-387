CREATE TABLE availability_previews (
 token_hash text PRIMARY KEY,
 owner_subject text NOT NULL,
 parameters jsonb NOT NULL,
 consequences jsonb NOT NULL,
 expires_at timestamptz(3) NOT NULL
);
