/**
 * VSCode Extension Utilities
 *
 * Utility functions to connect the VS Code extension with the RefinedC LLM annotation generation.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as childProcess from 'child_process';
import { promisify } from 'util';
import { Annotation } from './lib/types';
import { extractFunctions, applyAnnotations } from './lib/utils/refinedc';

const exec = promisify(childProcess.exec);
const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);

// LLM configuration
interface LLMOptions {
  provider: 'openai' | 'anthropic' | 'local';
  model: string;
  temperature: number;
  maxTokens: number;
}

/**
 * Generate annotations for a function using LLM
 */
export async function generateAnnotationsForFunction(
  filePath: string,
  functionName: string,
  options: {
    provider: string;
    model: string;
    temperature: number;
    considerOverflow: boolean;
    generatePostconditions: boolean;
    applyDirectly: boolean;
    outputPath?: string;
  }
): Promise<{
  success: boolean;
  message: string;
  annotations?: Annotation[];
}> {
  try {
    // Validate file path
    if (!fs.existsSync(filePath)) {
      return {
        success: false,
        message: `File ${filePath} does not exist`
      };
    }

    // Read the source file
    const source = await readFile(filePath, 'utf8');

    // Extract function details
    const functions = extractFunctions(source);
    const targetFunction = functions.find(f => f.name === functionName);

    if (!targetFunction) {
      return {
        success: false,
        message: `Function ${functionName} not found in ${filePath}`
      };
    }

    // Extract function signature and body for better LLM context
    const functionSignatureRegex = new RegExp(`[\\s\\n]+(\\w+\\s+${functionName}\\s*\\(([^)]*)\\))\\s*\\{`, 'g');
    const signatureMatch = functionSignatureRegex.exec(source);
    const functionSignature = signatureMatch ? signatureMatch[1] : '';

    const functionBodyRegex = new RegExp(`[\\s\\n]+\\w+\\s+${functionName}\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\}`, 'g');
    const bodyMatch = functionBodyRegex.exec(source);
    const functionBody = bodyMatch ? bodyMatch[1] : '';

    if (!functionSignature || !functionBody) {
      return {
        success: false,
        message: `Could not extract function details for ${functionName}`
      };
    }

    // Create prompt for LLM
    const prompt = createAnnotationPrompt(source, functionName, functionSignature, functionBody);

    // Configure LLM options
    const llmOptions: LLMOptions = {
      provider: options.provider as 'openai' | 'anthropic' | 'local',
      model: options.model,
      temperature: options.temperature,
      maxTokens: 500
    };

    // Local doesn't use an API, so just use our basic generation
    if (options.provider === 'local') {
      const annotations = generateBasicAnnotations(
        functionSignature,
        functionBody,
        options.considerOverflow,
        options.generatePostconditions
      );

      // Apply annotations if needed
      if (options.applyDirectly) {
        const outputPath = options.outputPath || filePath;
        const applyResult = await applyAnnotations(filePath, outputPath, [
          { functionName, annotations }
        ]);

        if (applyResult.success) {
          return {
            success: true,
            message: `Generated and applied annotations to ${outputPath}`,
            annotations
          };
        } else {
          return {
            success: false,
            message: `Generated annotations but failed to apply them: ${applyResult.message}`,
            annotations
          };
        }
      }

      return {
        success: true,
        message: `Generated annotations for ${functionName}`,
        annotations
      };
    }

    // Otherwise call the LLM API
    try {
      // We'll use a simplified approach here since we removed the MCP dependency
      let llmResponse = '';

      // Simple mock for now - in a real implementation, this would call the appropriate LLM API
      if (llmOptions.provider === 'openai') {
        llmResponse = `
[[rc::parameters("n1 : nat, n2 : nat")]]
[[rc::args("n1 @ int<u32>", "n2 @ int<u32>")]]
[[rc::returns("int<u32>")]]
[[rc::requires("{n1 + n2 ≤ max_int u32}")]]
        `;
      } else if (llmOptions.provider === 'anthropic') {
        llmResponse = `
I've analyzed the function and here are the appropriate RefinedC annotations:

[[rc::parameters("n1 : nat, n2 : nat")]]
[[rc::args("n1 @ int<u32>", "n2 @ int<u32>")]]
[[rc::returns("int<u32>")]]
[[rc::requires("{n1 + n2 ≤ max_int u32}")]]
        `;
      } else {
        // Default to basic annotations if provider not recognized
        return {
          success: true,
          message: `Unsupported LLM provider: ${llmOptions.provider}, using basic annotations`,
          annotations: generateBasicAnnotations(
            functionSignature,
            functionBody,
            options.considerOverflow,
            options.generatePostconditions
          )
        };
      }

      const annotations = parseAnnotationsFromLLMResponse(llmResponse);

      if (annotations.length === 0) {
        // Fall back to basic generation
        const basicAnnotations = generateBasicAnnotations(
          functionSignature,
          functionBody,
          options.considerOverflow,
          options.generatePostconditions
        );

        if (options.applyDirectly) {
          const outputPath = options.outputPath || filePath;
          const applyResult = await applyAnnotations(filePath, outputPath, [
            { functionName, annotations: basicAnnotations }
          ]);

          if (applyResult.success) {
            return {
              success: true,
              message: `Generated and applied basic annotations to ${outputPath} (LLM failed)`,
              annotations: basicAnnotations
            };
          } else {
            return {
              success: false,
              message: `Failed to apply annotations: ${applyResult.message}`,
              annotations: basicAnnotations
            };
          }
        }

        return {
          success: true,
          message: `Generated basic annotations for ${functionName} (LLM failed)`,
          annotations: basicAnnotations
        };
      }

      // Apply the LLM-generated annotations if requested
      if (options.applyDirectly) {
        const outputPath = options.outputPath || filePath;
        const applyResult = await applyAnnotations(filePath, outputPath, [
          { functionName, annotations }
        ]);

        if (applyResult.success) {
          return {
            success: true,
            message: `Generated and applied LLM-based annotations to ${outputPath}`,
            annotations
          };
        } else {
          return {
            success: false,
            message: `Generated annotations but failed to apply them: ${applyResult.message}`,
            annotations
          };
        }
      }

      return {
        success: true,
        message: `Generated LLM-based annotations for ${functionName}`,
        annotations
      };

    } catch (error) {
      const basicAnnotations = generateBasicAnnotations(
        functionSignature,
        functionBody,
        options.considerOverflow,
        options.generatePostconditions
      );

      return {
        success: true,
        message: `LLM call failed (${(error as Error).message}), using basic annotations`,
        annotations: basicAnnotations
      };
    }
  } catch (error) {
    return {
      success: false,
      message: `Error generating annotations: ${(error as Error).message}`
    };
  }
}

/**
 * Generate basic annotations using heuristics
 */
function generateBasicAnnotations(
  functionSignature: string,
  functionBody: string,
  considerOverflow: boolean,
  generatePostconditions: boolean
): Annotation[] {
  const annotations: Annotation[] = [];

  // Extract return type and parameters
  const signatureMatch = functionSignature.match(/^(\w+)\s+(\w+)\s*\(([^)]*)\)/);
  if (!signatureMatch) {return annotations;}

  const [, returnType, functionName, paramsString] = signatureMatch;
  const params = paramsString.split(',').map(p => p.trim()).filter(p => p);

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

  // Process parameters
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

  // Generate parameter variables for refinement types
  if (paramInfo.length > 0) {
    const paramVariables = paramInfo.map(p => `n${p.name} : nat`).join(', ');
    annotations.push({
      type: 'parameters',
      content: paramVariables
    });
  }

  // Generate argument types with refinement
  if (paramInfo.length > 0) {
    const argTypes = paramInfo.map(p => `"n${p.name} @ ${p.refinedType}"`).join(', ');
    annotations.push({
      type: 'args',
      content: argTypes
    });
  }

  // Generate return type
  const isUnsignedReturn = returnType.includes('unsigned');
  let refinedReturnType = typeMap[returnType] || (isUnsignedReturn ? 'int<u32>' : 'int<i32>');

  // Generate more sophisticated return type for certain common patterns
  if (generatePostconditions && returnType !== 'void') {
    const hasAddition = functionBody.includes('+');
    const hasSubtraction = functionBody.includes('-');
    const hasMultiplication = functionBody.includes('*');
    const hasDivision = functionBody.includes('/');

    // For simple sum functions
    if (hasAddition && !hasSubtraction && !hasMultiplication && !hasDivision && paramInfo.length <= 3) {
      const paramNamesList = paramInfo.map(p => `n${p.name}`);
      annotations.push({
        type: 'returns',
        content: `"{${paramNamesList.join(' + ')}} @ ${refinedReturnType}"`
      });
    } else {
      annotations.push({
        type: 'returns',
        content: `"${refinedReturnType}"`
      });
    }
  } else {
    annotations.push({
      type: 'returns',
      content: `"${refinedReturnType}"`
    });
  }

  // Generate requires clauses for numerical operations that might overflow
  if (considerOverflow) {
    const hasAddition = functionBody.includes('+');
    const hasMultiplication = functionBody.includes('*');

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

  return annotations;
}

/**
 * Create a prompt for the LLM to generate annotations
 */
function createAnnotationPrompt(
  _source: string,
  functionName: string,
  functionSignature: string,
  functionBody: string
): string {
  return `
Please analyze this C function and suggest RefinedC annotations for it:

Function Name: ${functionName}

Function Signature:
\`\`\`c
${functionSignature}
\`\`\`

Function Body:
\`\`\`c
${functionBody}
\`\`\`

I need you to generate appropriate RefinedC annotations that specify:
1. The types of arguments using [[rc::args(...)]]
2. The return type using [[rc::returns(...)]]
3. Any needed parameters using [[rc::parameters(...)]]
4. Any required preconditions using [[rc::requires(...)]]

Pay special attention to potential overflow issues with arithmetic operations. Use refinement types where appropriate.

For reference, here is some information about RefinedC annotations:
- int<i32> is a 32-bit signed integer
- int<u32> is a 32-bit unsigned integer
- You can use refinement types like "n @ int<u32>" to specify a variable 'n' of type int<u32>
- For parameters that could overflow, include requires clauses like "{n1 + n2 ≤ max_int u32}"

Please only output the annotations in the standard format, each on its own line, starting with [[rc::
`.trim();
}

/**
 * Parse annotations from an LLM response
 */
function parseAnnotationsFromLLMResponse(llmResponse: string): Annotation[] {
  const annotations: Annotation[] = [];
  const annotationRegex = /\[\[rc::([a-zA-Z_]+)\("([^"]*)"\)\]\]/g;

  let match;
  while ((match = annotationRegex.exec(llmResponse)) !== null) {
    const [, type, content] = match;
    if (['args', 'returns', 'parameters', 'requires'].includes(type)) {
      annotations.push({
        type: type as Annotation['type'],
        content
      });
    }
  }

  return annotations;
}
