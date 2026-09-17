// Packs the loadable extension into jev-ad.zip (without .env, tests or scripts).
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
execSync("rm -f jev-ad.zip && zip -r jev-ad.zip manifest.json src README.md -x 'src/config.local.js'", { cwd: root, stdio: "inherit" });
