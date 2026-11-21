ALTER TABLE calendar ADD COLUMN days jsonb NOT NULL DEFAULT '[{"weekday":1,"intervals":[]},{"weekday":2,"intervals":[]},{"weekday":3,"intervals":[]},{"weekday":4,"intervals":[]},{"weekday":5,"intervals":[]},{"weekday":6,"intervals":[]},{"weekday":7,"intervals":[]}]'
  CHECK (jsonb_typeof(days) = 'array' AND jsonb_array_length(days) = 7);
