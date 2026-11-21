CREATE TABLE guests (
 id uuid PRIMARY KEY,
 secret_hash text UNIQUE NOT NULL,
 expires_at timestamptz(3) NOT NULL
);
CREATE TABLE holds (
 id uuid PRIMARY KEY,
 creation_order bigint GENERATED ALWAYS AS IDENTITY UNIQUE NOT NULL,
 guest_id uuid NOT NULL REFERENCES guests(id),
 event_type_id uuid NOT NULL REFERENCES event_types(id),
 starts_at timestamptz(3) NOT NULL,
 ends_at timestamptz(3) NOT NULL CHECK (ends_at > starts_at),
 expires_at timestamptz(3) NOT NULL,
 state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','released','replaced','confirmed')),
 booking_id uuid
);
CREATE INDEX holds_guest ON holds(guest_id, creation_order DESC);
CREATE INDEX holds_occupancy ON holds(expires_at) WHERE state = 'active';
