-- Users (passengers)
CREATE TABLE IF NOT EXISTS passengers (
  id SERIAL PRIMARY KEY,
  telegram_id BIGINT UNIQUE NOT NULL,
  username VARCHAR(100),
  phone VARCHAR(20),
  full_name VARCHAR(200),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Drivers
CREATE TABLE IF NOT EXISTS drivers (
  id SERIAL PRIMARY KEY,
  telegram_id BIGINT UNIQUE NOT NULL,
  username VARCHAR(100),
  phone VARCHAR(20),
  full_name VARCHAR(200),
  car_model VARCHAR(100),
  car_plate VARCHAR(20),
  -- 'regular' = platform tow (rolling only), 'crane' = crane lift (rolling + non-rolling)
  truck_type VARCHAR(10) NOT NULL DEFAULT 'regular' CHECK (truck_type IN ('regular', 'crane')),
  is_active BOOLEAN DEFAULT false,
  is_available BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Orders
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  uuid UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
  passenger_id INTEGER REFERENCES passengers(id),
  driver_id INTEGER REFERENCES drivers(id),
  pickup_lat DECIMAL(10, 8),
  pickup_lng DECIMAL(11, 8),
  pickup_address TEXT,
  dest_lat DECIMAL(10, 8),
  dest_lng DECIMAL(11, 8),
  destination_address TEXT,
  -- 'normal' or 'large' (minibus, truck) — affects price only, not matching
  vehicle_size VARCHAR(10) NOT NULL DEFAULT 'normal' CHECK (vehicle_size IN ('normal', 'large')),
  -- false = non-rolling; only crane drivers are matched to these orders
  can_roll BOOLEAN NOT NULL DEFAULT true,
  price DECIMAL(10, 2),
  status VARCHAR(30) DEFAULT 'pending',
  -- pending, accepted, in_progress, completed, cancelled
  created_at TIMESTAMPTZ DEFAULT NOW(),
  accepted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancel_reason TEXT,

  -- 'telegram' = ordered via passenger bot, 'phone' = operator entered manually
  source VARCHAR(10) NOT NULL DEFAULT 'telegram' CHECK (source IN ('telegram', 'phone')),
  -- phone number typed by admin for walk-in/phone orders (source='phone' only)
  caller_phone TEXT,

  -- Ratings: stored together on the order so admin sees everything,
  -- but queries expose only the correct subset per role (see orderService).
  -- driver_rating: score the passenger gave the driver (1-5)
  -- passenger_rating: score the driver gave the passenger (1-5)
  driver_rating   SMALLINT CHECK (driver_rating   BETWEEN 1 AND 5),
  passenger_rating SMALLINT CHECK (passenger_rating BETWEEN 1 AND 5)
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_passenger ON orders(passenger_id);
CREATE INDEX IF NOT EXISTS idx_orders_driver ON orders(driver_id);
