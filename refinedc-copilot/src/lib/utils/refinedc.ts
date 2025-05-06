/**
 * Utilities for working with the RefinedC CLI
 */

import * as path from 'path';
import { exec, writeFile, readFile, mkdir } from './promises';
import { RefinedCResult, FunctionSpec, Annotation } from '../types';
import * as fs from 'fs';
import { promisify } from 'util';

const copyFile = promisify(fs.copyFile);
const exists = promisify(fs.exists);

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
export async function initProject(sourcePath: string): Promise<RefinedCResult> {
  // Check if the path is a file path or a directory path
  const stats = await import('fs').then(fs => fs.promises.stat(sourcePath).catch(() => null));

  // Determine the source directory
  let sourceDir: string;
  if (stats && stats.isFile()) {
    // If it's a file, get the directory
    sourceDir = path.dirname(sourcePath);
  } else {
    // Otherwise assume it's a directory
    sourceDir = sourcePath;
  }

  // Create artifacts directory path based on source path
  // First, get the absolute path to the sources dir
  const sourcesBaseDir = path.resolve(path.join('..', 'sources'));

  // Calculate the relative path from sources to the current directory
  // We need to extract the project name, not preserve the full path
  let projectName = '';
  try {
    // Get the relative path from sourcesBaseDir to sourceDir
    const relativePath = path.relative(sourcesBaseDir, sourceDir);

    // Extract the project name (first component of the path)
    const pathComponents = relativePath.split(path.sep);
    projectName = pathComponents[0]; // First directory is the project name

    // If we couldn't get a project name, use the directory name
    if (!projectName) {
      projectName = path.basename(sourceDir);
    }
  } catch (error) {
    console.warn(`Warning: Could not determine project name from ${sourcesBaseDir} to ${sourceDir}`);
    // Use a fallback approach - just use the last part of the path
    projectName = path.basename(sourceDir);
  }

  // Create project directory in artifacts
  const artifactsBaseDir = path.resolve(path.join('..', 'artifacts'));
  const artifactDir = path.join(artifactsBaseDir, projectName);

  // Create the directory if it doesn't exist
  try {
    await import('fs').then(fs => fs.promises.mkdir(artifactDir, { recursive: true }));
    console.log(`Created artifacts directory: ${artifactDir}`);

    // Also create the src subdirectory for the C files
    const srcDir = path.join(artifactDir, 'src');
    await import('fs').then(fs => fs.promises.mkdir(srcDir, { recursive: true }));
    console.log(`Created src directory: ${srcDir}`);

    // If sourcePath is a file, copy it to the artifacts/project/src directory
    if (stats && stats.isFile()) {
      const sourceFileName = path.basename(sourcePath);
      const destPath = path.join(srcDir, sourceFileName);

      try {
        await import('fs').then(fs =>
          fs.promises.copyFile(sourcePath, destPath)
            .then(() => console.log(`Copied ${sourcePath} to ${destPath}`))
        );
      } catch (copyError) {
        console.warn(`Warning: Could not copy file ${sourcePath} to ${destPath}: ${copyError}`);
      }
    }
  } catch (error) {
    console.warn(`Warning: Could not create directory ${artifactDir}: ${error}`);
  }

  // Run refinedc init in the artifacts directory
  return executeCommand(`refinedc init`, artifactDir);
}

/**
 * Check a C file with RefinedC
 */
export async function checkFile(filePath: string): Promise<RefinedCResult> {
  // Get the directory containing the file
  const dir = path.dirname(filePath);

  // Get the project root directory (parent of src)
  const projectDir = path.resolve(dir, '..');

  // Check if this is already in the artifacts directory
  const isInArtifacts = projectDir.includes('artifacts');

  // Use the project directory for RefinedC commands if in artifacts
  const workingDir = isInArtifacts ? projectDir : dir;

  // Get just the filename for the check command
  const relativeFilePath = isInArtifacts ? path.relative(projectDir, filePath) : path.basename(filePath);

  return executeCommand(`refinedc check ${relativeFilePath}`, workingDir);
}

/**
 * Extract function specifications from C code
 */
export function extractFunctions(source: string): FunctionSpec[] {
  // This regex matches basic C function definitions with or without annotations
  const functionRegex = /(?:\s*((?:\[\[rc::.*?\]\]\s*)+))?([a-zA-Z_][a-zA-Z0-9_]*\s+[a-zA-Z_][a-zA-Z0-9_]*\s*\([^)]*\))\s*\{/g;
  const annotationRegex = /\[\[rc::([a-zA-Z_]+)\("([^"]*)"\)\]\]/g;

  const functions: FunctionSpec[] = [];
  let match;

  while ((match = functionRegex.exec(source)) !== null) {
    const [, annotationsBlock, funcSignature] = match;
    const funcNameMatch = funcSignature.match(/\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/);

    if (funcNameMatch) {
      const funcName = funcNameMatch[1];
      const annotations: Annotation[] = [];

      // Only process annotations if the block exists
      if (annotationsBlock) {
        let annotationMatch;
        while ((annotationMatch = annotationRegex.exec(annotationsBlock)) !== null) {
          const [, type, content] = annotationMatch;
          annotations.push({
            type: type as Annotation['type'],
            content
          });
        }
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

/**
 * Create artifacts directory and copy source file if needed
 */
export async function prepareArtifactFile(sourcePath: string): Promise<string> {
  // Create artifacts directory structure in the monorepo root (./..)
  const artifactsBaseDir = path.resolve(path.join('..', 'artifacts'));

  // Extract project name and file structure
  const sourcesBaseDir = path.resolve(path.join('..', 'sources'));
  const relativePath = path.relative(sourcesBaseDir, sourcePath);

  // Extract the project name and the file path within the project
  const pathComponents = relativePath.split(path.sep);

  // First component should be the project name
  const projectName = pathComponents[0];

  // The filename is the last component
  const fileName = path.basename(sourcePath);

  // Create the target path in the artifacts directory
  // Structure: artifacts/<project>/src/<filename>
  const targetDir = path.join(artifactsBaseDir, projectName, 'src');
  const targetPath = path.join(targetDir, fileName);

  // Create directories if they don't exist
  await mkdir(targetDir, { recursive: true });

  // Check if the file already exists in artifacts
  const fileExists = await exists(targetPath);
  if (!fileExists) {
    // Copy source file to artifacts
    await copyFile(sourcePath, targetPath);
    console.log(`Copied source file to ${targetPath}`);
  }

  return targetPath;
}
