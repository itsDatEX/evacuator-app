-- Driver's own vehicle category for informational/display purposes.
-- Separate from truck_type (regular/crane) which controls can_roll matching.
ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS car_category VARCHAR(10) DEFAULT 'normal'
    CHECK (car_category IN ('normal', 'jeep', 'large'));
