import { access, copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const COMMAND_INSTALL = "install";
const COMMAND_MCP = "mcp";
const MANAGED_FILES = ["SKILL.md", "extension.mjs", "runtime.cjs", "sql-wasm.wasm"] as const;
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(packageRoot, "dist");

interface InstallOptions {
    target: string;
    force: boolean;
    userScope: boolean;
}

interface McpOptions {
    cwd: string;
    defaultConfig?: string;
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const command = args[0] ?? "help";

    switch (command) {
        case COMMAND_INSTALL:
            await install(parseInstallOptions(args.slice(1)));
            return;
        case COMMAND_MCP:
            await startMcpServer(parseMcpOptions(args.slice(1)));
            return;
        case "help":
        case "--help":
        case "-h":
            printHelp();
            return;
        default:
            throw new Error(`unknown command: ${command}`);
    }
}

function parseInstallOptions(argv: string[]): InstallOptions {
    let target = process.cwd();
    let force = false;
    let userScope = false;

    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        switch (argument) {
            case "--target": {
                if (userScope) {
                    throw new Error("--target cannot be combined with --user/--global");
                }
                const next = argv[index + 1];
                if (!next) {
                    throw new Error("--target requires a path");
                }
                target = resolve(next);
                index += 1;
                break;
            }
            case "--user":
            case "--global":
                if (target !== process.cwd()) {
                    throw new Error("--user/--global cannot be combined with --target");
                }
                userScope = true;
                target = resolveUserExtensionsDir();
                break;
            case "--force":
                force = true;
                break;
            default:
                throw new Error(`unknown option: ${argument}`);
        }
    }

    return { target, force, userScope };
}

function parseMcpOptions(argv: string[]): McpOptions {
    let cwd = process.cwd();
    let defaultConfig: string | undefined;

    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        switch (argument) {
            case "--cwd": {
                const next = argv[index + 1];
                if (!next) {
                    throw new Error("--cwd requires a path");
                }
                cwd = resolve(next);
                index += 1;
                break;
            }
            case "--config": {
                const next = argv[index + 1];
                if (!next) {
                    throw new Error("--config requires JSON text");
                }
                defaultConfig = next;
                index += 1;
                break;
            }
            default:
                throw new Error(`unknown option: ${argument}`);
        }
    }

    return { cwd, defaultConfig };
}

async function install(options: InstallOptions): Promise<void> {
    await ensureDistArtifacts(MANAGED_FILES);
    if (options.userScope) {
        await mkdir(options.target, { recursive: true });
    }
    await ensureDirectory(options.target);

    const extensionDir = options.userScope
        ? join(options.target, "database-explorer")
        : join(options.target, ".github", "extensions", "database-explorer");
    const existingEntries = await readDirectoryEntries(extensionDir);
    const unexpectedEntries = existingEntries.filter((entry) => !MANAGED_FILES.includes(entry as (typeof MANAGED_FILES)[number]));

    if (unexpectedEntries.length > 0 && !options.force) {
        throw new Error(
            `refusing to overwrite ${extensionDir} because it contains unmanaged entries: ${unexpectedEntries.join(", ")}. Re-run with --force to replace the directory.`,
        );
    }

    if (unexpectedEntries.length > 0 && options.force) {
        await rm(extensionDir, { recursive: true, force: true });
    }

    await mkdir(extensionDir, { recursive: true });
    for (const fileName of MANAGED_FILES) {
        await copyFile(join(distDir, fileName), join(extensionDir, fileName));
    }

    console.log(`Installed database-explorer extension into ${extensionDir}`);
    console.log("Next steps:");
    console.log("1. Restart Copilot CLI or run /clear so the new extension is loaded.");
    console.log("2. Pass config JSON text to database_explorer_* tools.");
    console.log("3. Run database_explorer_health_check (mode quick/full) to verify connectivity.");
}

async function startMcpServer(options: McpOptions): Promise<void> {
    await ensureDistArtifacts(["mcp.cjs", "sql-wasm.wasm"]);
    await ensureDirectory(options.cwd);

    const moduleUrl = pathToFileURL(join(distDir, "mcp.cjs")).href;
    const mcpModule = (await import(moduleUrl)) as (typeof import("./mcp")) & {
        default?: typeof import("./mcp");
    };
    const start = mcpModule.startMcpServer ?? mcpModule.default?.startMcpServer;
    if (typeof start !== "function") {
        throw new Error("dist/mcp.cjs does not export startMcpServer");
    }
    await start(options);
}

async function ensureDistArtifacts(fileNames: readonly string[]): Promise<void> {
    for (const fileName of fileNames) {
        try {
            await access(join(distDir, fileName));
        } catch {
            throw new Error(`missing build artifact ${fileName}; run npm run build first`);
        }
    }
}

async function ensureDirectory(path: string): Promise<void> {
    let details;
    try {
        details = await stat(path);
    } catch (error) {
        if (isErrnoException(error) && error.code === "ENOENT") {
            throw new Error(`target project directory does not exist: ${path}`);
        }
        throw error;
    }
    if (!details.isDirectory()) {
        throw new Error(`target project path is not a directory: ${path}`);
    }
}

async function readDirectoryEntries(path: string): Promise<string[]> {
    return readdir(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
            return [];
        }
        throw error;
    });
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
    return typeof error === "object" && error !== null && "code" in error;
}

function resolveUserExtensionsDir(): string {
    return join(homedir(), ".copilot", "extensions");
}

function printHelp(): void {
    console.log("Usage:");
    console.log("  npx copilot-extension-database-explorer install [--target /path/to/project | --user|--global] [--force]");
    console.log("  npx copilot-extension-database-explorer mcp [--cwd /path/to/project] [--config '<json text>']");
}

await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
