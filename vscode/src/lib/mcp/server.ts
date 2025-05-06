/**
 * RefinedC Copilot MCP Server
 *
 * This MCP server provides tools for working with RefinedC,
 * including generating annotations and helper lemmas.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as path from 'path';
import * as fs from 'fs';
import { promisify } from 'util';
import { z } from 'zod';

import {
  InitProjectSchema,
  AnnotateFunctionSchema,
  GenerateHelperLemmaSchema,
  CheckFileSchema,
  ApplyAnnotationsSchema,
  Annotation,
} from '../types';

import {
  initProject,
  checkFile,
  extractFunctions,
  applyAnnotations,
} from '../utils/refinedc';

import {
  generateHelperLemma,
  saveHelperLemma,
  verifyHelperLemma,
  extractProofObligations,
  generateCompleteHelperFile,
} from '../utils/coqc';

import { llmService } from '../llm-service';

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const stat = promisify(fs.stat);
const mkdir = promisify(fs.mkdir);

// Define the schema for proof obligations extraction
const ExtractProofObligationsSchema = z.object({
  errorOutput: z.string()
});

// Define a schema for LLM annotation generation
const GenerateLLMAnnotationsSchema = z.object({
  source: z.string(),
  functionName: z.string(),
  useExistingAnnotations: z.boolean().optional(),
  options: z.object({
    considerOverflow: z.boolean().optional(),
    generatePreconditions: z.boolean().optional(),
    generatePostconditions: z.boolean().optional(),
  }).optional(),
});

// Define a schema for using an external LLM to generate annotations
const UseLLMForAnnotationsSchema = z.object({
  sourcePath: z.string(),
  functionName: z.string(),
  options: z.object({
    considerErrorMessages: z.boolean().optional(),
    applyAnnotationsDirectly: z.boolean().optional(),
  }).optional(),
});

// Define a new schema for getting RefinedC annotation documentation
const GetAnnotationDocsSchema = z.object({
  annotationType: z.enum(['args', 'returns', 'parameters', 'requires', 'ensures']).optional()
});

// Schema for AI-powered annotation with documentation context
const SmartAnnotateSchema = z.object({
  sourceCode: z.string(),
  functionName: z.string(),
  options: z.object({
    considerOverflow: z.boolean().optional(),
    generatePostconditions: z.boolean().optional(),
    includeExplanations: z.boolean().optional()
  }).optional()
});

/**
 * Create and run the RefinedC Copilot MCP Server
 */
export async function runServer(): Promise<void> {
  // Create server instance
  const server = new McpServer({
    name: 'RefinedC Copilot',
    version: '0.0.1',
  });

  // Define a prompt template for generating RefinedC annotations
  server.prompt(
    'generate-annotations',
    {
      sourceCode: z.string(),
      functionName: z.string(),
      functionSignature: z.string().optional(),
      functionBody: z.string().optional(),
      errorMessages: z.string().optional(),
    },
    ({ sourceCode, functionName, functionSignature, functionBody, errorMessages }) => {
      // Default prompt message
      let promptMessage = `
Please analyze this C function and suggest RefinedC annotations for it:

Function Name: ${functionName}

C Source Code:
\`\`\`c
${sourceCode}
\`\`\`

Generate appropriate RefinedC annotations that specify:
1. The types of arguments using [[rc::args(...)]]
2. The return type using [[rc::returns(...)]]
3. Any needed parameters using [[rc::parameters(...)]]
4. Any required preconditions using [[rc::requires(...)]]

Pay special attention to potential overflow issues with arithmetic operations. Use refinement types where appropriate.

NOTE: I can help generate annotations automatically using Claude's AI capabilities. Let me know if you would like me to do this.
      `.trim();

      // Enhanced prompt if we have extra information
      if (functionSignature || functionBody) {
        promptMessage = `
Please analyze this C function and suggest RefinedC annotations for it:

Function Name: ${functionName}

Function Signature:
\`\`\`c
${functionSignature || 'Not provided'}
\`\`\`

Function Body:
\`\`\`c
${functionBody || 'Not provided'}
\`\`\`

${errorMessages ? `RefinedC reported the following errors:\n${errorMessages}\n\n` : ''}

Generate appropriate RefinedC annotations that specify:
1. The types of arguments using [[rc::args(...)]]
2. The return type using [[rc::returns(...)]]
3. Any needed parameters using [[rc::parameters(...)]]
4. Any required preconditions using [[rc::requires(...)]]

Pay special attention to potential overflow issues with arithmetic operations. Use refinement types where appropriate.

NOTE: I can help generate annotations automatically using Claude's AI capabilities. Let me know if you would like me to do this.
      `.trim();
      }

      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: promptMessage
            }
          }
        ]
      };
    }
  );

  // Expose source files as resources
  server.resource(
    'source-file',
    new ResourceTemplate('file://{filepath*}', { list: undefined }),
    async (uri, { filepath }) => {
      try {
        // Ensure filepath is safe (no traversal attacks)
        // Handle both string and string[] cases
        const filepathStr = Array.isArray(filepath) ? filepath.join('/') : filepath;
        const normalizedPath = path.normalize(filepathStr);
        if (normalizedPath.includes('..')) {
          throw new Error('Path traversal not allowed');
        }

        const content = await readFile(normalizedPath, 'utf8');
        return {
          contents: [{
            uri: uri.href,
            text: content
          }]
        };
      } catch (error) {
        const err = error as Error;
        throw new Error(`Failed to read file: ${err.message}`);
      }
    }
  );

  // Tool: Initialize a RefinedC project
  server.tool(
    'init-project',
    InitProjectSchema.shape,
    async ({ projectPath }) => {
      const result = await initProject(projectPath);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result)
        }],
        isError: !result.success
      };
    }
  );

  // Tool: Check a C file with RefinedC
  server.tool(
    'check-file',
    CheckFileSchema.shape,
    async ({ filePath }) => {
      const result = await checkFile(filePath);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result)
        }],
        isError: !result.success
      };
    }
  );

  // Tool: Generate function annotations
  server.tool(
    'annotate-function',
    AnnotateFunctionSchema.shape,
    async ({ source, functionName }) => {
      try {
        // Parse the C code to find the target function
        // For this example, we'll use a simpler approach
        // In a real implementation, this would use a proper C parser
        const functionRegex = new RegExp(`[\\s\\n]+(\\w+\\s+${functionName}\\s*\\([^)]*\\))\\s*\\{`, 'g');
        const match = functionRegex.exec(source);

        if (!match) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: false,
                message: `Function ${functionName} not found in source code`
              })
            }],
            isError: true
          };
        }

        // Generate annotations based on function signature
        const signature = match[1];
        const returnTypeMatch = signature.match(/^(\w+)\s+/);
        const returnType = returnTypeMatch ? returnTypeMatch[1] : 'void';

        const paramsMatch = signature.match(/\(([^)]*)\)/);
        const params = paramsMatch ? paramsMatch[1].split(',') : [];

        // Simple type mapping - in a real implementation this would be more sophisticated
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

        const returnRefinedType = typeMap[returnType] || 'int<i32>';

        // Generate parameter types
        const paramTypes = params.map(param => {
          const trimmed = param.trim();
          if (!trimmed) { return ''; }

          const parts = trimmed.split(/\s+/);
          const type = parts.length > 1 ? parts.slice(0, -1).join(' ') : 'int';
          return typeMap[type] || 'int<i32>';
        }).filter(t => t);

        // Generate basic annotations
        const annotations = [
          {
            type: 'args' as const,
            content: paramTypes.map(t => `"${t}"`).join(', ')
          },
          {
            type: 'returns' as const,
            content: returnRefinedType
          }
        ];

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              functionName,
              annotations
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
              message: `Failed to generate annotations: ${err.message}`
            })
          }],
          isError: true
        };
      }
    }
  );

  // Tool: Apply annotations to a C file
  server.tool(
    'apply-annotations',
    ApplyAnnotationsSchema.shape,
    async ({ sourcePath, targetPath, annotations }) => {
      const result = await applyAnnotations(sourcePath, targetPath, annotations);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result)
        }],
        isError: !result.success
      };
    }
  );

  // Tool: Generate helper lemma
  server.tool(
    'generate-helper-lemma',
    GenerateHelperLemmaSchema.shape,
    async ({ errorMessage, sourcePath }) => {
      try {
        // Generate the lemma content based on the error message
        const lemmaContent = generateHelperLemma(errorMessage);

        // Save the lemma to the appropriate file
        const saveResult = await saveHelperLemma(sourcePath, lemmaContent);
        if (!saveResult.success) {
          throw new Error(saveResult.message);
        }

        // Verify the lemma compiles with coqc
        const verifyResult = await verifyHelperLemma(sourcePath);

        // Return the combined result
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: verifyResult.success,
              message: verifyResult.success
                ? `Helper lemma created and verified successfully`
                : `Helper lemma created but failed verification: ${verifyResult.message}`,
              lemmaContent,
              verificationOutput: verifyResult.output
            })
          }],
          isError: !verifyResult.success
        };
      } catch (error) {
        const err = error as Error;
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: false,
              message: `Failed to generate helper lemma: ${err.message}`
            })
          }],
          isError: true
        };
      }
    }
  );

  // Tool: Extract proof obligations from RefinedC error output
  server.tool(
    'extract-proof-obligations',
    ExtractProofObligationsSchema.shape,
    async ({ errorOutput }) => {
      try {
        const obligations = extractProofObligations(errorOutput);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              count: obligations.length,
              obligations
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
              message: `Failed to extract proof obligations: ${err.message}`
            })
          }],
          isError: true
        };
      }
    }
  );

  // Tool: Generate annotations using LLM
  server.tool(
    'generate-llm-annotations',
    GenerateLLMAnnotationsSchema.shape,
    async ({ source, functionName, options }) => {
      try {
        if (!llmService.isInitialized()) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: false,
                message: 'LLM service not initialized. Check ANTHROPIC_API_KEY in .env file.'
              })
            }],
            isError: true
          };
        }

        // Extract function signature and body for better context
        const functionSignatureRegex = new RegExp(`[\\s\\n]+(\\w+\\s+${functionName}\\s*\\(([^)]*)\\))\\s*\\{`, 'g');
        const signatureMatch = functionSignatureRegex.exec(source);
        const functionSignature = signatureMatch ? signatureMatch[1] : undefined;

        // Extract function body for more accurate analysis
        const functionBodyRegex = new RegExp(`[\\s\\n]+\\w+\\s+${functionName}\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\}`, 'g');
        const bodyMatch = functionBodyRegex.exec(source);
        const functionBody = bodyMatch ? bodyMatch[1] : undefined;

        // Enhanced context for the LLM
        const contextOptions = {
          ...options || {},
          functionSignature,
          functionBody
        };

        // Use the llmService to generate annotations
        const result = await llmService.generateAnnotations(
          source,
          functionName,
          contextOptions
        );

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              annotations: result.annotations,
              explanation: result.explanation
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
              message: `Failed to generate annotations: ${err.message}`
            })
          }],
          isError: true
        };
      }
    }
  );

  // Tool: Generate helper lemma using LLM
  server.tool(
    'generate-llm-helper-lemma',
    ExtractProofObligationsSchema.shape,
    async ({ errorOutput }) => {
      try {
        if (!llmService.isInitialized()) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: false,
                message: 'LLM service not initialized. Check ANTHROPIC_API_KEY in .env file.'
              })
            }],
            isError: true
          };
        }

        // Get source code from the error message if available
        let sourceCode = '';
        const sourceCodeMatch = errorOutput.match(/Source Code:([\s\S]+?)(?=Error:|$)/i);
        if (sourceCodeMatch && sourceCodeMatch[1]) {
          sourceCode = sourceCodeMatch[1].trim();
        }

        const lemmaCode = await llmService.generateHelperLemma(errorOutput, sourceCode);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              lemmaCode
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
              message: `Failed to generate helper lemma: ${err.message}`
            })
          }],
          isError: true
        };
      }
    }
  );

  // Tool: Use LLM to generate function annotations
  server.tool(
    'use-llm-for-annotations',
    UseLLMForAnnotationsSchema.shape,
    async ({ sourcePath, functionName, options = {} }) => {
      try {
        // Read the source file
        const source = await readFile(sourcePath, 'utf8');

        // Extract function signature and body for better analysis
        const functionSignatureRegex = new RegExp(`[\\s\\n]+(\\w+\\s+${functionName}\\s*\\(([^)]*)\\))\\s*\\{`, 'g');
        const signatureMatch = functionSignatureRegex.exec(source);
        const functionSignature = signatureMatch ? signatureMatch[1] : undefined;

        // Extract function body for more accurate analysis
        const functionBodyRegex = new RegExp(`[\\s\\n]+\\w+\\s+${functionName}\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\}`, 'g');
        const bodyMatch = functionBodyRegex.exec(source);
        const functionBody = bodyMatch ? bodyMatch[1] : undefined;

        // Get error messages if option is enabled
        let errorMessages = undefined;
        if (options.considerErrorMessages) {
          // Check the file with RefinedC to see if there are errors
          const checkResult = await checkFile(sourcePath);
          if (!checkResult.success && checkResult.errors) {
            errorMessages = checkResult.errors.join('\n');
          }
        }

        // Prepare the result object
        let result = {
          success: false,
          message: '',
          annotations: [] as Annotation[]
        };

        try {
          // Implement basic annotation generation directly
          // Extract function signature for basic analysis
          const functionSignatureRegex = new RegExp(`[\\s\\n]+(\\w+\\s+${functionName}\\s*\\(([^)]*)\\))\\s*\\{`, 'g');
          const signatureMatch = functionSignatureRegex.exec(source);

          if (signatureMatch && signatureMatch[1] && signatureMatch[2]) {
            const signature = signatureMatch[1];
            const returnTypeMatch = signature.match(/^(\w+)\s+/);
            const returnType = returnTypeMatch ? returnTypeMatch[1] : 'void';
            const params = signatureMatch[2].split(',').map(p => p.trim()).filter(p => p);

            // Simple type mapping
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

            // Create a local array of annotations
            const generatedAnnotations: Annotation[] = [];

            // Generate parameter variables for refinement types
            if (paramInfo.length > 0) {
              const paramVariables = paramInfo.map(p => `n${p.name} : nat`).join(', ');
              generatedAnnotations.push({
                type: 'parameters',
                content: paramVariables
              });
            }

            // Generate argument types with refinement
            if (paramInfo.length > 0) {
              const argTypes = paramInfo.map(p => `"n${p.name} @ ${p.refinedType}"`).join(', ');
              generatedAnnotations.push({
                type: 'args',
                content: argTypes
              });
            }

            // Generate return type
            const isUnsignedReturn = returnType.includes('unsigned');
            const refinedReturnType = typeMap[returnType] || (isUnsignedReturn ? 'int<u32>' : 'int<i32>');
            generatedAnnotations.push({
              type: 'returns',
              content: `"${refinedReturnType}"`
            });

            // Check function body for operations that might cause overflow
            if (functionBody) {
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
                  generatedAnnotations.push({
                    type: 'requires',
                    content: requiresClauses.join(', ')
                  });
                }
              }
            }

            result = {
              success: true,
              message: 'Generated annotations using basic algorithm',
              annotations: generatedAnnotations
            };
          } else {
            result.message = `Could not extract function signature for ${functionName}`;
          }
        } catch (analysisError) {
          console.error('Error in annotation analysis:', analysisError);
          result.message = `Error analyzing function: ${(analysisError as Error).message}`;
        }

        // Apply the annotations if requested
        if (result.success && options.applyAnnotationsDirectly) {
          try {
            // Apply the annotations to the file
            const applyResult = await applyAnnotations(sourcePath, sourcePath, [
              { functionName, annotations: result.annotations }
            ]);

            if (applyResult.success) {
              result.message += ' and applied them to the source file';
            } else {
              result.message += ' but failed to apply them: ' + applyResult.message;
            }
          } catch (applyError) {
            console.error('Error applying annotations:', applyError);
            result.message += ` but failed to apply them: ${(applyError as Error).message}`;
          }
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result)
          }]
        };
      } catch (error) {
        const err = error as Error;
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: false,
              message: `Failed to use LLM for annotations: ${err.message}`
            })
          }],
          isError: true
        };
      }
    }
  );

  // Resource: RefinedC annotation documentation
  server.resource(
    'refinedc-annotations',
    new ResourceTemplate('refinedc://annotations/{annotationType?}', { list: undefined }),
    async (uri, { annotationType }) => {
      // Basic documentation for each annotation type
      const docs: Record<string, string> = {
        args: `
# RefinedC Argument Annotations
Arguments in RefinedC are annotated using the \`[[rc::args(...)]\` annotation.

Example:
\`\`\`c
[[rc::args(int<i32> x, int<i32> y, int<i32>* result)]]
int add(int x, int y, int* result);
\`\`\`

Common refinement types:
- \`int<i32>\` - 32-bit signed integer
- \`int<u32>\` - 32-bit unsigned integer
- \`int<i64>\` - 64-bit signed integer
- \`int<u64>\` - 64-bit unsigned integer
- \`ptr(T)\` - Pointer to type T
- \`array(T, n)\` - Array of T with length n
- \`option<T>\` - Optional value of type T
`,
        returns: `
# RefinedC Return Type Annotations
Return types in RefinedC are annotated using the \`[[rc::returns(...)]]\` annotation.

Example:
\`\`\`c
[[rc::returns(int<i32>)]]
int sum(int x, int y);
\`\`\`

Common return refinement types:
- \`int<i32>\` - 32-bit signed integer
- \`int<u32>\` - 32-bit unsigned integer
- \`void\` - No return value
- \`option<T>\` - Optional value of type T
`,
        parameters: `
# RefinedC Parameter Annotations
Parameters in RefinedC are declared using the \`[[rc::parameters(...)]]\` annotation.

Example:
\`\`\`c
[[rc::parameters(n: nat)]]
[[rc::args(array(int<i32>, n) arr)]]
int sum_array(int* arr, size_t len);
\`\`\`

Common parameters:
- \`n: nat\` - Natural number
- \`p: perm\` - Permission
- \`t: type\` - Type parameter
`,
        requires: `
# RefinedC Precondition Annotations
Preconditions in RefinedC are specified using the \`[[rc::requires(...)]]\` annotation.

Example:
\`\`\`c
[[rc::requires(x + y <= MAX_INT)]]
int add(int x, int y);
\`\`\`

Common preconditions:
- Bounds checking: \`x <= MAX_INT - y\` to prevent overflow
- Non-null pointers: \`p != NULL\`
- Array bounds: \`0 <= i < n\` for array accesses
`,
        ensures: `
# RefinedC Postcondition Annotations
Postconditions in RefinedC are specified using the \`[[rc::ensures(...)]]\` annotation.

Example:
\`\`\`c
[[rc::ensures(ret == x + y)]]
int add(int x, int y);
\`\`\`

Common postconditions:
- Return value properties: \`ret == x + y\`
- Modified argument state: \`*result == old(x) + old(y)\`
- Bounds guarantees: \`0 <= ret < n\`
`
      };

      // General documentation if no specific type is requested
      const generalDocs = `
# RefinedC Annotations
RefinedC uses C2X annotations to specify formal properties of C code.
These annotations are enclosed in double square brackets and prefixed with \`rc::\`.

Main annotation types:
- \`[[rc::args(...)]]\` - Function argument types
- \`[[rc::returns(...)]]\` - Function return type
- \`[[rc::parameters(...)]]\` - Type parameters used in refinement
- \`[[rc::requires(...)]]\` - Function preconditions
- \`[[rc::ensures(...)]]\` - Function postconditions

See specific annotation documentation for details.
`;

      // Return either specific documentation or general overview
      return {
        contents: [{
          uri: uri.href,
          text: annotationType ? docs[annotationType as string] || generalDocs : generalDocs
        }]
      };
    }
  );

  // Tool: Smart annotation generator with documentation context
  server.tool(
    'smart-annotate',
    SmartAnnotateSchema.shape,
    async ({ sourceCode, functionName, options = {} }) => {
      try {
        if (!llmService.isInitialized()) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: false,
                message: 'LLM service not initialized. Check ANTHROPIC_API_KEY in .env file.'
              })
            }],
            isError: true
          };
        }

        // Extract function signature and body for better context
        const functionSignatureRegex = new RegExp(`[\\s\\n]+(\\w+\\s+${functionName}\\s*\\(([^)]*)\\))\\s*\\{`, 'g');
        const signatureMatch = functionSignatureRegex.exec(sourceCode);
        const functionSignature = signatureMatch ? signatureMatch[1] : undefined;

        // Extract function body for more accurate analysis
        const functionBodyRegex = new RegExp(`[\\s\\n]+\\w+\\s+${functionName}\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\}`, 'g');
        const bodyMatch = functionBodyRegex.exec(sourceCode);
        const functionBody = bodyMatch ? bodyMatch[1] : undefined;

        // Use the documentation that was already defined for RefinedC annotations
        const generalDocs = `
# RefinedC Annotations
RefinedC uses C2X annotations to specify formal properties of C code.
These annotations are enclosed in double square brackets and prefixed with \`rc::\`.

Main annotation types:
- \`[[rc::args(...)]]\` - Function argument types
- \`[[rc::returns(...)]]\` - Function return type
- \`[[rc::parameters(...)]]\` - Type parameters used in refinement
- \`[[rc::requires(...)]]\` - Function preconditions
- \`[[rc::ensures(...)]]\` - Function postconditions
`;

        // Use LLM service to generate annotations with enhanced system prompt
        const result = await llmService.generateAnnotations(
          sourceCode,
          functionName,
          {
            considerOverflow: options.considerOverflow,
            generatePostconditions: options.generatePostconditions,
            functionSignature,
            functionBody
          }
        );

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              annotations: result.annotations,
              explanation: result.explanation
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
              message: `Failed to generate annotations: ${err.message}`
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

  console.log('RefinedC Copilot MCP Server started');
}

// Start the server if this module is run directly
if (require.main === module) {
  runServer().catch(error => {
    console.error('Error starting server:', error);
    process.exit(1);
  });
}
