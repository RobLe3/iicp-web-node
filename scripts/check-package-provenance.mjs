import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const versionSource = await readFile("src/version.ts", "utf8");
const implementation = versionSource.match(/BROWSER_NODE_VERSION = "([^"]+)"/u)?.[1];
const compatibility = versionSource.match(
  /BROWSER_NODE_SDK_COMPATIBILITY_VERSION = "([^"]+)"/u,
)?.[1];

if (!implementation || !compatibility || packageJson.version !== implementation) {
  throw new Error("browser package and version-contract sources disagree");
}

const lock = await readFile("package-lock.json");
let commit = process.env.GITHUB_SHA ?? "unknown";
try {
  commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
} catch {
  // Source archives without .git retain an explicit unknown provenance value.
}

const manifest = {
  schema: "iicp.browser_build_provenance.v1",
  package: packageJson.name,
  implementation_version: implementation,
  sdk_compatibility_version: compatibility,
  source_commit: commit,
  lockfile_sha256: createHash("sha256").update(lock).digest("hex"),
};

await writeFile("dist/build-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest));
