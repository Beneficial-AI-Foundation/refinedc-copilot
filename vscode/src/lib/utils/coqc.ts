/**
 * Utilities for working with Coq and helper lemmas
 */

import * as path from 'path';
import * as fs from 'fs';
import * as childProcess from 'child_process';
import { promisify } from 'util';
import { RefinedCResult } from '../types';

const exec = promisify(childProcess.exec);
const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);
const mkdir = promisify(fs.mkdir);

/**
 * Execute a coqc command and return the result
 */
export async function executeCoqc(
  command: string,
  cwd?: string
): Promise<RefinedCResult> {
  try {
    const { stdout, stderr } = await exec(command, { cwd });
    return {
      success: true,
      message: 'Coq command executed successfully',
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
 * Generate helper lemma file content based on RefinedC error message
 */
export function generateHelperLemma(errorMessage: string): string {
  // Extract the lemma name and type from the error message
  // This is a simplified implementation - in a real scenario this would be more sophisticated
  const lemmaNameMatch = errorMessage.match(/need a helper lemma for: ([a-zA-Z_][a-zA-Z0-9_]*)/);
  const lemmaName = lemmaNameMatch ? lemmaNameMatch[1] : 'helper_lemma';

  // Parse the required lemma type from error message
  // In a real implementation, this would have more sophisticated parsing
  const isArithmeticMatch = errorMessage.includes('arithmetic') ||
                           errorMessage.includes('inequality') ||
                           errorMessage.includes('comparison');

  // Generate a basic lemma template based on the error context
  if (isArithmeticMatch) {
    return `Lemma ${lemmaName} : forall (x y z : Z),
  x + y <= z -> y + x <= z.
Proof.
  intros. lia.
Qed.`;
  } else {
    // Default general purpose lemma
    return `Lemma ${lemmaName} : forall (x y : Z), x + y = y + x.
Proof.
  intros. lia.
Qed.`;
  }
}

/**
 * Save helper lemma to the appropriate location
 */
export async function saveHelperLemma(
  sourcePath: string,
  lemmaContent: string
): Promise<RefinedCResult> {
  try {
    // Get directory containing the file
    const dir = path.dirname(sourcePath);

    // Extract project root (should be parent of src if in artifacts)
    const projectDir = path.dirname(dir);

    // Get base name of source file without extension
    const baseName = path.basename(sourcePath, '.c');

    // Create lemma directory in project root
    const lemmaDir = path.join(projectDir, 'proofs', baseName);
    const lemmaPath = path.join(lemmaDir, 'lemmas.v');

    // Create directory if it doesn't exist
    await mkdir(lemmaDir, { recursive: true });

    // Append to existing file or create new one
    let existingContent = '';
    try {
      existingContent = await readFile(lemmaPath, 'utf8');
      // Add a newline if the file doesn't end with one
      if (existingContent && !existingContent.endsWith('\n')) {
        existingContent += '\n\n';
      }
    } catch (error) {
      // File doesn't exist yet, that's fine
    }

    // Write lemma to file
    await writeFile(lemmaPath, existingContent + lemmaContent, 'utf8');

    return {
      success: true,
      message: `Helper lemma saved to ${lemmaPath}`,
    };
  } catch (error) {
    const err = error as Error;
    return {
      success: false,
      message: `Failed to save helper lemma: ${err.message}`,
      errors: [err.message],
    };
  }
}

/**
 * Verify that a helper lemma compiles correctly with coqc
 */
export async function verifyHelperLemma(
  sourcePath: string
): Promise<RefinedCResult> {
  try {
    // Get directory containing the file
    const dir = path.dirname(sourcePath);

    // Extract project root (should be parent of src if in artifacts)
    const projectDir = path.dirname(dir);

    // Get base name of source file without extension
    const baseName = path.basename(sourcePath, '.c');

    // Create lemma directory in project root
    const lemmaDir = path.join(projectDir, 'proofs', baseName);
    const lemmaPath = path.join(lemmaDir, 'lemmas.v');

    // Run coqc to verify the lemma
    return executeCoqc(`coqc ${lemmaPath}`, lemmaDir);
  } catch (error) {
    const err = error as Error;
    return {
      success: false,
      message: `Failed to verify helper lemma: ${err.message}`,
      errors: [err.message],
    };
  }
}

/**
 * Extract proof obligations from RefinedC error output
 */
export function extractProofObligations(errorOutput: string): string[] {
  // This is a simplified implementation
  // In a real scenario, this would have more sophisticated parsing
  const obligations: string[] = [];
  const obligationRegex = /Goal:([^=]+)(?:===|$)/g;

  let match;
  while ((match = obligationRegex.exec(errorOutput)) !== null) {
    const obligation = match[1].trim();
    if (obligation) {
      obligations.push(obligation);
    }
  }

  return obligations;
}

/**
 * Generate a complete helper lemma file with imports
 */
export function generateCompleteHelperFile(
  lemmas: string[],
  sourcePath: string
): string {
  const baseName = path.basename(sourcePath, '.c');

  return `(** Helper lemmas for ${baseName} **)
From caesium Require Import base notation tactics.
From refinedc.typing Require Import naive_simpl typing type_options.
From lithium Require Import hooks.

${lemmas.join('\n\n')}
`;
}
