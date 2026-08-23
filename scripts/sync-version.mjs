#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packageVersion = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
const target = resolve(root, "src/version.ts");
const current = readFileSync(target, "utf8");
const expected = current.replace(
  /export const BROWSER_NODE_VERSION = "[^"]+";/,
  `export const BROWSER_NODE_VERSION = "${packageVersion}";`,
);

if (process.argv.includes("--write")) {
  writeFileSync(target, expected);
} else if (current !== expected) {
  console.error(`src/version.ts is stale; run: node scripts/sync-version.mjs --write`);
  process.exit(1);
}
