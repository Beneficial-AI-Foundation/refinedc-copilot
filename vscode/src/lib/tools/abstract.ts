import { spawn, SpawnOptions } from 'child_process';
import { ToolResult } from './types';

/**
 * Executes an external command and returns the result
 * @param command The command to execute
 * @param args Arguments to pass to the command
 * @param options Additional spawn options
 * @returns Promise resolving to the execution result
 */
async function runTool(
  command: string,
  args: string[] = [],
  options: SpawnOptions = {}
): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, {
      ...options,
      shell: true
    });

    let stdout = '';
    let stderr = '';

    process.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    process.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    process.on('error', (error) => {
      reject(error);
    });

    process.on('close', (exitCode) => {
      resolve({
        exitCode: exitCode ?? -1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        success: exitCode === 0
      });
    });
  });
}

export { runTool };
