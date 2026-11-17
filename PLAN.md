# ShelfSync: event-driven online store (Aiven hackathon, Team_Ultron)

Tagline: Every shelf, every city, always in sync.

> This file is the single source of truth. AI coding agents must read it first, follow it exactly,
> and must not rename tables, columns, topics, endpoints or env vars without it being changed here first.

---

## 1. Stack

- Frontend: Next.js 15 (App Router) + Tailwind CSS v4, mobile-first, lean pages
- Backend: Node.js + Express REST API in `/backend`
- DB: PostgreSQL 18 (local native install now; Aiven later, only `DATABASE_URL` + SSL change)
- Events: Kafka later (Aiven). Now: outbox relay with a log provider (same interface)
- Search: OpenSearch later (Aiven). Now: Postgres `pg_trgm` fuzzy search (same interface)
- Deploy: Render (backend) + Vercel (frontend), env-var secrets only, TLS-capable config

## 2. Architecture

Browser -> routes (thin) -> services (logic) -> db / providers

- Routes only parse input, call one service, shape the response. No business logic in routes.
- Services own all business rules and transactions (`withTransaction` from `db/pool.js`).
- `providers/publisher`: `EVENT_PROVIDER=log|kafka`, same interface
- `providers/search`: `SEARCH_PROVIDER=postgres|opensearch`, same interface
- Never import `kafkajs` or the OpenSearch client outside `providers/`.
- Never call a provider from inside a DB transaction. Write an outbox row instead.

### 2.1 Provider interfaces

Publisher:
- `publish(topic, key, payload, eventId)` : used only by the outbox relay
- `subscribe(topic, groupId, handler)` : used by consumers; `handler({ eventId, topic, key, payload })` returns a promise
- `log` provider: logs each event, then dispatches in-process to subscribed handlers, so consumers
  work end to end with no Kafka. `kafka` provider: real producer plus consumer groups. `eventId` travels
  as the `eventId` message header.

Search:
- `search({ q, storeId, category, minPrice, maxPrice, limit })` : returns ready-to-serve items in the
  browse shape plus `score` (section 6). The provider resolves the store's city itself for ranking.
- `indexProduct(productId)` / `removeProduct(productId)` : used by the search-index consumer
- `postgres` provider: indexing is a no-op (queries live tables). `opensearch` provider: real index.

## 3. Database (schema.sql, implemented)

```
stores(id, name, city)
products(id, name, description, category, price, image_url, low_stock_threshold)
store_stock(product_id, store_id, stock, reserved)   -- available = stock - reserved
carts(id, session_id, store_id, created_at); cart_items(cart_id, product_id, qty)
reservations(id, cart_id, product_id, store_id, qty, expires_at, status[ACTIVE|CONSUMED|EXPIRED])
customers(id, name, email, phone)
orders(id, customer_id, store_id, status[PENDING|CONFIRMED|REJECTED], fulfilment[pickup|delivery], total, created_at)
order_items(order_id, product_id, qty, price)
outbox(id, event_id uuid, topic, key, payload jsonb, created_at, published_at)
processed_events(consumer, event_id, processed_at)   -- idempotency
alerts(id, product_id, store_id, stock_level, status[OPEN|RESOLVED], created_at)
```

### 3.1 Schema deltas (apply to schema.sql if not already present)

- `orders.idempotency_key text UNIQUE` (nullable)
- `carts`: UNIQUE `(session_id)`, so there is one cart per session
- `alerts`: partial UNIQUE `(product_id, store_id) WHERE status='OPEN'`
- `reservations`: UNIQUE `(cart_id, product_id) WHERE status='ACTIVE'`
- `outbox`: partial index on `created_at WHERE published_at IS NULL`
- `store_stock`: CHECK `(stock >= 0 AND reserved >= 0 AND reserved <= stock)`

### 3.2 Domain notes

- One store per city, so "city" and "store" are the same thing in the UI. API calls take `store_id`.
- Prices are stored and returned exactly as defined in `schema.sql`. The frontend formats them.
- `customers` are upserted by email at checkout. There are no user accounts.
- `orders` are created as `CONFIRMED` (mock payment). `PENDING` and `REJECTED` are reserved for later;
  a failed checkout returns 409 and writes no order.

## 4. Core rules

1. **Oversell-proof checkout.** One transaction does: stock decrement, order + items, reservation
   consumption, outbox rows, alert check. See 4.1.
2. **Cart reservations (10 min).** Adding or changing a cart line atomically adjusts `reserved`. See 4.2.
3. **Outbox relay worker.** Polls unpublished outbox rows (`ORDER BY created_at`, `FOR UPDATE SKIP LOCKED`,
   batch of 50), publishes via the publisher provider, then sets `published_at`. At-least-once delivery,
   so consumers must be idempotent.
4. **Consumers** (idempotent, see 4.4): notification (mock email/SMS log), search-index sync,
   live-stock pusher (SSE).
5. **Low-stock alerts are SYSTEM-generated** inside the inventory logic, in the same transaction that
   drops `available` to `low_stock_threshold` or below. They do not depend on Kafka. See 4.3.
6. **Search:** typo-tolerant ("blutooth"), Hinglish synonyms ("sasta"), filters for category, price and city,
   city-aware ranking. See 4.5.
7. **Live stock badges:** "Only 2 left in Bengaluru", updated live via SSE from `inventory.changed`.

### 4.1 Checkout (rule 1, precise)

Inputs: session cart, customer `{name, email, phone}`, fulfilment, optional `Idempotency-Key`.

In ONE transaction:
1. If `Idempotency-Key` matches an existing order, return that order (HTTP 200) and stop.
2. Lock the cart row (`FOR UPDATE`) and load its items.
3. For each item, in `product_id` order (prevents deadlocks):
   - If the cart has an ACTIVE, unexpired reservation for the item, consume it:
     `UPDATE store_stock SET stock=stock-$qty, reserved=reserved-$qty
      WHERE product_id=$p AND store_id=$s AND stock>=$qty AND reserved>=$qty`
     and set the reservation to CONSUMED.
   - Otherwise (hold expired or missing), take a direct decrement:
     `UPDATE store_stock SET stock=stock-$qty
      WHERE product_id=$p AND store_id=$s AND stock-reserved>=$qty`
   - If 0 rows are updated: roll back the whole transaction and return 409 `OUT_OF_STOCK`
     listing the failing items.
4. Upsert customer, insert order (CONFIRMED) + order_items (price snapshot), compute total.
5. For each affected `(product, store)`: insert an `inventory.changed` outbox row and run the alert check (4.3).
6. Insert one `order.placed` outbox row.
7. Delete the cart and its items.

### 4.2 Reservations (rule 2, precise)

- `PUT /api/cart/items {product_id, qty}` sets the line quantity (set semantics, safe to retry).
  Compute `delta = newQty - oldQty` and run, in a transaction:
  `UPDATE store_stock SET reserved=reserved+$delta WHERE product_id=$p AND store_id=$s AND stock-reserved>=$delta`
  If 0 rows are updated, return 409 `INSUFFICIENT_STOCK` with the current available count.
  A negative delta releases stock (always succeeds).
- Upsert the ACTIVE reservation row with the new qty. Any cart change refreshes `expires_at` to now + 10 min
  for all of that cart's ACTIVE reservations.
- Removing a line (qty 0 or DELETE) releases its reservation (status EXPIRED, `reserved` decremented).
- Clearing the cart, or switching city, releases all holds.
- Every reserve or release writes an `inventory.changed` outbox row (`reason` RESERVE or RELEASE).
- **Expiry worker** (every 30s): select ACTIVE reservations with `expires_at < now()` using
  `FOR UPDATE SKIP LOCKED`, set EXPIRED, decrement `reserved`, write `inventory.changed` (`reason` EXPIRE).
  Cart items stay, so the shopper sees the cart but must re-reserve at checkout, which falls back to
  the direct decrement in 4.1.

### 4.3 Low-stock alerts (rule 5, precise)

After any change to a `store_stock` row, inside the same transaction:
- `available = stock - reserved`
- If `available <= low_stock_threshold` and no OPEN alert exists for `(product, store)`:
  insert an OPEN alert with `stock_level = available`.
- If `available > low_stock_threshold` and an OPEN alert exists: set it RESOLVED.

### 4.4 Idempotent consumers

Each consumer, per event: `INSERT INTO processed_events(consumer, event_id) ... ON CONFLICT DO NOTHING`
in the same transaction as its side effects (where it has DB side effects). If 0 rows were inserted,
skip. Consumer names: `notification`, `search-index`, `live-stock`.

### 4.5 Search and ranking (rule 6, precise)

- Normalise the query: lowercase, trim, expand Hinglish synonyms (small map in `providers/search/`, e.g.
  `sasta -> cheap/budget`, `bijli -> electric`). Synonym mapping lives in the search provider only.
- Typo tolerance via `pg_trgm` (`similarity` / `%` operator) on name, description and category.
- Filters: `category`, `min_price`, `max_price`. City filter is expressed through `store_id`.
- Ranking: `score = text_relevance + in_stock_in_store_boost (+ small bonus for low price)`.
  Products with `available > 0` in the shopper's store rank above those that are not.
  Products out of stock in the shopper's city are still returned, flagged with the cities that have stock.

## 5. Events

Envelope: the outbox row `event_id` (uuid) is the **event id** (used for idempotency and stored in
`processed_events`). It travels as the `eventId` Kafka message header; the row's bigserial `id` is only a
storage key. Kafka message key and payloads:

| Topic | Key | Payload |
|---|---|---|
| `order.placed` | `order_id` | `{ order_id, store_id, city, fulfilment, total, customer:{name,email,phone}, items:[{product_id,name,qty,price}], placed_at }` |
| `inventory.changed` | `product_id:store_id` | `{ product_id, store_id, city, stock, reserved, available, low_stock_threshold, reason, changed_at }` where `reason` is one of `ORDER, RESERVE, RELEASE, EXPIRE, RESTOCK` |
| `product.updated` | `product_id` | `{ product_id, name, description, category, price, image_url, low_stock_threshold, updated_at }` |

Consumers:
- `notification`: subscribes to `order.placed`. Logs a mock email/SMS.
- `search-index`: subscribes to `product.updated`. Calls `indexProduct`.
- `live-stock`: subscribes to `inventory.changed`. Pushes to connected SSE clients for that `store_id`.

## 6. API contract

All JSON. Errors: `{ "error": { "code": "OUT_OF_STOCK", "message": "..." } }` with sensible HTTP status.
Cart and checkout require header `X-Session-Id` (client-generated UUID). Admin routes require `X-Admin-Key`
(must equal env `ADMIN_KEY`).

### Public

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | `{ ok: true }` |
| GET | `/api/stores` | `[{ id, name, city }]` |
| GET | `/api/categories` | `["Audio", ...]` — distinct, sorted |
| GET | `/api/products?store_id&category&min_price&max_price&limit&offset` | browse: `{ items, total, limit, offset }` |
| GET | `/api/products/:id?store_id` | product + `available` + `low` for the store + `availability` per store |
| GET | `/api/search?q&store_id&category&min_price&max_price&limit` | `{ items }` — same item shape plus `score` |
| GET | `/api/cart` | cart with lines, line prices, total, `expires_at` of earliest hold |
| PUT | `/api/cart/items` | body `{ product_id, qty, store_id }`; `qty` 0 removes. 409 `INSUFFICIENT_STOCK` / `CART_STORE_MISMATCH` |
| DELETE | `/api/cart/items/:product_id` | remove one line |
| DELETE | `/api/cart` | clear cart (used when switching city) |
| POST | `/api/checkout` | body `{ customer:{name,email,phone}, fulfilment }`, optional `Idempotency-Key` header. Returns the order. 409 `OUT_OF_STOCK` |
| GET | `/api/orders/:id` | order + items + status |
| GET | `/api/stream/stock?store_id` | SSE. Event `stock`, data `{ product_id, store_id, available, low }` |

**Item shape** (browse and search):

```
{ id, name, description, category, price, image_url, available, low, score? }
```

- `price` is a JSON number, not a string. `low = available <= products.low_stock_threshold`.
- With `store_id`: `available = stock - reserved` at that store. Without it: `available` is the total
  across all stores and `low` is `false`.
- Browse order: in stock at the store first, then `id`. `limit` defaults to 20 (max 100), `offset` to 0.
- `GET /api/products/:id` adds `availability: [{ store_id, city, available }]` for every store.
- Search ranking: text relevance, in-stock-in-the-shopper's-city first; price-intent words (`sasta`)
  sort cheapest first.
- Errors: `400 BAD_REQUEST` (bad query params), `400 INVALID_STORE` (unknown `store_id`),
  `404 PRODUCT_NOT_FOUND`.

### Admin (`X-Admin-Key`)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/admin/alerts?status=OPEN` | alerts with product and city names |
| GET | `/api/admin/events?limit=50` | recent outbox rows with published state (frontend polls every 3s for the live feed) |
| POST | `/api/admin/stock` | body `{ product_id, store_id, add }`; restocks, writes `inventory.changed` (`RESTOCK`), resolves alerts |
| PATCH | `/api/admin/products/:id` | edits product fields, writes `product.updated` |

Cart rule: a cart belongs to one store. Adding an item for a different `store_id` than the cart's returns
409 `CART_STORE_MISMATCH`. The frontend then asks the shopper to clear the cart (`DELETE /api/cart`) and retries.

## 7. Frontend

- Pages: `/` (home + city selector), `/search`, `/product/[id]`, `/cart`, `/checkout` (pickup or delivery),
  `/orders/[id]` (status), `/admin` (alerts + live event feed + restock)
- `lib/api.js`: single API client. Reads `NEXT_PUBLIC_API_URL`, attaches `X-Session-Id` (and `X-Admin-Key`
  on admin calls), normalises errors.
- Session id: UUID created once, stored in `localStorage`. Selected city/store: stored in `localStorage`,
  exposed through a small context, defaulting to Bengaluru.
- Live badges: a hook subscribes to `/api/stream/stock?store_id=` and updates product badges. Reconnects
  automatically. Badge text: "Only N left in <city>" when `low`, "Out of stock in <city>" when 0.
- Admin: key entered once and kept in `sessionStorage`.
- Keep it lean: no state library, no UI kit, server components where possible.

## 8. Environment variables (`.env.example`)

```
PORT=4000
DATABASE_URL=postgres://shelfsync:shelfsync@localhost:5432/shelfsync
DATABASE_SSL=false
EVENT_PROVIDER=log            # log | kafka
SEARCH_PROVIDER=postgres      # postgres | opensearch
RESERVATION_TTL_MINUTES=10
RESERVATION_EXPIRY_INTERVAL_MS=30000
OUTBOX_RELAY_INTERVAL_MS=1000
ADMIN_KEY=change-me
CORS_ORIGIN=http://localhost:3000
# Kafka (Aiven), used when EVENT_PROVIDER=kafka
# KAFKA_BROKERS=
# KAFKA_SSL=true
# KAFKA_SASL_USERNAME=
# KAFKA_SASL_PASSWORD=
# KAFKA_SASL_MECHANISM=plain
# KAFKA_SSL_CA=
# KAFKA_SSL_CERT=
# KAFKA_SSL_KEY=
# OpenSearch (Aiven), used when SEARCH_PROVIDER=opensearch
# OPENSEARCH_URL=
frontend: NEXT_PUBLIC_API_URL=http://localhost:4000
```

## 9. Seed

5 stores (Bengaluru, Mumbai, Delhi, Chennai, Hyderabad), ~40 products across 5 categories, varied stock per
store, some low (at or under threshold), at least one product at 0 in a single city. Names include
search test cases (bluetooth earphones, budget items). Open alerts created for rows already low.
`seed.js` is re-runnable without duplicates.

## 10. Project structure

```
shelfsync/
  frontend/  (app/, components/, lib/)
  backend/src/ server.js, config.js, routes/, services/, providers/{publisher,search}/,
               consumers/, workers/{outboxRelay,reservationExpiry}.js, db/{pool.js,schema.sql,migrate.js,seed.js}
  .env.example, .gitignore, README.md, PLAN.md
```

`server.js` mounts routes, starts both workers and registers consumers on boot.
Backend scripts: `dev`, `start`, `migrate`, `seed`, `db:reset`.

## 11. Build order (one agent prompt per step)

1. Scaffolding
2. Schema + seed
3. Fix pass: `pg` dependency, npm scripts, usable `.env.example`, real `.env`, boot check
4. Catalog + search endpoints (`stores`, `categories`, `products`, `search`)
5. Cart + reservations (4.2)
6. Checkout + orders + alerts (4.1, 4.3)
7. Workers + publisher provider + consumers + SSE (outbox relay, expiry, notification, search-index, live-stock)
8. Admin endpoints
9. Frontend `lib/` + home, search, product (with live badges)
10. Frontend cart, checkout, orders, admin
11. README + Render/Vercel deploy settings (Kafka/OpenSearch providers switched by env vars)

Commit to git after every step.

## 12. Verification checklist (run after the relevant step)

- Boot: local PostgreSQL 18 running, `npm run migrate`, `npm run seed`, `npm run dev`, `GET /api/health` returns ok.
- Concurrency: with stock 1, two simultaneous checkouts (or cart adds) for the same item: exactly one succeeds.
- Reservation: add to cart, `reserved` goes up; wait past TTL, expiry worker releases it and an
  `inventory.changed` row appears.
- Own hold: a shopper with a live reservation can check out (their hold is consumed, not double counted).
- Idempotency: the same `Idempotency-Key` twice returns the same order, stock decremented once.
- Alerts: dropping `available` to the threshold creates exactly one OPEN alert; restock resolves it.
- Outbox: rows get `published_at`; killing the relay mid-run and restarting loses no events.
- Consumers: replaying the same event id does not repeat the side effect.
- Search: "blutooth" finds bluetooth products; "sasta" returns cheaper items; in-stock-in-city ranks first.
- SSE: a checkout in one browser updates the badge in another within a second or two.

## 13. Demo flow (presentation script)

Pick Bengaluru, search "blutooth", see "Only 2 left in Bengaluru", add to cart (stock reserved live),
check out, watch the badge update in a second window, open `/admin` to see the new low-stock alert and the
`order.placed` / `inventory.changed` events flowing, restock from admin and watch the alert resolve.
Finish by showing the same code running against Aiven Kafka and OpenSearch via env vars.

## 14. Rules for AI coding agents

- Read this file first. Follow it exactly. Do not rename anything defined here.
- Do only the requested step. No extra features, no unrelated refactors.
- Respect the layering. No business logic in routes. No Kafka/OpenSearch imports outside `providers/`.
- Add a dependency only if the step needs it, and declare it in `package.json`.
- Never hardcode secrets. Everything configurable goes through `config.js` and env vars.
- After finishing, run the relevant checks from section 12 and report the real output. Do not claim success
  without running them.
- If this plan conflicts with the code or is ambiguous, stop and say so rather than guessing.

## Progress

- [x] Step 1: Scaffolding (layout, config, frontend bootstrap, providers skeleton)
- [x] Step 2: Schema + seed (verify against section 3.1 deltas)
- [x] Step 3: Fix pass (`pg`, scripts, `.env`)
- [x] Step 3b: Corrections (seed guard + open alerts, CORS/404/error middleware, health payload,
      publisher `subscribe` for log + Kafka, config/env for Kafka SASL, PLAN/docs cleanup)
- [x] Step 4: Catalog + search endpoints (`stores`, `categories`, `products`, `search`)
- [ ] Step 5 onward: not started