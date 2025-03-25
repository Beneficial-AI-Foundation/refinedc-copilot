import * as fs from "fs";
import * as path from "path";
import { Command } from "commander";
import * as E from "fp-ts/Either";
import { RefinedCError, RefinedCErrorType } from "./../lib/types";
import { specAgent } from "./../lib/spec/orchestration";
import logger from "./../lib/util/logger";

/**
 * Runs the specification verification process for a file
 */
async function run(filename: string): Promise<E.Either<RefinedCError, void>> {
    logger.info("Starting specification verification run", { filename });

    // Run the spec agent and get the outcome and final state
    const [outcome, finalState] = await specAgent(filename);

    // Execute the task to get the actual result
    const result = await outcome();

    logger.info("Specification verification completed", {
        iterations: finalState.iterations,
        completed: finalState.completed,
    });

    return result;
}

/**
 * Copies a file from a source path to an artifacts path, maintaining the directory structure
 * @param filename The source filename that starts with 'source/'
 * @returns The new filename in the artifacts directory
 */
function copyToArtifacts(filename: string): string {
    // Validate that filename starts with 'source/'
    if (!filename.startsWith("sources/")) {
        throw new Error('Filename must start with "sources/"');
    }

    // Calculate the new path by replacing 'source/' with 'artifacts/'
    const artifactsFilename = filename.replace(/^sources\//, "artifacts/");

    // Ensure destination directory exists
    const destDir = path.dirname(artifactsFilename);
    fs.mkdirSync(destDir, { recursive: true });

    // Copy the file
    fs.copyFileSync(filename, artifactsFilename);

    logger.info(`Copied ${filename} to ${artifactsFilename}`);

    return artifactsFilename;
}

/**
 * Main function that runs the specification verification process
 */
async function main(filename: string): Promise<boolean> {
    const artifactsFilename = copyToArtifacts(filename);
    logger.info("Starting main specification process", { filename });
    const result = await run(artifactsFilename);

    if (E.isRight(result)) {
        logger.info("Verification succeeded on these specs");
        return true;
    } else {
        logger.info("Verification failed on these specs", {
            errorType: RefinedCErrorType[result.left.type],
            exitcode: result.left.exitcode,
        });
        return false;
    }
}

// Set up the command line interface
const program = new Command();

program
    .name("specs-loop")
    .description("Run the specification verification process")
    .argument("<filename>", "C file to verify")
    .action(async (filename) => {
        logger.info("Starting specs loop", { filename });
        const result = await main(filename);
        logger.info("Specs loop completed", { result });
        process.exit(result ? 0 : 1);
    });

program.parse();
