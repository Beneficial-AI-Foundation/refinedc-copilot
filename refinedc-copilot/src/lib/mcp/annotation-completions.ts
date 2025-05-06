/**
 * MCP Client for RefinedC Annotation Completions
 *
 * This module provides a client that connects to an MCP server to provide
 * intelligent code completions for RefinedC annotations.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as path from 'path';
import * as fs from 'fs';
import * as childProcess from 'child_process';
import * as vscode from 'vscode';
import { Annotation } from '../types';

/**
 * Annotation completion types that can be suggested
 */
export type AnnotationType = 'args' | 'returns' | 'parameters' | 'requires';

/**
 * Annotation completion suggestion
 */
export interface AnnotationCompletion {
  type: AnnotationType;
  label: string;
  detail: string;
  documentation: string;
  insertText: string;
}

/**
 * Client for getting annotation completions via MCP
 */
export class AnnotationCompletionClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | StreamableHTTPClientTransport | null = null;
  private childProcess: childProcess.ChildProcess | null = null;
  private isRunning: boolean = false;
  private outputChannel: vscode.OutputChannel;

  constructor() {
    this.outputChannel = vscode.window.createOutputChannel('RefinedC Annotation Completions');
  }

  /**
   * Start the MCP server for annotation completions
   *
   * @param scriptPath Path to the server script (optional)
   * @returns Success status
   */
  public async start(scriptPath?: string): Promise<boolean> {
    if (this.isRunning) {
      this.log('Annotation completion server is already running');
      return true;
    }

    try {
      // Use the annotation-server.ts script by default
      const serverScript = scriptPath || path.join(
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
        'refinedc-copilot/src/scripts/annotation-server.ts'
      );

      const cwd = path.dirname(serverScript);
      const command = path.basename(serverScript);

      // Check if the script exists
      if (!fs.existsSync(serverScript)) {
        this.error(`Server script not found: ${serverScript}`);
        return false;
      }

      // Determine how to run the script based on its extension
      let executable = '';
      let execArgs: string[] = [];

      if (serverScript.endsWith('.js')) {
        executable = 'node';
        execArgs = [command, '--verbose'];
      } else if (serverScript.endsWith('.ts')) {
        executable = 'ts-node';
        execArgs = [command, '--verbose'];
      } else {
        // Assume executable
        executable = command;
        execArgs = ['--verbose'];
      }

      this.log(`Starting annotation completion server with: ${executable} ${execArgs.join(' ')}`);

      this.childProcess = childProcess.spawn(executable, execArgs, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
        env: process.env,
      });

      this.childProcess.stderr?.on('data', (data) => {
        this.error(`Server stderr: ${data}`);
      });

      this.childProcess.stdout?.on('data', (data) => {
        this.log(`Server stdout: ${data}`);
      });

      // Give the server a moment to start up
      await new Promise(resolve => setTimeout(resolve, 1000));

      return this.connect();
    } catch (error) {
      this.error(`Failed to start annotation completion server: ${error}`);
      return false;
    }
  }

  /**
   * Connect to the MCP server
   *
   * @returns Success status
   */
  private async connect(): Promise<boolean> {
    try {
      this.client = new Client({
        name: 'refinedc-annotation-completion-client',
        version: '0.0.1',
      });

      if (this.childProcess) {
        // Create a transport with dummy command (not actually used)
        this.transport = new StdioClientTransport({command: "tree"});

        // The StdioClientTransport doesn't expose stdin/stdout directly
        // We need to use Node.js internals to connect the pipes
        if (this.childProcess.stdin && this.childProcess.stdout &&
            'stdin' in this.transport && 'stdout' in this.transport) {
          // Use type assertion to access these properties
          const transport = this.transport as unknown as {
            stdin: NodeJS.WritableStream;
            stdout: NodeJS.ReadableStream;
          };

          // Connect the pipes
          this.childProcess.stdout.pipe(transport.stdin);
          transport.stdout.pipe(this.childProcess.stdin);
        } else {
          this.error('Failed to establish transport connection');
          return false;
        }
      } else {
        this.error('Invalid server configuration');
        return false;
      }

      await this.client.connect(this.transport);
      this.isRunning = true;
      return true;
    } catch (error) {
      this.error(`Failed to connect to annotation completion server: ${error}`);
      return false;
    }
  }

  /**
   * Get annotation completions for a function
   *
   * @param sourceCode Source code content
   * @param functionName Function name
   * @returns List of annotation completions
   */
  public async getCompletions(
    sourceCode: string,
    functionName: string
  ): Promise<AnnotationCompletion[]> {
    if (!this.client || !this.isRunning) {
      this.error('Annotation completion client not connected');
      return [];
    }

    try {
      // Call the MCP tool to get annotation suggestions
      const result = await this.client.callTool({
        name: 'generate-annotations',
        arguments: {
          source: sourceCode,
          functionName,
          options: {
            considerOverflow: true,
            generatePreconditions: true,
            generatePostconditions: true
          }
        }
      });

      // Extract annotation suggestions from the result
      const content = result.content;
      if (Array.isArray(content)) {
        const textContent = content.find(block => block.type === 'text');
        if (textContent && 'text' in textContent) {
          const parsedResult = JSON.parse(textContent.text);
          if (parsedResult.success && parsedResult.annotations) {
            return this.formatCompletions(parsedResult.annotations);
          }
        }
      }

      return [];
    } catch (error) {
      this.error(`Failed to get annotation completions: ${error}`);
      return [];
    }
  }

  /**
   * Format annotations as completion items
   *
   * @param annotations Annotations from the server
   * @returns Formatted completion items
   */
  private formatCompletions(annotations: Annotation[]): AnnotationCompletion[] {
    return annotations.map(annotation => {
      let detail = '';
      let documentation = '';

      switch (annotation.type) {
        case 'args':
          detail = 'Function argument types';
          documentation = 'Specifies the types of the function arguments';
          break;
        case 'returns':
          detail = 'Function return type';
          documentation = 'Specifies the return type of the function';
          break;
        case 'parameters':
          detail = 'Type parameters';
          documentation = 'Defines universal parameters used in refinement types';
          break;
        case 'requires':
          detail = 'Function preconditions';
          documentation = 'Specifies conditions that must be true before the function executes';
          break;
      }

      return {
        type: annotation.type,
        label: `[[rc::${annotation.type}(${annotation.content})]]`,
        detail,
        documentation,
        insertText: `[[rc::${annotation.type}(${annotation.content})]]`
      };
    });
  }

  /**
   * Provide completions for annotation types
   *
   * @returns List of annotation type completions
   */
  public getAnnotationTypeCompletions(): AnnotationCompletion[] {
    return [
      {
        type: 'args',
        label: '[[rc::args(...)]]',
        detail: 'Specify function argument types',
        documentation: 'Used to annotate argument types for RefinedC verification',
        insertText: '[[rc::args("${1:type1}", "${2:type2}")]]'
      },
      {
        type: 'returns',
        label: '[[rc::returns(...)]]',
        detail: 'Specify function return type',
        documentation: 'Used to annotate return type for RefinedC verification',
        insertText: '[[rc::returns("${1:type}")]]'
      },
      {
        type: 'parameters',
        label: '[[rc::parameters(...)]]',
        detail: 'Specify type parameters',
        documentation: 'Used to define universally quantified variables for refinement types',
        insertText: '[[rc::parameters("${1:param1} : ${2:type1}", "${3:param2} : ${4:type2}")]]'
      },
      {
        type: 'requires',
        label: '[[rc::requires(...)]]',
        detail: 'Specify function preconditions',
        documentation: 'Used to define conditions that must be satisfied before function execution',
        insertText: '[[rc::requires("{${1:condition1}}", "{${2:condition2}}")]]'
      }
    ];
  }

  /**
   * Clean up and disconnect
   */
  public async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    try {
      if (this.client) {
        await this.client.close();
        this.client = null;
      }

      if (this.childProcess) {
        this.childProcess.kill();
        this.childProcess = null;
      }

      this.isRunning = false;
      this.log('Annotation completion client stopped');
    } catch (error) {
      this.error(`Error during disconnect: ${error}`);
    }
  }

  /**
   * Log message to output channel
   */
  private log(message: string): void {
    this.outputChannel.appendLine(`[INFO] ${message}`);
  }

  /**
   * Log error to output channel
   */
  private error(message: string): void {
    this.outputChannel.appendLine(`[ERROR] ${message}`);
  }
}

// Singleton instance of the annotation completion client
let annotationCompletionClient: AnnotationCompletionClient | null = null;

/**
 * Get or create the annotation completion client
 *
 * @returns The annotation completion client
 */
export function getAnnotationCompletionClient(): AnnotationCompletionClient {
  if (!annotationCompletionClient) {
    annotationCompletionClient = new AnnotationCompletionClient();
  }
  return annotationCompletionClient;
}
