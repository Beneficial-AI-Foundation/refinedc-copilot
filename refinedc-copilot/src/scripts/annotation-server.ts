#!/usr/bin/env ts-node
/**
 * RefinedC Annotation Completion Server
 *
 * MCP server dedicated to handling annotation completion requests.
 * This server is lighter-weight than the full server and focused on completions.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Command } from 'commander';
import { z } from 'zod';
import * as path from 'path';
import * as fs from 'fs';
import { promisify } from 'util';

const readFile = promisify(fs.readFile);

// Define the schema for annotation generation
const GenerateAnnotationsSchema = z.object({
  source: z.string(),
  functionName: z.string(),
  options: z.object({
    considerOverflow: z.boolean().optional(),
    generatePreconditions: z.boolean().optional(),
    generatePostconditions: z.boolean().optional(),
  }).optional(),
});

// Type mapping
const typeMap: Record<string, string> = {
  'int': 'int<i32>',
  'unsigned': 'int<u32>',
  'unsigned int': 'int<u32>',
  'char': 'int<i8>',
  'unsigned char': 'int<u8>',
  'long': 'int<i64>',
  'unsigned long': 'int<u64>',
  'void': 'void',
};

/**
 * Run the annotation completion server
 *
 * @param options Server options
 */
export async function runServer(options: { verbose: boolean } = { verbose: false }): Promise<void> {
  if (options.verbose) {
    console.log('Starting RefinedC annotation completion server...');
  }

  // Create server instance
  const server = new McpServer({
    name: 'RefinedC Annotation Completions',
    version: '0.0.1',
  });

  // Tool: Generate annotations for completions
  server.tool(
    'generate-annotations',
    GenerateAnnotationsSchema.shape,
    async ({ source, functionName, options = {} }) => {
      try {
        // Extract function signature for basic analysis
        const functionSignatureRegex = new RegExp(`[\\s\\n]+(\\w+\\s+${functionName}\\s*\\(([^)]*)\\))\\s*\\{`, 'g');
        const signatureMatch = functionSignatureRegex.exec(source);

        if (!signatureMatch || !signatureMatch[1] || !signatureMatch[2]) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: false,
                message: `Could not extract function signature for ${functionName}`
              })
            }],
            isError: true
          };
        }

        const signature = signatureMatch[1];
        const returnTypeMatch = signature.match(/^(\w+)\s+/);
        const returnType = returnTypeMatch ? returnTypeMatch[1] : 'void';
        const params = signatureMatch[2].split(',').map(p => p.trim()).filter(p => p);

        // Extract parameter types and names
        const paramInfo = params.map(param => {
          const parts = param.split(/\s+/);
          const name = parts.length > 1 ? parts[parts.length - 1] : parts[0];
          const type = parts.length > 1 ? parts.slice(0, -1).join(' ') : 'int';
          const isUnsigned = type.includes('unsigned');
          return {
            name,
            type,
            refinedType: typeMap[type] || (isUnsigned ? 'int<u32>' : 'int<i32>')
          };
        });

        // Extract function body for analysis
        const functionBodyRegex = new RegExp(`[\\s\\n]+\\w+\\s+${functionName}\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\}`, 'g');
        const bodyMatch = functionBodyRegex.exec(source);
        const functionBody = bodyMatch ? bodyMatch[1] : '';

        // Create an array of annotations
        const annotations = [];

        // Generate parameter variables for refinement types
        if (paramInfo.length > 0 && (options.considerOverflow || options.generatePreconditions)) {
          const paramVariables = paramInfo.map(p => `n${p.name} : nat`).join(', ');
          annotations.push({
            type: 'parameters',
            content: paramVariables
          });
        }

        // Generate argument types with refinement
        if (paramInfo.length > 0) {
          const argTypes = paramInfo.map(p => {
            if (options.considerOverflow || options.generatePreconditions) {
              return `"n${p.name} @ ${p.refinedType}"`;
            } else {
              return `"${p.refinedType}"`;
            }
          }).join(', ');

          annotations.push({
            type: 'args',
            content: argTypes
          });
        }

        // Generate return type
        const isUnsignedReturn = returnType.includes('unsigned');
        const refinedReturnType = typeMap[returnType] || (isUnsignedReturn ? 'int<u32>' : 'int<i32>');

        if (options.generatePostconditions && paramInfo.length > 0) {
          // Simple heuristic: if the function has params, maybe it computes something with them
          annotations.push({
            type: 'returns',
            content: `"{nresult} @ ${refinedReturnType}"`
          });
        } else {
          annotations.push({
            type: 'returns',
            content: `"${refinedReturnType}"`
          });
        }

        // Check function body for operations that might cause overflow
        if (functionBody && options.considerOverflow) {
          const hasAddition = functionBody.includes('+');
          const hasMultiplication = functionBody.includes('*');

          // Generate requires clauses for overflow prevention
          if ((hasAddition || hasMultiplication) && paramInfo.length >= 2) {
            const requiresClauses: string[] = [];

            if (hasAddition && paramInfo.length >= 2) {
              requiresClauses.push(`"{n${paramInfo[0].name} + n${paramInfo[1].name} ≤ max_int u32}"`);

              if (paramInfo.length >= 3) {
                requiresClauses.push(`"{(n${paramInfo[0].name} + n${paramInfo[1].name}) + n${paramInfo[2].name} ≤ max_int u32}"`);
              }
            }

            if (hasMultiplication && paramInfo.length >= 2) {
              requiresClauses.push(`"{n${paramInfo[0].name} * n${paramInfo[1].name} ≤ max_int u32}"`);
            }

            if (requiresClauses.length > 0) {
              annotations.push({
                type: 'requires',
                content: requiresClauses.join(', ')
              });
            }
          }
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              annotations,
              explanation: 'Generated annotations based on function signature and options'
            })
          }]
        };
      } catch (error) {
        const err = error as Error;
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: false,
              message: `Error generating annotations: ${err.message}`
            })
          }],
          isError: true
        };
      }
    }
  );

  // Start receiving messages on stdin and sending messages on stdout
  const transport = new StdioServerTransport();
  await server.connect(transport);

  if (options.verbose) {
    console.log('RefinedC annotation completion server started');
  }
}

// Setup CLI using Commander
const program = new Command();

program
  .name('annotation-server')
  .description('RefinedC Annotation Completion Server - Provides completions for RefinedC annotations')
  .version('0.0.1')
  .option('-v, --verbose', 'Enable verbose logging', false)
  .action(async (options) => {
    try {
      await runServer(options);
    } catch (error) {
      console.error('Error starting annotation completion server:', error);
      process.exit(1);
    }
  });

// Parse command line arguments
if (require.main === module) {
  program.parse();
}
