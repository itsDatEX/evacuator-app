-- Extend vehicle_size to three categories: normal | jeep | large
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_vehicle_size_check;
ALTER TABLE orders ADD CONSTRAINT orders_vehicle_size_check
  CHECK (vehicle_size IN ('normal', 'jeep', 'large'));
