// MCP server for RefinedC assistant
import {
    McpServer,
    ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";

const app = express();
app.use(express.json());

// Create MCP server
const server = new McpServer({
    name: "RefinedC-Copilot-Server",
    version: "1.0.0",
});

// Dictionary of RefinedC annotation information
const annotationInfo = {
    args: "Specifies the refinement type for function arguments",
    constraints:
        "Specifies constraints that should be satisfied on structures or loops",
    ensures:
        "Specifies post-conditions that should hold after function returns",
    exists: "Defines existentially quantified variables for functions, loops, or structs",
    field: "Specifies the refinement type for structure members",
    global: "Specifies the refinement type for global variables",
    parameters:
        "Defines universally quantified variables for functions or structures",
    requires:
        "Specifies pre-conditions that should hold at function call sites",
    returns: "Specifies the refinement type for the function return value",
    typedef: "Generates a refinement type for a pointer to a structure",
};

// Tool to get RefinedC annotation information
server.tool(
    "getRefinedCAnnotationInfo",
    { annotation: z.string() },
    async ({ annotation }) => {
        const info = annotationInfo[annotation as keyof typeof annotationInfo];

        if (!info) {
            return {
                content: [
                    {
                        type: "text",
                        text: `No information available for annotation: ${annotation}`,
                    },
                ],
                isError: true,
            };
        }

        return {
            content: [{ type: "text", text: info }],
        };
    },
);

// Tool to get RefinedC annotation templates
server.tool(
    "getRefinedCAnnotationTemplate",
    { type: z.string() },
    async ({ type }) => {
        const templates: Record<string, string> = {
            args: '[[rc::args("${1:type_expr}")]]',
            constraints: '[[rc::constraints("${1:constr}")]]',
            ensures: '[[rc::ensures("${1:post_condition}")]]',
            exists: '[[rc::exists("${1:ident} : ${2:coq_expr}")]]',
            field: '[[rc::field("${1:type_expr}")]]',
            global: '[[rc::global("${1:type_expr}")]]',
            parameters: '[[rc::parameters("${1:ident} : ${2:coq_expr}")]]',
            requires: '[[rc::requires("${1:pre_condition}")]]',
            returns: '[[rc::returns("${1:type_expr}")]]',
            typedef: '[[rc::typedef("${1:ident} : ${2:type_expr}")]]',
        };

        const template = templates[type];

        if (!template) {
            return {
                content: [
                    {
                        type: "text",
                        text: `No template available for annotation type: ${type}`,
                    },
                ],
                isError: true,
            };
        }

        return {
            content: [{ type: "text", text: template }],
        };
    },
);

// Tool to validate RefinedC specs
server.tool("validateRefinedCSpec", { code: z.string() }, async ({ code }) => {
    // This would call an actual RefinedC validator
    // For this example, we'll just check for basic patterns

    const errors = [];
    const lines = code.split("\n");

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Check for potential errors in annotations
        if (line.includes("[[rc::") && !line.includes("]]")) {
            errors.push({
                line: i,
                startChar: line.indexOf("[[rc::"),
                endChar: line.length,
                message: "Unclosed annotation",
            });
        }

        // Check for other potential issues
        // (This would be much more sophisticated in a real implementation)
    }

    if (errors.length > 0) {
        return {
            content: [{ type: "text", text: JSON.stringify({ errors }) }],
            isError: true,
        };
    }

    return {
        content: [{ type: "text", text: "Validation passed" }],
    };
});

// Tool to explain RefinedC annotations
server.tool(
    "explainRefinedCAnnotation",
    { annotation: z.string() },
    async ({ annotation }) => {
        // In a real implementation, this would parse and analyze the annotation
        // For this example, we'll provide some basic explanations

        let explanation = "<p>Analysis of the annotation:</p>";

        if (annotation.includes("rc::args")) {
            explanation += `
        <h3>Function Argument Type</h3>
        <p>This annotation specifies the refinement type for function arguments.</p>
        <p>Format: <code>[[rc::args("type_expr")]]</code></p>
        <p>Example: <code>[[rc::args("int&lt;i32&gt;", "i @ int&lt;i32&gt;")]]</code></p>
      `;
        } else if (annotation.includes("rc::ensures")) {
            explanation += `
        <h3>Function Post-Condition</h3>
        <p>This annotation specifies conditions that must hold after the function returns.</p>
        <p>Format: <code>[[rc::ensures("constr")]]</code></p>
        <p>Example: <code>[[rc::ensures("{result = n + 1}")]]</code></p>
      `;
        } else {
            explanation += `
        <p>Couldn't generate a detailed explanation for this annotation. Try selecting a specific annotation.</p>
      `;
        }

        return {
            content: [{ type: "text", text: explanation }],
        };
    },
);

// Resource for autocompletion suggestions
server.resource(
    "completions",
    new ResourceTemplate("refinedcAssistant://completions/{context}", {
        list: undefined,
    }),
    async (uri, { context }) => {
        const contextInfo = JSON.parse(decodeURIComponent(context));
        const { lineText, precedingText } = contextInfo;

        // Generate completion suggestions based on the context
        let suggestions = [];

        if (lineText.includes("[[rc::")) {
            // Generate suggestions for attribute arguments
            if (lineText.includes("rc::args") && precedingText.endsWith('"')) {
                suggestions = [
                    {
                        label: "int<i32>",
                        insertText: "int<i32>",
                        documentation: "32-bit signed integer type",
                    },
                    {
                        label: "int<u8>",
                        insertText: "int<u8>",
                        documentation: "8-bit unsigned integer type",
                    },
                    {
                        label: "value @ type",
                        insertText: "${1:value} @ ${2:type}",
                        documentation: "Refined value of specified type",
                    },
                ];
            } else if (
                lineText.includes("rc::field") &&
                precedingText.endsWith('"')
            ) {
                suggestions = [
                    {
                        label: "Field Type",
                        insertText: "${1:value} @ ${2:type}",
                        documentation: "Refined field type",
                    },
                ];
            }
        } else if (lineText.includes("//rc::")) {
            // Generate suggestions for special comments
            suggestions = [
                {
                    label: "import",
                    insertText: "import ${1:modpath} from ${2:library}",
                    documentation: "Import a Coq module",
                },
                {
                    label: "typedef",
                    insertText: "typedef ${1:ident} := ${2:type_expr}",
                    documentation: "Define a type without a struct",
                },
                {
                    label: "inlined",
                    insertText: "inlined\n//@${1:code line}\n//@rc::end",
                    documentation: "Inline Coq code in generated files",
                },
            ];
        }

        return {
            contents: [
                {
                    uri: uri.href,
                    text: JSON.stringify({ suggestions }),
                },
            ],
        };
    },
);

// Set up the Streamable HTTP transport
const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
    } else {
        transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            onsessioninitialized: (id) => {
                transports[id] = transport;
            },
        });

        transport.onclose = () => {
            if (transport.sessionId) {
                delete transports[transport.sessionId];
            }
        };

        await server.connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string;
    if (!sessionId || !transports[sessionId]) {
        res.status(400).send("Invalid or missing session ID");
        return;
    }

    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string;
    if (!sessionId || !transports[sessionId]) {
        res.status(400).send("Invalid or missing session ID");
        return;
    }

    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
});

// Start the server
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`RefinedC MCP Server listening on port ${PORT}`);
});
