/**
 * Utilities for working with the RefinedC CLI
 */

import * as path from 'path';
import { exec, writeFile, readFile, mkdir } from './promises';
import { RefinedCResult, FunctionSpec, Annotation } from '../types';

/**
 * Execute a shell command and return the result
 */
export async function executeCommand(
  command: string,
  cwd?: string
): Promise<RefinedCResult> {
  try {
    const { stdout, stderr } = await exec(command, { cwd });
    return {
      success: true,
      message: 'Command executed successfully',
      output: stdout,
    };
  } catch (error) {
    const err = error as { stderr?: string; message: string };
    return {
      success: false,
      message: err.message,
      errors: err.stderr ? [err.stderr] : [err.message],
    };
  }
}

/**
 * Initialize a RefinedC project
 */
export async function initProject(projectPath: string): Promise<RefinedCResult> {
  return executeCommand(`refinedc init`, projectPath);
}

/**
 * Check a C file with RefinedC
 */
export async function checkFile(filePath: string): Promise<RefinedCResult> {
  const dir = path.dirname(filePath);
  return executeCommand(`refinedc check ${path.basename(filePath)}`, dir);
}

/**
 * Extract function specifications from C code
 */
export function extractFunctions(source: string): FunctionSpec[] {
  const functionRegex = /\s*((\[\[rc::.*?\]\]\s*)+)([a-zA-Z_][a-zA-Z0-9_]*\s+[a-zA-Z_][a-zA-Z0-9_]*\s*\([^)]*\))\s*\{/g;
  const annotationRegex = /\[\[rc::([a-zA-Z_]+)\("([^"]*)"\)\]\]/g;

  const functions: FunctionSpec[] = [];
  let match;

  while ((match = functionRegex.exec(source)) !== null) {
    const [, annotationsBlock, , funcSignature] = match;
    const funcNameMatch = funcSignature.match(/\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/);

    if (funcNameMatch) {
      const funcName = funcNameMatch[1];
      const annotations: Annotation[] = [];

      let annotationMatch;
      while ((annotationMatch = annotationRegex.exec(annotationsBlock)) !== null) {
        const [, type, content] = annotationMatch;
        annotations.push({
          type: type as Annotation['type'],
          content
        });
      }

      functions.push({
        name: funcName,
        annotations
      });
    }
  }

  return functions;
}

/**
 * Apply annotations to a C source file
 */
export async function applyAnnotations(
  sourcePath: string,
  targetPath: string,
  specs: { functionName: string; annotations: Annotation[] }[]
): Promise<RefinedCResult> {
  try {
    // Create target directory if it doesn't exist
    const targetDir = path.dirname(targetPath);
    await mkdir(targetDir, { recursive: true });

    // Read source file
    const sourceContent = await readFile(sourcePath, 'utf8');

    // Create a map of function names to annotations
    const funcAnnotations = new Map<string, Annotation[]>();
    specs.forEach(spec => {
      funcAnnotations.set(spec.functionName, spec.annotations);
    });

    // New approach: split the content and scan for function declarations
    const lines = sourceContent.split('\n');
    const result: string[] = [];

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      // Look for function declarations
      // This regex attempts to match a C function declaration by looking for:
      // - optional whitespace
      // - a type (with possible modifiers)
      // - a function name followed by opening parenthesis
      // - parameters
      // - closing parenthesis
      // - optional whitespace followed by opening brace
      const funcMatch = line.match(/^(\s*)((?:[a-zA-Z_][a-zA-Z0-9_<>]*\s+)+)([a-zA-Z_][a-zA-Z0-9_]*)(\s*\([^)]*\))(\s*\{.*)$/);

      if (funcMatch) {
        // We found a function declaration
        const [, leadingSpace, returnType, funcName, paramsWithParen, openBraceAndRest] = funcMatch;

        // Check if this function should be annotated
        const annotations = funcAnnotations.get(funcName);

        if (annotations && annotations.length > 0) {
          // Insert the annotations before the function
          for (const anno of annotations) {
            result.push(`${leadingSpace}[[rc::${anno.type}("${anno.content}")]]`);
          }
        }

        // Add original function line
        result.push(line);
      } else {
        // Not a function declaration, just add the line
        result.push(line);
      }

      i++;
    }

    // Write the modified content back to the file
    await writeFile(targetPath, result.join('\n'), 'utf8');

    return {
      success: true,
      message: `Annotations applied to ${targetPath}`,
    };
  } catch (error) {
    const err = error as Error;
    return {
      success: false,
      message: `Failed to apply annotations: ${err.message}`,
      errors: [err.message],
    };
  }
}
