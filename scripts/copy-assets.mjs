import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(packageRoot, "dist");
const assetsToCopy = [
    {
        source: join(packageRoot, "assets", "SKILL.md"),
        destination: join(distDir, "SKILL.md"),
    },
    {
        source: join(packageRoot, "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
        destination: join(distDir, "sql-wasm.wasm"),
    },
];

await mkdir(distDir, { recursive: true });
for (const asset of assetsToCopy) {
    await copyFile(asset.source, asset.destination);
}
