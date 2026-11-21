CREATE TABLE bookings (
 id uuid PRIMARY KEY,
 hold_id uuid UNIQUE NOT NULL REFERENCES holds(id),
 guest_id uuid NOT NULL REFERENCES guests(id),
 event_type_id uuid NOT NULL REFERENCES event_types(id),
 starts_at timestamptz(3) NOT NULL,
 ends_at timestamptz(3) NOT NULL CHECK (ends_at > starts_at),
 guest_name text NOT NULL CHECK (char_length(guest_name) BETWEEN 1 AND 100),
 guest_email text NOT NULL CHECK (char_length(guest_email) BETWEEN 1 AND 254)
);
ALTER TABLE holds ADD CONSTRAINT holds_booking_fk FOREIGN KEY (booking_id) REFERENCES bookings(id);
CREATE INDEX bookings_ends ON bookings(ends_at);
CREATE INDEX bookings_type_ends ON bookings(event_type_id, ends_at);
