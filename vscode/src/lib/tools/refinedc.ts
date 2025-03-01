import { runTool } from './abstract';
import { RefinedCResult, toolResultToRefinedCResult } from './types';
import * as fs from 'fs';

/**
 * Runs the RefinedC checker on a specified file
 * @param filePath Path to the file to check
 * @returns Promise resolving to the RefinedC check result
 */
export async function checkWithRefinedC(filePath: string): Promise<RefinedCResult> {
  try {
    // Ensure the file exists
    if (!fs.existsSync(filePath)) {
      return {
        success: false,
        output: '',
        errorMessage: `File not found: ${filePath}`
      };
    }

    // Run the refinedc check command
    const result = await runTool('refinedc', ['check', filePath]);

    // Convert the tool result to a RefinedC result
    return toolResultToRefinedCResult(result);
  } catch (error) {
    return {
      success: false,
      output: '',
      errorMessage: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}
