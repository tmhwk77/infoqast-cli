import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCache = mkdtempSync(join(tmpdir(), "infoqast-cli-pack-cache-"));
let packed;
try {
  packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: packageDir,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: npmCache },
  });
} finally {
  rmSync(npmCache, { recursive: true, force: true });
}

if (packed.status !== 0) {
  process.stderr.write(packed.stderr || packed.stdout);
  process.exit(packed.status ?? 1);
}

let result;
try {
  result = JSON.parse(packed.stdout);
} catch {
  process.stderr.write("cli-package: npm pack did not return valid JSON\n");
  process.exit(1);
}

const files = result?.[0]?.files?.map((entry) => entry.path).sort();
if (!Array.isArray(files)) {
  process.stderr.write("cli-package: npm pack returned no file manifest\n");
  process.exit(1);
}

const required = ["LICENSE", "README.md", "dist/index.d.ts", "dist/index.js", "package.json"];
const missing = required.filter((path) => !files.includes(path));
const unexpected = files.filter(
  (path) =>
    path !== "README.md" &&
    path !== "LICENSE" &&
    path !== "package.json" &&
    !/^dist\/[a-z0-9-]+\.(?:d\.ts|js)$/u.test(path),
);

if (missing.length > 0 || unexpected.length > 0) {
  if (missing.length > 0) {
    process.stderr.write(`cli-package: missing required files: ${missing.join(", ")}\n`);
  }
  if (unexpected.length > 0) {
    process.stderr.write(`cli-package: unexpected files: ${unexpected.join(", ")}\n`);
  }
  process.exit(1);
}

process.stdout.write(`cli-package: verified ${files.length} allowlisted files\n`);
