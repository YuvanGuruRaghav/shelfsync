-- ShelfSync schema. Idempotent: safe to run on every boot / seed.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS stores (
  id serial PRIMARY KEY,
  name text NOT NULL,
  city text NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id serial PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  category text NOT NULL,
  price numeric(10, 2) NOT NULL CHECK (price >= 0),
  image_url text,
  low_stock_threshold integer NOT NULL DEFAULT 5 CHECK (low_stock_threshold >= 0)
);

-- Per-store inventory. available = stock - reserved.
CREATE TABLE IF NOT EXISTS store_stock (
  product_id integer NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  store_id integer NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  stock integer NOT NULL DEFAULT 0 CHECK (stock >= 0),
  reserved integer NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  PRIMARY KEY (product_id, store_id),
  CHECK (reserved <= stock)
);

CREATE TABLE IF NOT EXISTS carts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id text NOT NULL,
  store_id integer NOT NULL REFERENCES stores(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, store_id)
);

CREATE TABLE IF NOT EXISTS cart_items (
  cart_id uuid NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  product_id integer NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  qty integer NOT NULL CHECK (qty > 0),
  PRIMARY KEY (cart_id, product_id)
);

CREATE TABLE IF NOT EXISTS reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id uuid NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  product_id integer NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  store_id integer NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  qty integer NOT NULL CHECK (qty > 0),
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CONSUMED', 'EXPIRED')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customers (
  id serial PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL,
  phone text
);

CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id integer NOT NULL REFERENCES customers(id),
  store_id integer NOT NULL REFERENCES stores(id),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'CONFIRMED', 'REJECTED')),
  fulfilment text NOT NULL CHECK (fulfilment IN ('pickup', 'delivery')),
  total numeric(12, 2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_items (
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id integer NOT NULL REFERENCES products(id),
  qty integer NOT NULL CHECK (qty > 0),
  price numeric(10, 2) NOT NULL,
  PRIMARY KEY (order_id, product_id)
);

-- Transactional outbox. event_id is the stable id consumers use for idempotency.
CREATE TABLE IF NOT EXISTS outbox (
  id bigserial PRIMARY KEY,
  event_id uuid NOT NULL DEFAULT gen_random_uuid(),
  topic text NOT NULL,
  key text,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);

CREATE TABLE IF NOT EXISTS processed_events (
  consumer text NOT NULL,
  event_id uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);

CREATE TABLE IF NOT EXISTS alerts (
  id serial PRIMARY KEY,
  product_id integer NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  store_id integer NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  stock_level integer NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- --- Section 3.1 schema deltas (idempotent, safe to re-run) ---

-- One cart per session (in addition to the original composite uniqueness).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'carts_session_id_key') THEN
    ALTER TABLE carts ADD CONSTRAINT carts_session_id_key UNIQUE (session_id);
  END IF;
END $$;

-- Checkout idempotency (nullable, so existing orders are unaffected).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS orders_idempotency_key_key ON orders (idempotency_key);

-- Only one OPEN alert per (product, store).
CREATE UNIQUE INDEX IF NOT EXISTS alerts_open_unique_idx ON alerts (product_id, store_id) WHERE status = 'OPEN';

-- Only one ACTIVE reservation per (cart, product).
CREATE UNIQUE INDEX IF NOT EXISTS reservations_active_unique_idx ON reservations (cart_id, product_id) WHERE status = 'ACTIVE';

-- Relay polls by created_at, oldest first.
CREATE INDEX IF NOT EXISTS outbox_unpublished_created_at_idx ON outbox (created_at) WHERE published_at IS NULL;

-- Explicit combined stock invariant from section 3.1.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'store_stock_levels_check') THEN
    ALTER TABLE store_stock ADD CONSTRAINT store_stock_levels_check
      CHECK (stock >= 0 AND reserved >= 0 AND reserved <= stock);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS products_name_trgm ON products USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS products_description_trgm ON products USING gin (description gin_trgm_ops);
CREATE INDEX IF NOT EXISTS products_category_idx ON products (category);
CREATE INDEX IF NOT EXISTS outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;
CREATE INDEX IF NOT EXISTS reservations_active_idx ON reservations (expires_at) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS alerts_open_idx ON alerts (status, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_store_idx ON orders (store_id, created_at DESC);
