/**
 * Types for the RefinedC copilot implementation
 */

import { z } from 'zod';

/**
 * Result of a RefinedC command execution
 */
export interface RefinedCResult {
  success: boolean;
  message: string;
  output?: string;
  errors?: string[];
}

/**
 * Source file with annotations
 */
export interface SourceFile {
  path: string;
  content: string;
}

/**
 * Helper lemma interface
 */
export interface HelperLemma {
  name: string;
  statement: string;
  proof: string;
}

/**
 * RefinedC annotation
 */
export interface Annotation {
  type: 'args' | 'returns' | 'parameters' | 'requires';
  content: string;
}

/**
 * Function specification
 */
export interface FunctionSpec {
  name: string;
  annotations: Annotation[];
}

/**
 * RefinedC project
 */
export interface RefinedCProject {
  sourceFiles: SourceFile[];
  helperLemmas: HelperLemma[];
}

/**
 * Zod schemas for tool parameters
 */
export const InitProjectSchema = z.object({
  projectPath: z.string(),
});

export const AnnotateFunctionSchema = z.object({
  source: z.string(),
  functionName: z.string(),
});

export const GenerateHelperLemmaSchema = z.object({
  errorMessage: z.string(),
  sourcePath: z.string(),
});

export const CheckFileSchema = z.object({
  filePath: z.string(),
});

export const ApplyAnnotationsSchema = z.object({
  sourcePath: z.string(),
  targetPath: z.string(),
  annotations: z.array(z.object({
    functionName: z.string(),
    annotations: z.array(z.object({
      type: z.enum(['args', 'returns', 'parameters', 'requires']),
      content: z.string(),
    })),
  })),
});
