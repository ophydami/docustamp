#!/usr/bin/env node
/**
 * Compares every locale under src/locales against en.json:
 * a locale must define exactly the keys English defines, no more, no fewer.
 *
 *   node scripts/i18n-check.mjs      (npm run i18n:check)
 *
 * Exits 1 and prints the offending keys when anything is out of step.
 * `_meta` is the translation header note and is ignored on both sides.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const LOCALES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "locales");
const BASE = "en";
const IGNORED_TOP_LEVEL = new Set(["_meta"]);
/** How many missing/extra keys to print per locale before summarising. */
const SHOW = 25;

/** Every leaf path in an object, dot-joined: { a: { b: 1 } } -> ["a.b"]. */
function leafKeys(value, prefix = "", out = []) {
  for (const [key, child] of Object.entries(value)) {
    if (!prefix && IGNORED_TOP_LEVEL.has(key)) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === "object" && !Array.isArray(child)) leafKeys(child, path, out);
    else out.push(path);
  }
  return out;
}

function load(lang) {
  const file = join(LOCALES_DIR, `${lang}.json`);
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`  ${lang}.json could not be parsed: ${err.message}`);
    process.exit(1);
  }
}

function list(label, keys) {
  console.error(`  ${label} (${keys.length}):`);
  for (const key of keys.slice(0, SHOW)) console.error(`    ${key}`);
  if (keys.length > SHOW) console.error(`    ... and ${keys.length - SHOW} more`);
}

const langs = readdirSync(LOCALES_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.slice(0, -5))
  .sort();

if (!langs.includes(BASE)) {
  console.error(`No ${BASE}.json in ${LOCALES_DIR}`);
  process.exit(1);
}

const base = new Set(leafKeys(load(BASE)));
let failed = false;

console.log(`en.json: ${base.size} keys`);

for (const lang of langs) {
  if (lang === BASE) continue;
  const keys = new Set(leafKeys(load(lang)));
  const missing = [...base].filter((k) => !keys.has(k));
  const extra = [...keys].filter((k) => !base.has(k));

  if (missing.length || extra.length) {
    failed = true;
    console.error(`\n${lang}.json is out of step with ${BASE}.json`);
    if (missing.length) list("missing", missing);
    if (extra.length) list("not in en.json", extra);
  } else {
    console.log(`${lang}.json: ${keys.size} keys, matches en.json`);
  }
}

if (failed) {
  console.error("\ni18n:check failed.");
  process.exit(1);
}
console.log("\nAll locales match en.json.");
