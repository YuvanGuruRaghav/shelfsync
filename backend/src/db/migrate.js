import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { pool } from "./pool.js";

/** Apply schema.sql. Safe to run repeatedly. */
export async function migrate() {
  const schemaPath = fileURLToPath(new URL("./schema.sql", import.meta.url));
  const sql = await readFile(schemaPath, "utf8");
  await pool.query(sql);
}

if (process.argv[1] && process.argv[1].endsWith("migrate.js")) {
  migrate()
    .then(() => {
      console.log("Schema applied.");
      return pool.end();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
