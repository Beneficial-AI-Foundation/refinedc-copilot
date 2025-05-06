/**
 * RefinedC Copilot Extension
 *
 * This extension provides RefinedC integration with VSCode.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as childProcess from 'child_process';
import { promisify } from 'util';
import { startMcpServerAndConnect, McpClientWrapper } from './lib/mcp/client';
import { registerCompletionProvider } from './lib/mcp/completion-provider';
import { getAnnotationCompletionClient } from './lib/mcp/annotation-completions';
import {
	initProject,
	checkFile,
	extractFunctions,
	applyAnnotations,
} from './lib/utils/refinedc';

const exec = promisify(childProcess.exec);

// Add a variable to track the MCP client
let mcpClient: McpClientWrapper | null = null;

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	console.log('RefinedC Copilot is now active');

	// Register the annotation completion provider
	registerCompletionProvider(context);

	// Command to generate annotations for a function
	const annotateCommand = vscode.commands.registerCommand('refinedc-copilot.annotateFunction', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showErrorMessage('No active editor!');
			return;
		}

		const document = editor.document;
		if (path.extname(document.fileName) !== '.c') {
			vscode.window.showErrorMessage('Not a C file!');
			return;
		}

		// Try to get the current function name
		const position = editor.selection.active;
		const functionName = await getCurrentFunctionName(document, position);

		if (!functionName) {
			const userInput = await vscode.window.showInputBox({
				prompt: 'Enter function name to annotate',
				placeHolder: 'function_name'
			});

			if (!userInput) {
				return; // User cancelled
			}
		}

		// Save the file to ensure annotations apply to the latest version
		await document.save();

		// Show annotation options
		const options = await vscode.window.showQuickPick([
			{
				label: 'Basic Annotations',
				detail: 'Generate basic annotations for types and parameters',
				annotations: { considerOverflow: false, generatePostconditions: false }
			},
			{
				label: 'Full Annotations',
				detail: 'Generate complete annotations including overflow checks',
				annotations: { considerOverflow: true, generatePostconditions: true }
			},
			{
				label: 'Custom Annotations',
				detail: 'Manually specify annotation options',
				annotations: null
			}
		]);

		if (!options) {
			return; // User cancelled
		}

		let annotationOptions = options.annotations;
		if (!annotationOptions) {
			// For custom options, prompt for each setting
			const overflowCheck = await vscode.window.showQuickPick(['Yes', 'No'], {
				placeHolder: 'Include overflow checks?'
			});

			const postConditions = await vscode.window.showQuickPick(['Yes', 'No'], {
				placeHolder: 'Generate postconditions (return value constraints)?'
			});

			annotationOptions = {
				considerOverflow: overflowCheck === 'Yes',
				generatePostconditions: postConditions === 'Yes'
			};
		}

		// Apply directly?
		const applyDirectly = await vscode.window.showQuickPick(['Yes', 'No'], {
			placeHolder: 'Apply annotations directly to file?'
		});

		// Build command to invoke the CLI tool
		const cliCommand = `refinedc-copilot annotate generate ${document.fileName} ${functionName} --parameters "${JSON.stringify(annotationOptions)}" ${applyDirectly === 'Yes' ? '--apply' : ''}`;

		// Show progress indicator
		vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: `Generating annotations for ${functionName}`,
			cancellable: false
		}, async (_progress) => {
			try {
				const { stdout, stderr } = await exec(cliCommand);

				if (stderr) {
					vscode.window.showErrorMessage(`Error: ${stderr}`);
					return;
				}

				const result = JSON.parse(stdout);

				if (result.success) {
					vscode.window.showInformationMessage(`Successfully generated annotations for ${functionName}`);

					// If not applying directly, show the annotations in a new document
					if (applyDirectly !== 'Yes') {
						const annotationsDocument = await vscode.workspace.openTextDocument({
							content: JSON.stringify(result.annotations, null, 2),
							language: 'json'
						});

						await vscode.window.showTextDocument(annotationsDocument);
					}
				} else {
					vscode.window.showErrorMessage(`Failed to generate annotations: ${result.message}`);
				}
			} catch (error) {
				vscode.window.showErrorMessage(`Error: ${(error as Error).message}`);
			}
		});
	});

	// Command to verify current file with RefinedC
	const verifyCommand = vscode.commands.registerCommand('refinedc-copilot.verifyFile', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showErrorMessage('No active editor!');
			return;
		}

		const document = editor.document;
		if (path.extname(document.fileName) !== '.c') {
			vscode.window.showErrorMessage('Not a C file!');
			return;
		}

		// Save the file to ensure we're checking the latest version
		await document.save();

		// Run RefinedC check
		const cliCommand = `refinedc-copilot project check ${document.fileName}`;

		// Show progress indicator
		vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: 'Verifying with RefinedC',
			cancellable: false
		}, async (_progress) => {
			try {
				const { stdout, stderr } = await exec(cliCommand);

				if (stderr) {
					// Create output channel to display error
					const outputChannel = vscode.window.createOutputChannel('RefinedC Verification');
					outputChannel.appendLine(stderr);
					outputChannel.show();

					vscode.window.showErrorMessage('RefinedC verification failed. See output for details.');
					return;
				}

				vscode.window.showInformationMessage('RefinedC verification succeeded!');
			} catch (error) {
				// Create output channel to display error
				const outputChannel = vscode.window.createOutputChannel('RefinedC Verification');
				outputChannel.appendLine((error as Error).message);
				outputChannel.show();

				vscode.window.showErrorMessage('RefinedC verification failed. See output for details.');
			}
		});
	});

	// Command to start the MCP server
	const startMcpServerCommand = vscode.commands.registerCommand('refinedc-copilot.startMcpServer', async () => {
		// Create terminal to run the MCP server
		const terminal = vscode.window.createTerminal('RefinedC Copilot MCP Server');

		// Run the server using the CLI script
		terminal.sendText('cd refinedc-copilot && npm run mcp:server');
		terminal.show();

		vscode.window.showInformationMessage('RefinedC Copilot MCP Server started.');

		// Add message about integrating with LLMs
		vscode.window.showInformationMessage(
			'MCP Server is ready to be used with LLMs. Connect using the MCP protocol.'
		);
	});

	// New command: Generate annotations with Claude
	const generateWithLLMCommand = vscode.commands.registerCommand('refinedc-copilot.generateWithLLM', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showErrorMessage('No active editor!');
			return;
		}

		const document = editor.document;
		if (path.extname(document.fileName) !== '.c') {
			vscode.window.showErrorMessage('Not a C file!');
			return;
		}

		// Initialize MCP client if needed
		if (!mcpClient) {
			mcpClient = await startMcpServerAndConnect(context);
			if (!mcpClient) {
				vscode.window.showErrorMessage('Failed to start MCP server. Please check your environment setup.');
				return;
			}
		}

		// Get current function and file content
		const position = editor.selection.active;
		const functionName = await getCurrentFunctionName(document, position);
		let finalFunctionName = functionName;

		if (!finalFunctionName) {
			const userInput = await vscode.window.showInputBox({
				prompt: 'Enter function name to annotate with LLM',
				placeHolder: 'function_name'
			});

			if (!userInput) {
				return; // User cancelled
			}

			finalFunctionName = userInput;
		}

		// Show options dialog
		const options = await vscode.window.showQuickPick([
			{
				label: 'Basic Annotations',
				detail: 'Generate basic annotations without overflow checks',
				value: { considerOverflow: false, generatePostconditions: false }
			},
			{
				label: 'Full Annotations',
				detail: 'Generate complete annotations including overflow checks',
				value: { considerOverflow: true, generatePostconditions: true }
			},
		]);

		if (!options) {
			return; // User cancelled
		}

		// Show progress indicator
		vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: `Generating annotations with Claude for ${finalFunctionName}`,
			cancellable: false
		}, async (_progress) => {
			try {
				// Get source code
				const sourceCode = document.getText();

				// Call the MCP tool
				const result = await mcpClient?.callTool('generate-llm-annotations', {
					source: sourceCode,
					functionName: finalFunctionName,
					options: options.value
				});

				if (!result || !result.success) {
					vscode.window.showErrorMessage(`Failed to generate annotations: ${result?.message || 'Unknown error'}`);
					return;
				}

				// Show apply dialog
				const applyDirectly = await vscode.window.showQuickPick(['Yes', 'No'], {
					placeHolder: 'Apply annotations directly to file?'
				});

				if (applyDirectly === 'Yes') {
					// Apply annotations directly to the file
					const annotations = result.annotations;

					// Call utility to apply annotations
					const modifiedSource = await applyAnnotations(sourceCode, finalFunctionName, annotations);

					// Update the editor
					const fullRange = new vscode.Range(
						document.positionAt(0),
						document.positionAt(sourceCode.length)
					);

					const edit = new vscode.WorkspaceEdit();
					edit.replace(document.uri, fullRange, modifiedSource.message);
					await vscode.workspace.applyEdit(edit);

					vscode.window.showInformationMessage('Annotations applied successfully!');
				} else {
					// Show the annotations in a new document
					const annotationsDocument = await vscode.workspace.openTextDocument({
						content: result.annotations.join('\n'),
						language: 'c'
					});

					await vscode.window.showTextDocument(annotationsDocument);
				}
			} catch (error) {
				vscode.window.showErrorMessage(`Error: ${(error as Error).message}`);
			}
		});
	});

	// New command: Generate helper lemma with Claude
	const generateLemmaCommand = vscode.commands.registerCommand('refinedc-copilot.generateLemma', async () => {
		// Initialize MCP client if needed
		if (!mcpClient) {
			mcpClient = await startMcpServerAndConnect(context);
			if (!mcpClient) {
				vscode.window.showErrorMessage('Failed to start MCP server. Please check your environment setup.');
				return;
			}
		}

		// Prompt for RefinedC error output
		const errorOutput = await vscode.window.showInputBox({
			prompt: 'Paste RefinedC error output here',
			placeHolder: 'RefinedC error output...',
			// VS Code doesn't support multiline input boxes directly
			// We'll handle it with a simple prompt instead
		});

		if (!errorOutput) {
			return; // User cancelled
		}

		// Show progress indicator
		vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: 'Generating helper lemma with Claude',
			cancellable: false
		}, async (_progress) => {
			try {
				// Call the MCP tool
				const result = await mcpClient?.callTool('generate-llm-helper-lemma', {
					errorOutput
				});

				if (!result || !result.success) {
					vscode.window.showErrorMessage(`Failed to generate lemma: ${result?.message || 'Unknown error'}`);
					return;
				}

				// Get active document's file path
				const editor = vscode.window.activeTextEditor;
				let targetPath = '';

				if (editor && path.extname(editor.document.fileName) === '.c') {
					// Construct the lemma path based on the C file
					const sourcePath = editor.document.fileName;
					const fileName = path.basename(sourcePath, '.c');
					const dirName = path.dirname(sourcePath);

					// Check for artifacts directory
					const artifactsBaseDir = path.resolve(dirName, '..', 'artifacts');
					if (fs.existsSync(artifactsBaseDir)) {
						targetPath = path.join(artifactsBaseDir, `${fileName}_lemmas.v`);
					} else {
						// Fallback to same directory
						targetPath = path.join(dirName, `${fileName}_lemmas.v`);
					}
				} else {
					// Prompt for save location
					const saveLocation = await vscode.window.showSaveDialog({
						defaultUri: vscode.Uri.file(path.join(vscode.workspace.rootPath || '', 'lemma.v')),
						filters: {
							'Coq Files': ['v']
						}
					});

					if (!saveLocation) {
						// Just show the lemma in a new document
						const lemmaDocument = await vscode.workspace.openTextDocument({
							content: result.lemmaCode,
							language: 'coq'
						});

						await vscode.window.showTextDocument(lemmaDocument);
						return;
					}

					targetPath = saveLocation.fsPath;
				}

				// Save the lemma file
				fs.writeFileSync(targetPath, result.lemmaCode, 'utf8');

				// Open the saved file
				const lemmaDocument = await vscode.workspace.openTextDocument(targetPath);
				await vscode.window.showTextDocument(lemmaDocument);

				vscode.window.showInformationMessage(`Helper lemma saved to ${targetPath}`);
			} catch (error) {
				vscode.window.showErrorMessage(`Error: ${(error as Error).message}`);
			}
		});
	});

	// Register startAnnotationServer command
	let startAnnotationServerDisposable = vscode.commands.registerCommand(
		'refinedc-copilot.startAnnotationServer',
		async () => {
			try {
				const client = getAnnotationCompletionClient();
				const success = await client.start();

				if (success) {
					vscode.window.showInformationMessage('RefinedC Annotation Server started successfully');
				} else {
					vscode.window.showErrorMessage('Failed to start RefinedC Annotation Server');
				}
			} catch (error) {
				console.error('Error starting annotation server:', error);
				vscode.window.showErrorMessage(`Failed to start RefinedC Annotation Server: ${error}`);
			}
		}
	);
	context.subscriptions.push(startAnnotationServerDisposable);

	// Register all commands
	context.subscriptions.push(
		annotateCommand,
		verifyCommand,
		startMcpServerCommand,
		generateWithLLMCommand,
		generateLemmaCommand,
		startAnnotationServerDisposable
	);
}

/**
 * Try to determine the current function name from cursor position
 */
async function getCurrentFunctionName(document: vscode.TextDocument, position: vscode.Position): Promise<string | undefined> {
	// Simple approach: scan backwards until we find a function definition
	for (let line = position.line; line >= 0; line--) {
		const lineText = document.lineAt(line).text;
		const functionMatch = lineText.match(/\s*\w+\s+(\w+)\s*\([^)]*\)\s*\{/);

		if (functionMatch) {
			return functionMatch[1];
		}
	}

	return undefined;
}

// This method is called when your extension is deactivated
export function deactivate() {
	if (mcpClient) {
		mcpClient.disconnect();
		mcpClient = null;
	}
}
