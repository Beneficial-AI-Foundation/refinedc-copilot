import { SpawnOptions } from 'child_process';

/**
 * Result of executing an external tool command
 */
export interface ToolResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  success: boolean;
}

/**
 * Result of running the RefinedC checker
 */
export interface RefinedCResult {
  success: boolean;
  output: string;
  errorMessage?: string;
}

/**
 * Converts a ToolResult to a RefinedCResult
 * @param result The ToolResult to convert
 * @returns The converted RefinedCResult
 */
export function toolResultToRefinedCResult(result: ToolResult): RefinedCResult {
  return {
    success: result.success,
    output: result.stdout,
    errorMessage: result.success ? undefined : result.stderr || 'RefinedC check failed'
  };
}
