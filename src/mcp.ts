import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

import {
    createDatabaseExplorerDefinitions,
    formatDatabaseExplorerResult,
    type ToolParameterDefinition,
} from "./core";

const SERVER_NAME = "database-explorer";
const SERVER_VERSION = "0.1.0";

export interface DatabaseExplorerMcpServerOptions {
    cwd: string;
    defaultConfigPath?: string;
}

export async function startMcpServer(options: DatabaseExplorerMcpServerOptions): Promise<void> {
    const server = new McpServer(
        {
            name: SERVER_NAME,
            version: SERVER_VERSION,
        },
        {
            capabilities: {
                logging: {},
            },
        },
    );

    for (const tool of createDatabaseExplorerDefinitions({ getCwd: () => options.cwd, defaultConfigPath: options.defaultConfigPath })) {
        server.registerTool(
            tool.name,
            {
                description: tool.description,
                inputSchema: buildMcpInputSchema(tool.parameters),
                annotations: {
                    readOnlyHint: true,
                    destructiveHint: false,
                    openWorldHint: false,
                },
            },
            async (args: unknown) => {
                try {
                    const result = await tool.execute(args);
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: formatDatabaseExplorerResult(result),
                            },
                        ],
                        structuredContent: toStructuredContent(result),
                    };
                } catch (error) {
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: error instanceof Error ? error.message : String(error),
                            },
                        ],
                        isError: true,
                    };
                }
            },
        );
    }

    await server.connect(new StdioServerTransport());
}

function buildMcpInputSchema(definition: ToolParameterDefinition): z.ZodTypeAny {
    if (definition.type !== "object") {
        throw new Error("MCP tool input schema root must be an object");
    }

    const shape: Record<string, z.ZodTypeAny> = {};
    const requiredKeys = new Set(definition.required ?? []);
    for (const [key, property] of Object.entries(definition.properties ?? {})) {
        const schema = buildPropertySchema(property);
        shape[key] = requiredKeys.has(key) ? schema : schema.optional();
    }

    const objectSchema = definition.additionalProperties === false ? z.object(shape).strict() : z.object(shape).passthrough();
    return applyDescription(objectSchema, definition.description);
}

function buildPropertySchema(definition: ToolParameterDefinition): z.ZodTypeAny {
    switch (definition.type) {
        case "string":
            return applyDescription(z.string(), definition.description);
        case "integer":
            return applyDescription(z.number().int(), definition.description);
        case "object":
            return buildMcpInputSchema(definition);
        default:
            throw new Error(`unsupported MCP parameter type ${JSON.stringify((definition as { type?: unknown }).type)}`);
    }
}

function applyDescription<TSchema extends z.ZodTypeAny>(schema: TSchema, description?: string): TSchema {
    if (!description) {
        return schema;
    }
    return schema.describe(description) as TSchema;
}

function toStructuredContent(result: unknown): Record<string, unknown> {
    return isRecord(result) ? result : { result };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
