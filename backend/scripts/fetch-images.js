import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { slugify } from "../src/db/seed.js";

/**
 * ONE-TIME script: build the demo catalog from real dummyjson.com products.
 *
 * Picks 40 products (8 per category) with their photos, downloads each photo to
 * frontend/public/products/<slug>.<ext>, prunes files that are no longer used and
 * writes backend/src/db/catalog.json — the source of truth for `npm run seed`.
 *
 * Run with `npm run images:fetch`. Not part of seed or boot. Existing files are
 * skipped, and a single bad download never stops the run.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "../../frontend/public/products");
const catalogFile = path.resolve(here, "../src/db/catalog.json");

const ALL_PRODUCTS_URL = "https://dummyjson.com/products?limit=0";
const TIMEOUT_MS = 20000;
const PER_CATEGORY = 8;

const EXTENSION_BY_TYPE = {
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/avif": "avif",
};
const IMAGE_EXTENSIONS = new Set([...Object.values(EXTENSION_BY_TYPE), "jpeg"]);

// Audio products are spread across DummyJSON's accessory categories, so they are
// matched by title instead of by category.
const AUDIO_TITLE = /earphone|earbud|airpod|headphone|speaker|homepod|echo/i;

// 8 picks per own category: primary DummyJSON categories first, then the closest
// related ones as fill when a primary pool runs dry (or is already used).
const CATEGORY_RULES = {
  Audio: {
    matchTitle: AUDIO_TITLE,
    fill: ["mobile-accessories", "laptops", "tablets"],
  },
  Electronics: {
    categories: ["smartphones", "laptops", "tablets", "mobile-accessories"],
    fill: ["smartphones", "laptops", "tablets", "mobile-accessories"],
  },
  Fashion: {
    categories: ["mens-shirts", "womens-dresses", "mens-shoes", "womens-bags", "sunglasses", "mens-watches"],
    fill: ["womens-shoes", "womens-watches", "tops", "womens-jewellery"],
  },
  Home: {
    categories: ["furniture", "home-decoration", "kitchen-accessories"],
    fill: ["groceries", "furniture", "home-decoration", "kitchen-accessories"],
  },
  Sports: {
    categories: ["sports-accessories"],
    fill: ["motorcycle"],
  },
};

async function getJson(url) {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function byTitle(a, b) {
  return a.title.localeCompare(b.title);
}

/** Round-robin over pools so a category is never dominated by one DummyJSON category. */
function pickRoundRobin(pools, count, used) {
  const picked = [];

  let progressed = true;
  while (picked.length < count && progressed) {
    progressed = false;
    for (const pool of pools) {
      if (picked.length >= count) break;
      const next = pool.find((product) => !used.has(product.id));
      if (!next) continue;
      used.add(next.id);
      picked.push(next);
      progressed = true;
    }
  }
  return picked;
}

/** Walk the related categories in order, taking from the first one that still has items. */
function pickSequential(pools, count, used) {
  const picked = [];
  for (const pool of pools) {
    for (const product of pool) {
      if (picked.length >= count) return picked;
      if (used.has(product.id)) continue;
      used.add(product.id);
      picked.push(product);
    }
  }
  return picked;
}

function pickForCategory(rule, allProducts, used) {
  const filledFrom = [];
  const result = [];

  if (rule.matchTitle) {
    const matched = allProducts.filter((product) => rule.matchTitle.test(product.title)).sort(byTitle);
    result.push(...pickRoundRobin([matched], PER_CATEGORY, used));
  }

  const pools = (rule.categories ?? []).map((category) =>
    allProducts.filter((product) => product.category === category).sort(byTitle),
  );

  if (result.length < PER_CATEGORY) {
    result.push(...pickRoundRobin(pools, PER_CATEGORY - result.length, used));
  }

  if (result.length < PER_CATEGORY) {
    const fillPools = rule.fill.map((category) =>
      allProducts.filter((product) => product.category === category).sort(byTitle),
    );
    const filler = pickSequential(fillPools, PER_CATEGORY - result.length, used);
    result.push(...filler);
    for (const product of filler) {
      if (!filledFrom.includes(product.category)) filledFrom.push(product.category);
    }
  }

  return { picked: result, filledFrom };
}

function pickExtension(imageUrl, contentType) {
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (EXTENSION_BY_TYPE[type]) return EXTENSION_BY_TYPE[type];
  const urlExtension = path.extname(new URL(imageUrl).pathname).slice(1).toLowerCase();
  if (IMAGE_EXTENSIONS.has(urlExtension)) return urlExtension === "jpeg" ? "jpg" : urlExtension;
  return "jpg";
}

/** Downloads the photo as `<slug>.<original extension>`. */
async function saveImage(imageUrl, slug) {
  const res = await fetch(imageUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`image download failed: HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length === 0) throw new Error("image download was empty");

  const fileName = `${slug}.${pickExtension(imageUrl, res.headers.get("content-type"))}`;
  await writeFile(path.join(publicDir, fileName), buffer);
  return fileName;
}

function inrPrice(usdPrice) {
  return Math.max(99, Math.round(Number(usdPrice) * 85));
}

async function main() {
  await mkdir(publicDir, { recursive: true });

  const data = await getJson(ALL_PRODUCTS_URL);
  const allProducts = Array.isArray(data?.products) ? data.products : [];
  if (allProducts.length === 0) throw new Error("DummyJSON returned no products");

  const used = new Set();
  const picks = [];

  const perCategory = {};
  for (const [category, rule] of Object.entries(CATEGORY_RULES)) {
    const { picked, filledFrom } = pickForCategory(rule, allProducts, used);
    perCategory[category] = { count: picked.length, filledFrom };
    for (const product of picked) picks.push({ product, category });
  }

  const existingBySlug = new Map();
  for (const file of await readdir(publicDir)) {
    const { name, ext } = path.parse(file);
    if (ext && IMAGE_EXTENSIONS.has(ext.slice(1).toLowerCase()) && !existingBySlug.has(name)) {
      existingBySlug.set(name, file);
    }
  }

  const catalog = [];
  const usedFiles = new Set();
  const failures = [];
  let downloaded = 0;
  let skipped = 0;

  for (const { product, category } of picks) {
    const slug = slugify(product.title);
    const imageSource = product.images?.[0] || product.thumbnail || null;
    let imageUrl = null;

    if (existingBySlug.has(slug)) {
      const fileName = existingBySlug.get(slug);
      imageUrl = `/products/${fileName}`;
      usedFiles.add(fileName);
      skipped += 1;
    } else if (imageSource) {
      try {
        const fileName = await saveImage(imageSource, slug);
        imageUrl = `/products/${fileName}`;
        usedFiles.add(fileName);
        downloaded += 1;
      } catch (err) {
        failures.push(`${product.title} (${category}) — ${err.message}`);
        console.log(`failed     ${product.title}: ${err.message}`);
      }
    } else {
      failures.push(`${product.title} (${category}) — no image on DummyJSON`);
    }

    catalog.push({
      name: product.title,
      description: product.description,
      category,
      price: inrPrice(product.price),
      low_stock_threshold: 5,
      image_url: imageUrl,
    });
  }

  catalog.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

  // Demo search: "blutooth" must hit at least three Audio products. DummyJSON's audio
  // descriptions talk about "wireless", which the typo-tolerant matcher does not link to
  // "bluetooth", so the sentence is appended until three Audio products carry the word.
  const audioMentions = catalog.filter(
    (item) => item.category === "Audio" && /bluetooth|wireless/i.test(`${item.name} ${item.description}`),
  ).length;
  const audioSearchable = catalog.filter(
    (item) => item.category === "Audio" && /bluetooth/i.test(`${item.name} ${item.description}`),
  ).length;
  if (audioSearchable < 3) {
    for (const item of catalog) {
      if (item.category === "Audio" && !/Bluetooth wireless audio\.$/.test(item.description)) {
        item.description = `${item.description.trim()} Bluetooth wireless audio.`;
      }
    }
    console.log(
      `Audio: ${audioMentions} product(s) mentioned bluetooth/wireless but only ${audioSearchable} ` +
        `mentioned bluetooth; appended the demo sentence.`,
    );
  }

  await writeFile(catalogFile, `${JSON.stringify(catalog, null, 2)}\n`);

  // Keep only the photos in the new set.
  const deleted = [];
  for (const file of await readdir(publicDir)) {
    if (usedFiles.has(file)) continue;
    await unlink(path.join(publicDir, file));
    deleted.push(file);
  }

  console.log("\nProducts per category:");
  for (const [category, info] of Object.entries(perCategory)) {
    const fill = info.filledFrom.length > 0 ? ` (filled from ${info.filledFrom.join(", ")})` : "";
    console.log(`  ${category}: ${info.count}${fill}`);
  }
  console.log(
    `\n${catalog.length} products in catalog.json — ${downloaded} photos downloaded, ${skipped} already present, ` +
      `${catalog.length - downloaded - skipped} without a photo, ${deleted.length} stale file(s) deleted.`,
  );
  if (failures.length > 0) {
    console.log("Failed downloads:");
    for (const entry of failures) console.log(`  - ${entry}`);
  }
}

main().catch((err) => {
  console.error("images:fetch failed:", err);
  process.exit(1);
});
