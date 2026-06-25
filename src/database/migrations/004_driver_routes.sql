-- Active route that a driver has declared: they will only receive orders
-- where the pickup or destination city matches route_from or route_to.
-- Route expires automatically 2 hours after route_departure_at (enforced in query).
ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS route_from         VARCHAR(100),
  ADD COLUMN IF NOT EXISTS route_to           VARCHAR(100),
  ADD COLUMN IF NOT EXISTS route_departure_at TIMESTAMPTZ;
