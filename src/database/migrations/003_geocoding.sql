-- Reverse-geocoded city names for driver route matching.
-- NULL when Nominatim call failed or order was created via phone (no GPS).
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS pickup_city VARCHAR(100),
  ADD COLUMN IF NOT EXISTS dest_city   VARCHAR(100);
