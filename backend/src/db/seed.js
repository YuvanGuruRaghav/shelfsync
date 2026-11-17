import config from "../config.js";
import { pool, withTransaction } from "./pool.js";
import { migrate } from "./migrate.js";

/**
 * Dev seed: 5 stores in 5 cities, 40 products across 5 categories,
 * varied per-store stock (a few deliberately low so alerts fire).
 */

const stores = [
  { name: "ShelfSync Koramangala", city: "Bengaluru" },
  { name: "ShelfSync Andheri", city: "Mumbai" },
  { name: "ShelfSync Connaught Place", city: "Delhi" },
  { name: "ShelfSync T. Nagar", city: "Chennai" },
  { name: "ShelfSync Banjara Hills", city: "Hyderabad" },
];

const products = [
  // Electronics
  ["Noise-Cancelling Bluetooth Headphones", "Over-ear wireless headphones with 40h battery and active noise cancellation.", "Electronics", 8999, 6],
  ["True Wireless Earbuds Pro", "Bluetooth 5.3 earbuds with ANC, wireless charging case and IPX5 rating.", "Electronics", 4499, 5],
  ["Smart Watch Series 6", "AMOLED fitness watch with SpO2, heart-rate and 7-day battery.", "Electronics", 6499, 4],
  ["65W GaN Fast Charger", "Compact 3-port charger for laptops, tablets and phones.", "Electronics", 2199, 8],
  ["1080p Webcam with Ring Light", "Plug-and-play USB webcam with dual mics for calls and streaming.", "Electronics", 3299, 5],
  ["Portable 20000mAh Power Bank", "Dual output power bank with 22.5W fast charging.", "Electronics", 1899, 7],
  ["Mechanical Keyboard TKL", "Hot-swappable brown switches, RGB backlight, wired and Bluetooth.", "Electronics", 5499, 5],
  ["27-inch 4K IPS Monitor", "Colour-accurate 4K display with USB-C 90W power delivery.", "Electronics", 27999, 3],
  // Audio
  ["Bluetooth Party Speaker", "30W portable speaker with deep bass and 12h playtime.", "Audio", 5999, 6],
  ["Soundbar 2.1 Channel", "Cinema soundbar with wireless subwoofer and HDMI ARC.", "Audio", 11999, 4],
  ["Studio Condenser Microphone", "Cardioid USB microphone for podcasts and voiceover.", "Audio", 4599, 5],
  ["Vinyl Turntable Classic", "Belt-driven turntable with built-in preamp and Bluetooth out.", "Audio", 15999, 2],
  ["In-Ear Wired Earphones", "Braided cable, balanced sound, in-line mic.", "Audio", 799, 10],
  ["Bookshelf Speakers Pair", "50W powered speakers with optical and Bluetooth inputs.", "Audio", 13999, 4],
  ["DJ Controller Starter", "2-channel controller with jog wheels and Serato Lite.", "Audio", 18999, 3],
  ["Gaming Headset 7.1", "Surround sound headset with detachable boom mic.", "Audio", 3799, 6],
  // Home
  ["Cast Iron Skillet 10 inch", "Pre-seasoned skillet, oven and induction safe.", "Home", 2499, 5],
  ["Stainless Steel Cookware Set", "5-piece triply cookware set with tempered lids.", "Home", 7499, 3],
  ["Memory Foam Mattress Queen", "7-zone memory foam mattress with breathable cover.", "Home", 18999, 2],
  ["Robot Vacuum with Mop", "LiDAR navigation, auto-recharge and app scheduling.", "Home", 24999, 3],
  ["Air Purifier HEPA 13", "Covers 600 sq ft, real-time PM2.5 display.", "Home", 10999, 4],
  ["Cotton Bedsheet Set King", "300 thread count sateen bedsheet with two pillow covers.", "Home", 1999, 9],
  ["Ceramic Dinner Set 18 Piece", "Microwave and dishwasher safe stoneware set.", "Home", 3499, 6],
  ["Espresso Machine Compact", "15-bar pump espresso maker with steam wand.", "Home", 15999, 3],
  // Fashion
  ["Running Shoes Airflow", "Breathable mesh running shoes with responsive cushioning.", "Fashion", 3999, 7],
  ["Denim Jacket Classic", "Mid-wash denim jacket in stretch cotton.", "Fashion", 2799, 5],
  ["Leather Wallet Slim", "Full-grain leather wallet with RFID blocking.", "Fashion", 1299, 8],
  ["Cotton Oversized T-Shirt", "240 GSM combed cotton tee, unisex fit.", "Fashion", 799, 12],
  ["Analog Watch Minimal", "Sapphire glass, 40mm case, leather strap.", "Fashion", 5999, 4],
  ["Backpack 30L Laptop", "Water-resistant backpack fits 16-inch laptops.", "Fashion", 2999, 6],
  ["Polarised Sunglasses", "UV400 polarised lenses with lightweight frame.", "Fashion", 1699, 9],
  ["Chino Trousers Slim", "Stretch cotton chinos for everyday wear.", "Fashion", 1899, 7],
  // Sports
  ["Yoga Mat 6mm", "Anti-slip TPE mat with alignment lines and carry strap.", "Sports", 1299, 8],
  ["Adjustable Dumbbell 24kg", "Dial-adjust dumbbell replacing 15 weight settings.", "Sports", 8999, 3],
  ["Resistance Band Set", "Five latex bands with door anchor and handles.", "Sports", 699, 10],
  ["Cycling Helmet Aero", "In-mould helmet with 18 vents and dial fit.", "Sports", 3499, 5],
  ["Badminton Racket Carbon", "Graphite frame, pre-strung, includes cover.", "Sports", 2799, 6],
  ["Foam Roller Grid", "High-density roller for recovery and mobility.", "Sports", 999, 9],
  ["Trekking Poles Aluminium", "Adjustable anti-shock poles, pair.", "Sports", 2199, 4],
  ["Cricket Bat Kashmir Willow", "Grade-A willow bat with protective toe guard.", "Sports", 3199, 5],
];

// Deterministic pseudo-random stock so the seed is reproducible.
function stockFor(productIndex, storeIndex) {
  const hash = (productIndex * 7 + storeIndex * 13 + 3) % 17;
  if (hash < 2) return 0; // out of stock in this city
  if (hash < 5) return hash; // low
  return hash * 3;
}

const force = process.argv.includes("--force");

function guardDestructiveSeed() {
  if (force) return;
  const reasons = [];
  if (config.databaseSsl) reasons.push("DATABASE_SSL=true");
  if (config.nodeEnv === "production") reasons.push("NODE_ENV=production");
  if (reasons.length === 0) return;

  console.error(
    `Refusing to seed: this script TRUNCATEs all tables (destructive) and ${reasons.join(" and ")}.\n` +
      "Re-run with --force if you really mean to wipe this database: npm run seed -- --force",
  );
  process.exit(1);
}

export async function seed() {
  guardDestructiveSeed();
  await migrate();

  await withTransaction(async (client) => {
    await client.query(
      "TRUNCATE alerts, processed_events, outbox, order_items, orders, reservations, cart_items, carts, customers, store_stock, products, stores RESTART IDENTITY CASCADE",
    );

    const storeIds = [];
    for (const store of stores) {
      const { rows } = await client.query(
        "INSERT INTO stores (name, city) VALUES ($1, $2) RETURNING id",
        [store.name, store.city],
      );
      storeIds.push(rows[0].id);
    }

    for (const [name, description, category, price, threshold] of products) {
      const { rows } = await client.query(
        `INSERT INTO products (name, description, category, price, image_url, low_stock_threshold)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [name, description, category, price, null, threshold],
      );
      const productId = rows[0].id;
      for (let s = 0; s < storeIds.length; s += 1) {
        await client.query(
          "INSERT INTO store_stock (product_id, store_id, stock, reserved) VALUES ($1, $2, $3, 0)",
          [productId, storeIds[s], stockFor(productId, s)],
        );
      }
    }

    // Open an alert for every row already at or below its low-stock threshold.
    // The partial unique index on OPEN alerts makes this safe on a re-run.
    await client.query(
      `INSERT INTO alerts (product_id, store_id, stock_level, status)
       SELECT ss.product_id, ss.store_id, ss.stock - ss.reserved, 'OPEN'
       FROM store_stock ss
       JOIN products p ON p.id = ss.product_id
       WHERE ss.stock - ss.reserved <= p.low_stock_threshold
       ON CONFLICT DO NOTHING`,
    );
  });

  const { rows } = await pool.query(
    "SELECT (SELECT count(*) FROM stores) AS stores, (SELECT count(*) FROM products) AS products, (SELECT count(*) FROM store_stock) AS stock_rows, (SELECT count(*) FROM alerts WHERE status = 'OPEN') AS open_alerts",
  );
  console.log(
    `Seeded ${rows[0].stores} stores, ${rows[0].products} products, ${rows[0].stock_rows} stock rows, ${rows[0].open_alerts} open alerts.`,
  );
}

seed()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    pool.end();
    process.exit(1);
  });
