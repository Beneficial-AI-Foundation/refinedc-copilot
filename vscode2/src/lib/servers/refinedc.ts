import { exec } from "child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";

const server = new McpServer({
    name: "RefinedC Copilot",
    version: "1.0.0",
});

server.tool("init", { filename: z.string() }, async ({ filename }) => {
    const result = await exec(
        `refinedc init ${filename}`,
        (error, stdout, stderr) => {
            if (error) {
                return { error, stdout, stderr };
            } else {
                return { error, stdout, stderr };
            }
        },
    );
    return { content: [{ type: "text", text: result.stdout }] };
});

server.tool("check", { filename: z.string() }, async ({ filename }) => {
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
    return { content: [{ type: "text", text: result.stderr }] };
});
