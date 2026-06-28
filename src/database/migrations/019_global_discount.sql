INSERT INTO app_config (key, value) VALUES ('global_discount_amount', '0') ON CONFLICT (key) DO NOTHING;
INSERT INTO app_config (key, value) VALUES ('global_discount_until',  '')  ON CONFLICT (key) DO NOTHING;
