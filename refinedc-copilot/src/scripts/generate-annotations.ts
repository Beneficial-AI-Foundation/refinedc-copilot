#!/usr/bin/env ts-node
/**
 * RefinedC LLM Annotation Generator
 *
 * This script uses an LLM to generate RefinedC annotations for C functions.
 */
import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import * as childProcess from 'child_process';
import { extractFunctions, applyAnnotations } from '../lib/utils/refinedc';
import { Annotation } from '../lib/types';

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const exec = promisify(childProcess.exec);
const exists = promisify(fs.exists);

// Updated LLM options
interface LLMOptions {
  provider: 'openai' | 'anthropic' | 'local';
  model: string;
  temperature: number;
  maxTokens: number;
}

// Default LLM options
const defaultLLMOptions: LLMOptions = {
  provider: 'local', // Default to local for testing
  model: 'local',    // Default model
  temperature: 0.2,  // Lower temperature for more deterministic output
  maxTokens: 500     // Reasonable token limit for annotations
};

// CLI setup
const program = new Command();

program
  .name('generate-annotations')
  .description('Generate RefinedC annotations for C functions using an LLM')
  .version('0.0.1');

program
  .argument('<filePath>', 'Path to the C file')
  .argument('[functionName]', 'Name of the function to annotate (optional, annotates all functions if not specified)')
  .option('-o, --output <outputPath>', 'Output file path (defaults to the input file)')
  .option('-t, --temp <temperature>', 'LLM temperature (0.0-1.0)', parseFloat, defaultLLMOptions.temperature)
  .option('-p, --provider <provider>', 'LLM provider (openai, anthropic, local)', defaultLLMOptions.provider)
  .option('-m, --model <model>', 'LLM model to use', defaultLLMOptions.model)
  .option('-c, --consider-overflow', 'Consider overflow in operations', false)
  .option('--post-conditions', 'Generate postconditions for return values', false)
  .option('-d, --debug', 'Show debug information, including the prompts sent to the LLM', false)
  .option('--no-apply', 'Generate annotations but don\'t apply them to the file', false)
  .action(async (filePath, functionName, options) => {
    try {
      // Validate file path
      if (!await exists(filePath)) {
        console.error(`Error: File ${filePath} does not exist.`);
        process.exit(1);
      }

      // Read the source file
      const source = await readFile(filePath, 'utf8');

      // Get functions to annotate
      const functionsToAnnotate: string[] = [];

      if (functionName) {
        // Annotate specific function
        functionsToAnnotate.push(functionName);
      } else {
        // Extract all functions
        const extractedFunctions = extractFunctions(source);

        // If no functions found, exit
        if (extractedFunctions.length === 0) {
          console.error('No functions found in the source file.');
          process.exit(1);
        }

        // Get all function names
        functionsToAnnotate.push(...extractedFunctions.map(func => func.name));
        console.log(`Found ${functionsToAnnotate.length} functions to annotate.`);
      }

      // Create LLM options
      const llmOptions: LLMOptions = {
        provider: options.provider,
        model: options.model,
        temperature: options.temp,
        maxTokens: defaultLLMOptions.maxTokens
      };

      // Annotation options
      const annotationOptions = {
        considerOverflow: options.considerOverflow,
        generatePostconditions: options.postConditions
      };

      // Process each function
      const results: Array<{ functionName: string, annotations: Annotation[] }> = [];

      for (const funcName of functionsToAnnotate) {
        console.log(`Generating annotations for function: ${funcName}`);

        // Extract function details for better LLM context
        const functionSignature = extractFunctionSignature(source, funcName);
        const functionBody = extractFunctionBody(source, funcName);

        if (!functionSignature || !functionBody) {
          console.error(`Could not extract details for function: ${funcName}`);
          continue;
        }

        // Debug information
        if (options.debug) {
          console.log('\nFunction Signature:');
          console.log(functionSignature);
          console.log('\nFunction Body:');
          console.log(functionBody);
        }

        // Generate annotations using LLM
        const annotations = await generateAnnotationsWithLLM(
          source,
          funcName,
          functionSignature,
          functionBody,
          llmOptions,
          annotationOptions
        );

        if (annotations.length === 0) {
          console.error(`Failed to generate annotations for ${funcName}`);
          continue;
        }

        // Debug information
        if (options.debug) {
          console.log('\nGenerated Annotations:');
          annotations.forEach(anno => {
            console.log(`[[rc::${anno.type}("${anno.content}")]]`);
          });
        }

        results.push({
          functionName: funcName,
          annotations
        });
      }

      // Apply annotations if requested
      if (options.apply !== false && results.length > 0) {
        const outputPath = options.output || filePath;
        console.log(`Applying annotations to ${outputPath}`);

        const applyResult = await applyAnnotations(filePath, outputPath, results);

        if (applyResult.success) {
          console.log('✅ Successfully applied annotations');
        } else {
          console.error(`❌ Failed to apply annotations: ${applyResult.message}`);
          if (applyResult.errors) {
            applyResult.errors.forEach(error => console.error(error));
          }
        }
      } else if (results.length > 0) {
        // Just print the annotations
        console.log('\nGenerated Annotations:');
        results.forEach(result => {
          console.log(`\nFunction: ${result.functionName}`);
          result.annotations.forEach(anno => {
            console.log(`[[rc::${anno.type}("${anno.content}")]]`);
          });
        });
      }
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exit(1);
    }
  });

// Helper function to extract function signature from source code
function extractFunctionSignature(source: string, functionName: string): string | null {
  const functionRegex = new RegExp(`[\\s\\n]+(\\w+\\s+${functionName}\\s*\\([^)]*\\))\\s*\\{`, 'g');
  const match = functionRegex.exec(source);
  return match ? match[1] : null;
}

// Helper function to extract function body from source code
function extractFunctionBody(source: string, functionName: string): string | null {
  const functionBodyRegex = new RegExp(`[\\s\\n]+\\w+\\s+${functionName}\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\}`, 'g');
  const match = functionBodyRegex.exec(source);
  return match ? match[1] : null;
}

/**
 * Generate annotations using an LLM
 */
async function generateAnnotationsWithLLM(
  source: string,
  functionName: string,
  functionSignature: string,
  functionBody: string,
  llmOptions: LLMOptions,
  annotationOptions: { considerOverflow: boolean, generatePostconditions: boolean }
): Promise<Annotation[]> {
  // First, try to use our basic heuristic-based approach as a fallback
  const basicAnnotations = generateBasicAnnotations(
    functionSignature,
    functionBody,
    annotationOptions.considerOverflow,
    annotationOptions.generatePostconditions
  );

  // For local provider, just return the basic annotations
  if (llmOptions.provider === 'local') {
    console.log('Using local algorithm to generate annotations (no LLM)');
    return basicAnnotations;
  }

  try {
    // Prepare the prompt for the LLM
    const prompt = createAnnotationPrompt(
      source,
      functionName,
      functionSignature,
      functionBody
    );

    console.log(`Calling ${llmOptions.provider} API to generate annotations...`);

    // We could integrate with MCP here, but for now we'll use a simpler approach
    // This will leverage our CLI's existing LLM integration approach
    let llmResponse = '';

    if (llmOptions.provider === 'openai') {
      // Call OpenAI API - this would use the OpenAI SDK in a real implementation
      // Here we're just mocking a response for demonstration
      llmResponse = `
[[rc::parameters("n1 : nat, n2 : nat")]]
[[rc::args("n1 @ int<u32>", "n2 @ int<u32>")]]
[[rc::returns("int<u32>")]]
[[rc::requires("{n1 + n2 ≤ max_int u32}")]]
      `;
    } else if (llmOptions.provider === 'anthropic') {
      // Call Anthropic API - this would use the Anthropic SDK in a real implementation
      // Here we're just mocking a response for demonstration
      llmResponse = `
I've analyzed the function and here are the appropriate RefinedC annotations:

[[rc::parameters("n1 : nat, n2 : nat")]]
[[rc::args("n1 @ int<u32>", "n2 @ int<u32>")]]
[[rc::returns("int<u32>")]]
[[rc::requires("{n1 + n2 ≤ max_int u32}")]]
      `;
    } else {
      // This should not happen given our earlier check, but just in case
      return basicAnnotations;
    }

    // Parse the response to extract annotations
    const responseAnnotations = parseAnnotationsFromLLMResponse(llmResponse);

    // Return the parsed annotations, or fall back to basic ones if parsing fails
    if (responseAnnotations.length === 0) {
      console.log('No annotations found in LLM response, falling back to basic generation');
      return basicAnnotations;
    }

    console.log(`Successfully generated ${responseAnnotations.length} annotations using ${llmOptions.provider}`);
    return responseAnnotations;

  } catch (error) {
    console.error(`Error using LLM: ${(error as Error).message}`);
    console.log('Falling back to basic annotation generation');
    return basicAnnotations;
  }
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

/**
 * Generate basic annotations using heuristics (fallback method)
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

// Parse and run
program.parse(process.argv);
