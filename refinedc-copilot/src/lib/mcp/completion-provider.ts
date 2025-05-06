/**
 * RefinedC Annotation Completion Provider
 *
 * Provides code completion suggestions for RefinedC annotations in VSCode
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { getAnnotationCompletionClient, AnnotationCompletion } from './annotation-completions';
import { extractFunctions } from '../utils/refinedc';

/**
 * CompletionProvider for RefinedC annotations
 */
export class RefinedCAnnotationCompletionProvider implements vscode.CompletionItemProvider {
  /**
   * Provide completion items for the given position in the document
   */
  public async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.CompletionItem[] | vscode.CompletionList | undefined> {
    // Only provide completions for C files
    if (path.extname(document.fileName) !== '.c') {
      return undefined;
    }

    // Check if the cursor is at a position where we want to show annotation completions
    const lineText = document.lineAt(position.line).text;
    const textBeforeCursor = lineText.substring(0, position.character);

    // Check if we're in a position to provide annotation completions
    if (this.shouldProvideCompletions(textBeforeCursor)) {
      try {
        const sourceCode = document.getText();
        const currentFunction = await this.getCurrentFunction(document, position);

        if (!currentFunction) {
          return this.provideBasicAnnotationCompletions();
        }

        // Get the completion client
        const client = getAnnotationCompletionClient();

        // Try to start the MCP server if it's not already running
        const serverScript = path.join(
          vscode.workspace.rootPath || '',
          'refinedc-copilot/src/scripts/annotation-server.ts'
        );

        // Start the server in the background if it's not running
        client.start().catch(err => {
          console.error('Failed to start annotation completion server:', err);
        });

        // Get completions from the server, or fall back to basic completions
        try {
          const serverCompletions = await client.getCompletions(
            sourceCode,
            currentFunction
          );

          if (serverCompletions.length > 0) {
            return this.convertToCompletionItems(serverCompletions);
          }
        } catch (err) {
          console.error('Error getting completions from server:', err);
        }

        // Fall back to basic completions
        return this.provideBasicAnnotationCompletions();
      } catch (error) {
        console.error('Error providing completions:', error);
        return undefined;
      }
    }

    return undefined;
  }

  /**
   * Decide whether to provide completions at the current position
   */
  private shouldProvideCompletions(textBeforeCursor: string): boolean {
    // Check for annotation start
    if (textBeforeCursor.trim().endsWith('[[')) {
      return true;
    }

    // Check for annotation type completion
    if (textBeforeCursor.trim().endsWith('[[rc::')) {
      return true;
    }

    // Check if we're inside an annotation
    const match = textBeforeCursor.match(/\[\[rc::\w*$/);
    if (match) {
      return true;
    }

    return false;
  }

  /**
   * Get the current function name at the given position
   */
  private async getCurrentFunction(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<string | undefined> {
    // Get all function definitions in the document
    try {
      const sourceCode = document.getText();
      const functions = await extractFunctions(sourceCode);

      // Find function that contains the current position
      for (const func of functions) {
        // Simple heuristic to find containing function
        const funcDefPos = sourceCode.indexOf(func.name);
        if (funcDefPos === -1) continue;

        const defDocPos = document.positionAt(funcDefPos);
        const openBracePos = sourceCode.indexOf('{', funcDefPos);

        if (openBracePos === -1) continue;

        let bracesCount = 1;
        let idx = openBracePos + 1;

        // Find matching closing brace to determine function end
        while (bracesCount > 0 && idx < sourceCode.length) {
          if (sourceCode[idx] === '{') bracesCount++;
          else if (sourceCode[idx] === '}') bracesCount--;
          idx++;
        }

        const endDocPos = document.positionAt(idx);

        // Check if position is inside this function definition range
        if (position.isAfterOrEqual(defDocPos) && position.isBeforeOrEqual(endDocPos)) {
          return func.name;
        }
      }
    } catch (error) {
      console.error('Error finding current function:', error);
    }

    return undefined;
  }

  /**
   * Provide basic annotation completions without server integration
   */
  private provideBasicAnnotationCompletions(): vscode.CompletionItem[] {
    // Get annotation type completions
    const completions = getAnnotationCompletionClient().getAnnotationTypeCompletions();
    return this.convertToCompletionItems(completions);
  }

  /**
   * Convert annotation completions to VSCode completion items
   */
  private convertToCompletionItems(
    completions: AnnotationCompletion[]
  ): vscode.CompletionItem[] {
    return completions.map(completion => {
      const item = new vscode.CompletionItem(completion.label, vscode.CompletionItemKind.Snippet);
      item.detail = completion.detail;
      item.documentation = new vscode.MarkdownString(completion.documentation);

      // Use insert text to support snippet syntax (with placeholders)
      item.insertText = new vscode.SnippetString(completion.insertText);

      return item;
    });
  }
}

/**
 * Register the RefinedC annotation completion provider
 */
export function registerCompletionProvider(context: vscode.ExtensionContext): void {
  // Register completion provider for C files
  const provider = new RefinedCAnnotationCompletionProvider();
  const disposable = vscode.languages.registerCompletionItemProvider(
    { language: 'c', scheme: 'file' },
    provider,
    '[', // Trigger completion when [ is typed
    'r', // and when 'r' is typed (for rc::)
    ':', // and when ':' is typed
    ' '  // and when space is typed
  );

  context.subscriptions.push(disposable);
}
