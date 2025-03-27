import { Command } from "commander";
import * as E from "fp-ts/Either";
import logger from "./../lib/util/logger";
import { RefinedCError, RefinedCErrorType } from "./../lib/types";
import { copyToArtifacts } from "./../lib/spec/fsio";
import { specAgent } from "./../lib/spec/orchestration";

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
