/**
 * MCP Client for RefinedC Copilot
 *
 * This module provides a client for interacting with the MCP server through the
 * Model Context Protocol, enabling integration with LLMs like Claude.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Anthropic from '@anthropic-ai/sdk';
import * as path from 'path';
import * as fs from 'fs';
import * as childProcess from 'child_process';
import * as vscode from 'vscode';

/**
 * Wrapper for the MCP Client
 * Makes it easier to connect to and interact with MCP servers
 */
export class McpClientWrapper {
  private client: Client | null = null;
  private transport: StdioClientTransport | StreamableHTTPClientTransport | null = null;
  private childProcess: childProcess.ChildProcess | null = null;
  private isRunning: boolean = false;
  private serverType: 'stdio' | 'http';

  constructor(serverType: 'stdio' | 'http' = 'stdio') {
    this.serverType = serverType;
  }

  /**
   * Start the MCP server as a child process
   *
   * @param scriptPath - Path to the server script
   * @param args - Additional arguments for the server
   * @returns Success status
   */
  public async startServer(scriptPath: string, args: string[] = []): Promise<boolean> {
    if (this.isRunning) {
      console.log('Server is already running');
      return true;
    }

    try {
      const cwd = path.dirname(scriptPath);
      const command = path.basename(scriptPath);

      // Check if the script exists
      if (!fs.existsSync(scriptPath)) {
        console.error(`Server script not found: ${scriptPath}`);
        return false;
      }

      // Determine how to run the script based on its extension
      let executable = '';
      let execArgs: string[] = [];

      if (scriptPath.endsWith('.js')) {
        executable = 'node';
        execArgs = [command, ...args];
      } else if (scriptPath.endsWith('.ts')) {
        executable = 'ts-node';
        execArgs = [command, ...args];
      } else {
        // Assume executable
        executable = command;
        execArgs = args;
      }

      console.log(`Starting MCP server with: ${executable} ${execArgs.join(' ')}`);

      this.childProcess = childProcess.spawn(executable, execArgs, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
        env: process.env,
      });

      this.childProcess.stderr?.on('data', (data) => {
        console.error(`Server stderr: ${data}`);
      });

      this.childProcess.stdout?.on('data', (data) => {
        console.log(`Server stdout: ${data}`);
      });

      // Give the server a moment to start up
      await new Promise(resolve => setTimeout(resolve, 1000));

      return this.connect();
    } catch (error) {
      console.error('Failed to start MCP server:', error);
      return false;
    }
  }

  /**
   * Connect to an existing MCP server
   *
   * @param serverUrl - URL for HTTP transport (optional)
   * @returns Success status
   */
  public async connect(serverUrl?: string): Promise<boolean> {
    try {
      this.client = new Client({
        name: 'refinedc-copilot-client',
        version: '0.0.1',
      });

      if (this.serverType === 'stdio' && this.childProcess) {
        // Use Node's pipe-based transport handling
        this.transport = new StdioClientTransport({command: "tree"}); // TODO: make the actual command

        // Manually connect stdin/stdout
        if (this.childProcess.stdin && this.childProcess.stdout) {
          // The StdioClientTransport doesn't expose stdin/stdout directly
          // We need to use Node.js internals to connect the pipes
          if ('stdin' in this.transport && 'stdout' in this.transport) {
            // Use type assertion to access these properties
            const transport = this.transport as unknown as {
              stdin: NodeJS.WritableStream;
              stdout: NodeJS.ReadableStream;
            };

            // Connect the pipes
            this.childProcess.stdout.pipe(transport.stdin);
            transport.stdout.pipe(this.childProcess.stdin);
          } else {
            console.error('Failed to establish transport connection');
            return false;
          }
        }
      } else if (this.serverType === 'http' && serverUrl) {
        this.transport = new StreamableHTTPClientTransport(new URL(serverUrl));
      } else {
        console.error('Invalid server configuration');
        return false;
      }

      await this.client.connect(this.transport);
      this.isRunning = true;
      return true;
    } catch (error) {
      console.error('Failed to connect to MCP server:', error);
      return false;
    }
  }

  /**
   * Call a tool on the MCP server
   *
   * @param name - Tool name
   * @param arguments - Tool arguments
   * @returns Tool response
   */
  public async callTool<T = any>(name: string, toolArgs: Record<string, any>): Promise<T | null> {
    if (!this.client || !this.isRunning) {
      console.error('MCP client not connected');
      return null;
    }

    try {
      const result = await this.client.callTool({
        name,
        arguments: toolArgs,
      });

      // Properly type the message result and handle the content
      const content = result.content;
      if (Array.isArray(content)) {
        const textContent = content.find(block => block.type === 'text');
        if (textContent && 'text' in textContent) {
          return JSON.parse(textContent.text) as T;
        }
      }

      return null;
    } catch (error) {
      console.error(`Failed to call tool ${name}:`, error);
      return null;
    }
  }

  /**
   * List available tools on the server
   *
   * @returns List of tools
   */
  public async listTools(): Promise<string[] | null> {
    if (!this.client || !this.isRunning) {
      console.error('MCP client not connected');
      return null;
    }

    try {
      const result = await this.client.listTools();
      return result.tools.map(tool => tool.name);
    } catch (error) {
      console.error('Failed to list tools:', error);
      return null;
    }
  }

  /**
   * Get a prompt from the server
   *
   * @param name - Prompt name
   * @param arguments - Prompt arguments
   * @returns Prompt content
   */
  public async getPrompt(name: string, promptArgs: Record<string, any>): Promise<any> {
    if (!this.client || !this.isRunning) {
      console.error('MCP client not connected');
      return null;
    }

    try {
      return await this.client.getPrompt({
        name,
        arguments: promptArgs,
      });
    } catch (error) {
      console.error(`Failed to get prompt ${name}:`, error);
      return null;
    }
  }

  /**
   * Clean up and disconnect
   */
  public async disconnect(): Promise<void> {
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
    } catch (error) {
      console.error('Error during disconnect:', error);
    }
  }
}

// Create a VS Code output channel for MCP client operations
let mcpOutputChannel: vscode.OutputChannel | null = null;

/**
 * Get or create the MCP output channel
 */
export function getMcpOutputChannel(): vscode.OutputChannel {
  if (!mcpOutputChannel) {
    mcpOutputChannel = vscode.window.createOutputChannel('RefinedC Copilot MCP');
  }
  return mcpOutputChannel;
}

/**
 * Start an MCP server and connect a client to it
 *
 * @param context - VS Code extension context
 * @returns MCP client wrapper
 */
export async function startMcpServerAndConnect(
  context: vscode.ExtensionContext
): Promise<McpClientWrapper | null> {
  const outputChannel = getMcpOutputChannel();
  outputChannel.appendLine('Starting RefinedC Copilot MCP server...');

  // Get path to the server script
  const extensionPath = context.extensionPath;
  const serverScript = path.join(extensionPath, 'dist', 'scripts', 'server.js');

  const mcpClient = new McpClientWrapper();
  const success = await mcpClient.startServer(serverScript);

  if (!success) {
    outputChannel.appendLine('Failed to start MCP server');
    vscode.window.showErrorMessage('Failed to start RefinedC Copilot MCP server');
    return null;
  }

  outputChannel.appendLine('MCP server started and connected');
  return mcpClient;
}

/**
 * Connect to a running MCP server
 *
 * @param serverUrl - URL for HTTP transport
 * @returns MCP client wrapper
 */
export async function connectToMcpServer(
  serverUrl: string
): Promise<McpClientWrapper | null> {
  const outputChannel = getMcpOutputChannel();
  outputChannel.appendLine(`Connecting to MCP server at ${serverUrl}...`);

  const mcpClient = new McpClientWrapper('http');
  const success = await mcpClient.connect(serverUrl);

  if (!success) {
    outputChannel.appendLine('Failed to connect to MCP server');
    vscode.window.showErrorMessage(`Failed to connect to MCP server at ${serverUrl}`);
    return null;
  }

  outputChannel.appendLine('Connected to MCP server');
  return mcpClient;
}
