// Create a VSCode extension that uses MCP to provide assistance for RefinedC specs
import * as vscode from "vscode";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";

// Extension activation function
async function activate(context: vscode.ExtensionContext) {
	console.log("RefinedC Assistant extension is now active");

	// Connect to MCP server
	const client = new Client({
		name: "RefinedC-Copilot",
		version: "1.0.0",
	});

	let mcpServerUrl = vscode.workspace
		.getConfiguration("refinedcAssistant")
		.get<string>("mcpServerUrl");
	if (!mcpServerUrl) {
		mcpServerUrl = "http://localhost:3000/mcp"; // Default URL
	}

	try {
		const transport = new StreamableHTTPClientTransport(new URL(mcpServerUrl));
		await client.connect(transport);
		vscode.window.showInformationMessage("Connected to RefinedC MCP server");
	} catch (error) {
		vscode.window.showErrorMessage(`Failed to connect to MCP server: ${error}`);
		return;
	}

	// Register commands
	const disposableCommands = [
		vscode.commands.registerCommand("refinedcAssistant.insertAnnotation", () =>
			insertAnnotation(client),
		),
		vscode.commands.registerCommand("refinedcAssistant.validateSpec", () =>
			validateSpec(client),
		),
		vscode.commands.registerCommand("refinedcAssistant.explainAnnotation", () =>
			explainAnnotation(client),
		),
	];

	// Register hover provider
	const hoverProvider = vscode.languages.registerHoverProvider(
		{ language: "c" },
		new RefinedCHoverProvider(client),
	);

	// Register completion provider
	const completionProvider = vscode.languages.registerCompletionItemProvider(
		{ language: "c" },
		new RefinedCCompletionProvider(client),
		"[",
		"<",
		"@",
		":",
		"&", // Trigger characters
	);

	// Add to subscriptions
	context.subscriptions.push(
		...disposableCommands,
		hoverProvider,
		completionProvider,
	);
}

// Hover provider for RefinedC annotations
class RefinedCHoverProvider implements vscode.HoverProvider {
	constructor(private client: Client) {}

	async provideHover(
		document: vscode.TextDocument,
		position: vscode.Position,
	): Promise<vscode.Hover | undefined> {
		const wordRange = document.getWordRangeAtPosition(position);
		if (!wordRange) {
			return undefined;
		}

		const word = document.getText(wordRange);

		// Check if we're in an rc annotation
		const lineText = document.lineAt(position.line).text;
		if (!lineText.includes("[[rc::") && !lineText.includes("//rc::")) {
			return undefined;
		}

		try {
			// Use MCP tool to get annotation information
			const result = await this.client.callTool({
				name: "getRefinedCAnnotationInfo",
				arguments: { annotation: word },
			});

			if (result.isError) {
				return undefined;
			}

			return new vscode.Hover(result.content[0].text);
		} catch (error) {
			console.error("Error getting annotation info:", error);
			return undefined;
		}
	}
}

// Completion provider for RefinedC annotations
class RefinedCCompletionProvider implements vscode.CompletionItemProvider {
	constructor(private client: Client) {}

	async provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
	): Promise<vscode.CompletionItem[] | undefined> {
		const linePrefix = document
			.lineAt(position.line)
			.text.substring(0, position.character);

		// Check if we're in an rc annotation
		if (!(linePrefix.includes("[[rc::") || linePrefix.includes("//rc::"))) {
			return undefined;
		}

		try {
			// Use MCP resource to get completion suggestions
			const contextInfo = {
				lineText: document.lineAt(position.line).text,
				position: position.character,
				precedingText: linePrefix,
			};

			const encodedContext = encodeURIComponent(JSON.stringify(contextInfo));
			const resource = await this.client.readResource({
				uri: `refinedcAssistant://completions/${encodedContext}`,
			});

			if (!resource.contents || resource.contents.length === 0) {
				return undefined;
			}

			const completionData = JSON.parse(resource.contents[0].text);
			return completionData.suggestions.map((suggestion: any) => {
				const item = new vscode.CompletionItem(suggestion.label);
				item.kind = vscode.CompletionItemKind.Snippet;
				item.insertText = new vscode.SnippetString(suggestion.insertText);
				item.documentation = suggestion.documentation;
				return item;
			});
		} catch (error) {
			console.error("Error getting completions:", error);
			return undefined;
		}
	}
}

// Command to insert annotation template
async function insertAnnotation(client: Client) {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		return;
	}

	const annotationTypes = [
		"args",
		"constraints",
		"ensures",
		"exists",
		"field",
		"global",
		"parameters",
		"requires",
		"returns",
		"typedef",
	];

	const selected = await vscode.window.showQuickPick(annotationTypes, {
		placeHolder: "Select annotation type",
	});

	if (!selected) {
		return;
	}

	try {
		// Use MCP tool to get annotation template
		const result = await client.callTool({
			name: "getRefinedCAnnotationTemplate",
			arguments: { type: selected },
		});

		if (result.isError) {
			vscode.window.showErrorMessage(
				`Error getting template: ${result.content[0].text}`,
			);
			return;
		}

		editor.insertSnippet(new vscode.SnippetString(result.content[0].text));
	} catch (error) {
		vscode.window.showErrorMessage(
			`Failed to get annotation template: ${error}`,
		);
	}
}

// Command to validate RefinedC spec
async function validateSpec(client: Client) {
	const editor = vscode.window.activeTextEditor;
	if (!editor) return;

	const document = editor.document;
	const text = document.getText();

	try {
		// Use MCP tool to validate RefinedC spec
		const result = await client.callTool({
			name: "validateRefinedCSpec",
			arguments: { code: text },
		});

		if (result.isError) {
			// Show errors in Problems panel
			const diagnosticCollection =
				vscode.languages.createDiagnosticCollection("refinedcAssistant");
			const diagnostics: vscode.Diagnostic[] = JSON.parse(
				result.content[0].text,
			).errors.map((error: any) => {
				const range = new vscode.Range(
					new vscode.Position(error.line, error.startChar),
					new vscode.Position(error.line, error.endChar),
				);
				return new vscode.Diagnostic(
					range,
					error.message,
					vscode.DiagnosticSeverity.Error,
				);
			});

			diagnosticCollection.set(document.uri, diagnostics);
			vscode.window.showErrorMessage(
				"RefinedC spec validation failed. See Problems panel for details.",
			);
		} else {
			vscode.window.showInformationMessage("RefinedC spec is valid!");
		}
	} catch (error) {
		vscode.window.showErrorMessage(`Failed to validate spec: ${error}`);
	}
}

// Command to explain an annotation
async function explainAnnotation(client: Client) {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		return;
	}

	const selection = editor.selection;
	const text = editor.document.getText(selection);

	if (!text.trim()) {
		vscode.window.showInformationMessage(
			"Please select an annotation to explain",
		);
		return;
	}

	try {
		// Use MCP tool to explain annotation
		const result = await client.callTool({
			name: "explainRefinedCAnnotation",
			arguments: { annotation: text },
		});

		if (result.isError) {
			vscode.window.showErrorMessage(
				`Error explaining annotation: ${result.content[0].text}`,
			);
			return;
		}

		// Show explanation in webview
		const panel = vscode.window.createWebviewPanel(
			"refinedcExplanation",
			"RefinedC Annotation Explanation",
			vscode.ViewColumn.Beside,
			{},
		);

		panel.webview.html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: var(--vscode-editor-font-family); padding: 20px; }
          pre { background-color: #f5f5f5; padding: 10px; border-radius: 5px; }
        </style>
      </head>
      <body>
        <h2>Annotation Explanation</h2>
        <div>${result.content[0].text}</div>
      </body>
      </html>
    `;
	} catch (error) {
		vscode.window.showErrorMessage(`Failed to explain annotation: ${error}`);
	}
}

// Extension deactivation function
function deactivate() {
	// Clean up resources
}

export { activate, deactivate };
