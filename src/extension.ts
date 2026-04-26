import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { joinSession } from "@github/copilot-sdk/extension";

import type * as RuntimeModule from "./runtime";

const extensionRoot = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const runtime = require("./runtime.cjs") as typeof RuntimeModule;
const skillText = await runtime.readSkillText(join(extensionRoot, "SKILL.md"));

let currentCwd = process.cwd();

await joinSession({
    tools: runtime.createDatabaseExplorerTools({
        getCwd: () => currentCwd,
    }),
    hooks: {
        async onSessionStart(input) {
            currentCwd = input.cwd;

            if (input.source !== "new") {
                return;
            }

            return {
                additionalContext: runtime.getDatabaseExplorerSessionStartContext(),
            };
        },
        async onUserPromptSubmitted(input) {
            currentCwd = input.cwd;

            if (!runtime.getDatabaseExplorerPattern().test(input.prompt)) {
                return;
            }

            return {
                additionalContext: runtime.buildDatabaseExplorerAdditionalContext(skillText),
            };
        },
    },
});
