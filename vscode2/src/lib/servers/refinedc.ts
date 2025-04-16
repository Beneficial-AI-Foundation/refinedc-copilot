import { exec } from "child_process";
import {
    McpServer,
    ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { Schema } from "effect";

const server = new McpServer({
    name: "RefinedC Copilot",
    version: "1.0.0",
});

server.tool("check", { filename: Schema.String }, async ({ filename }) => {
    const result = await exec(
        `refinedc check ${filename}`,
        (error, stdout, stderr) => {
            if (error) {
                return { error, stdout, stderr };
            } else {
                return { error, stdout, stderr };
            }
        },
    );
    return { content: [{ type: "text", text: stderr }] };
});
