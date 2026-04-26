import {
    buildDatabaseExplorerAdditionalContext,
    createDatabaseExplorerDefinitions,
    formatDatabaseExplorerResult,
    getDatabaseExplorerPattern,
    getDatabaseExplorerSessionStartContext,
    loadConfigForTests,
    prepareReadOnlyQuery,
    readSkillText,
    type DatabaseExplorerToolFactoryOptions,
    type ToolParameterDefinition,
} from "./core";

interface ToolResult {
    textResultForLlm: string;
    resultType: "success" | "failure";
}

interface ToolDefinition {
    name: string;
    description: string;
    parameters: ToolParameterDefinition;
    handler: (args: unknown) => Promise<ToolResult>;
}

async function runTool<T>(work: () => Promise<T>): Promise<ToolResult> {
    try {
        const result = await work();
        return {
            textResultForLlm: formatDatabaseExplorerResult(result),
            resultType: "success",
        };
    } catch (error) {
        return {
            textResultForLlm: error instanceof Error ? error.message : String(error),
            resultType: "failure",
        };
    }
}

export {
    buildDatabaseExplorerAdditionalContext,
    getDatabaseExplorerPattern,
    getDatabaseExplorerSessionStartContext,
    loadConfigForTests,
    prepareReadOnlyQuery,
    readSkillText,
};

export function createDatabaseExplorerTools(options: DatabaseExplorerToolFactoryOptions): ToolDefinition[] {
    return createDatabaseExplorerDefinitions(options).map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        handler: async (rawArgs) => runTool(() => tool.execute(rawArgs)),
    }));
}
