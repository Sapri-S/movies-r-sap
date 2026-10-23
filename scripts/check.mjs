import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const directories = ["apps", "desktop", "dist", "scripts", "tests"];
let checked = 0;
async function checkDirectory(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory() && !item.name.startsWith("."))
      await checkDirectory(path);
    else if (item.isFile() && /\.(mjs|js)$/.test(item.name)) {
      const result = spawnSync(process.execPath, ["--check", path], {
        encoding: "utf8",
      });
      if (result.status !== 0) {
        process.stderr.write(result.stderr);
        process.exitCode = 1;
      }
      checked++;
    }
  }
}
for (const directory of directories) await checkDirectory(directory);
console.log(`Syntax checked ${checked} JavaScript modules.`);
