import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { products, slugify } from "../src/db/seed.js";

/**
 * ONE-TIME script: download one product photo per seed product from dummyjson.com
 * into frontend/public/products and write the seed -> image mapping.
 *
 * Run with `npm run images:fetch`. Not part of seed or boot. Files that already
 * exist are skipped, and a single bad product never stops the run.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "../../frontend/public/products");
const mappingFile = path.resolve(here, "../src/db/product-images.json");

const SEARCH_URL = "https://dummyjson.com/products/search";
const TIMEOUT_MS = 20000;

const EXTENSION_BY_TYPE = {
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/avif": "avif",
};
const IMAGE_EXTENSIONS = new Set(["webp", "jpg", "jpeg", "png", "gif", "avif"]);

async function getJson(url) {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Name, then category, then the first word of the name. */
function keywordsFor(name, category) {
  const firstWord = name.split(/[^A-Za-z0-9]+/).filter(Boolean)[0] ?? "";
  return [...new Set([name, category, firstWord].map((value) => value.trim()).filter(Boolean))];
}

async function findImage(keywords) {
  for (const keyword of keywords) {
    const data = await getJson(`${SEARCH_URL}?q=${encodeURIComponent(keyword)}`);
    const hit = data?.products?.[0];
    const imageUrl = hit?.images?.[0] || hit?.thumbnail;
    if (imageUrl) return { imageUrl, keyword, title: hit.title };
  }
  return null;
}

function pickExtension(imageUrl, contentType) {
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (EXTENSION_BY_TYPE[type]) return EXTENSION_BY_TYPE[type];
  const urlExtension = path.extname(new URL(imageUrl).pathname).slice(1).toLowerCase();
  if (IMAGE_EXTENSIONS.has(urlExtension)) return urlExtension === "jpeg" ? "jpg" : urlExtension;
  return "jpg";
}

/** Saves the image as `<slug>.<original extension>`, or .webp when the source is webp. */
async function saveImage(imageUrl, slug) {
  const res = await fetch(imageUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`image download failed: HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length === 0) throw new Error("image download was empty");

  const fileName = `${slug}.${pickExtension(imageUrl, res.headers.get("content-type"))}`;
  await writeFile(path.join(publicDir, fileName), buffer);
  return fileName;
}

async function main() {
  await mkdir(publicDir, { recursive: true });

  const existingBySlug = new Map();
  for (const file of await readdir(publicDir)) {
    const { name, ext } = path.parse(file);
    if (ext && !existingBySlug.has(name)) existingBySlug.set(name, file);
  }

  const mapping = {};
  const downloaded = [];
  const skipped = [];
  const missed = [];

  for (const [name, , category] of products) {
    const slug = slugify(name);

    if (existingBySlug.has(slug)) {
      mapping[slug] = `/products/${existingBySlug.get(slug)}`;
      skipped.push(name);
      continue;
    }

    try {
      const match = await findImage(keywordsFor(name, category));
      if (!match) {
        missed.push(`${name} (${category})`);
        console.log(`no match   ${name}`);
        continue;
      }

      const fileName = await saveImage(match.imageUrl, slug);
      mapping[slug] = `/products/${fileName}`;
      downloaded.push(name);
      console.log(`downloaded ${name} -> ${fileName}  [${match.keyword}: ${match.title}]`);
    } catch (err) {
      missed.push(`${name} (${category}) — ${err.message}`);
      console.log(`failed     ${name}: ${err.message}`);
    }
  }

  const sorted = Object.fromEntries(Object.keys(mapping).sort().map((key) => [key, mapping[key]]));
  await writeFile(mappingFile, `${JSON.stringify(sorted, null, 2)}\n`);

  console.log(
    `\n${products.length} products: ${downloaded.length} downloaded, ${skipped.length} already present, ` +
      `${missed.length} without an image. Mapping written to ${path.relative(process.cwd(), mappingFile)}.`,
  );
  if (missed.length > 0) {
    console.log("No image for:");
    for (const entry of missed) console.log(`  - ${entry}`);
  }
}

main().catch((err) => {
  console.error("images:fetch failed:", err);
  process.exit(1);
});
