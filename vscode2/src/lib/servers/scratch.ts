import { Command } from "commander";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function clientmain() {
    const transport = new StdioClientTransport({
        command: "node",
        args: ["server.js"],
    });

    const client = new Client({
        name: "example-client",
        version: "1.0.0",
    });

    client
        .connect(transport)
        .then(() => client.listPrompts())
        .then((prompts) => {
            console.log("Prompts:", prompts);
            return client.getPrompt({
                name: "example-prompt",
                arguments: {
                    arg1: "value",
                },
            });
        })
        .then((prompt) => {
            console.log("Prompt:", prompt);
            return client.listResources();
        })
        .then((resources) => {
            console.log("Resources:", resources);
            return client.readResource({
                uri: "file:///example.txt",
            });
        })
        .then((resource) => {
            console.log("Resource:", resource);
            return client.callTool({
                name: "example-tool",
                arguments: {
                    arg1: "value",
                },
            });
        })
        .then((result) => {
            console.log("Tool result:", result);
        })
        .catch((error) => {
            console.error("Error:", error);
        });
}

const program = new Command();

program
    .name("scratchtest")
    .description("figuring out mcp")
    .action(() => {
        clientmain();
    });

program.parse();
