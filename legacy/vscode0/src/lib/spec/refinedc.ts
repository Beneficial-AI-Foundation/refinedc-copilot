import { exec } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { pipe } from "fp-ts/function";
import * as TE from "fp-ts/TaskEither";
import * as TO from "fp-ts/TaskOption";
import * as T from "fp-ts/lib/Task";
import {
    RefinedCErrorType,
    RefinedCError,
    RefinedCOutcome,
    VerificationPlan,
    VerificationPlanType,
} from "../types";
import logger from "../util/logger";

function classifyRefinedCError(error: {
    stderr: string;
    exitcode: number | null | undefined;
}): RefinedCErrorType {
    if (error.stderr.includes("Cannot solve side condition")) {
        return RefinedCErrorType.NeedsLemmasOrIncorrectImplementation;
    }
    return RefinedCErrorType.MalformedSpec;
}

function extractGoals(stderr: string): string[] {
    const goalMatches = stderr.matchAll(/Goal:\n([\s\S]*?)\n\n/g);
    const allGoalLines: string[] = [];

    for (const match of goalMatches) {
        if (match[1]) {
            const goalText = match[1].trim();
            allGoalLines.push(goalText);
        }
    }

    return allGoalLines;
}

function runRefinedCCheck(filename: string): RefinedCOutcome {
    return TE.tryCatch(
        () =>
            new Promise<void>((resolve, reject) => {
                exec(`refinedc check ${filename}`, (error, stdout, stderr) => {
                    if (error) {
                        reject({
                            type: classifyRefinedCError({
                                stderr,
                                exitcode: error.code,
                            }),
                            stdout,
                            stderr,
                            exitcode: error.code,
                        } as RefinedCError);
                    } else {
                        resolve();
                    }
                });
            }),
        (rcError) => rcError as RefinedCError,
    );
}

function runRefinedCInit(filename: string): TO.TaskOption<void> {
    const cwd = path.dirname(path.dirname(filename));
    const rcProjectPath = path.join(cwd, "rc-project.toml");

    return pipe(
        TE.tryCatch(
            () => fs.promises.access(rcProjectPath, fs.constants.F_OK),
            (err) => err as NodeJS.ErrnoException
        ),
        TE.fold(
            // File doesn't exist, run refinedc init
            () => TE.tryCatch(
                () => new Promise<void>((resolve, reject) => {
                    exec("refinedc init", { cwd }, (error, stdout, stderr) => {
                        if (error) {
                            reject({ stdout, stderr, exit: error });
                        } else {
                            resolve();
                        }
                    });
                }),
                (err) => err
            ),
            // File exists, no need to initialize
            () => TE.right(undefined)
        ),
        TE.fold(
            // Error occurred
            () => TO.none,
            // Success (either init ran or wasn't needed)
            () => TO.none
        )
    );
}

function processRefinedCError(rcError: RefinedCError): VerificationPlan {
    switch (rcError.type) {
        case RefinedCErrorType.MalformedSpec:
            return { type: VerificationPlanType.EditSpec };

        case RefinedCErrorType.NeedsLemmasOrIncorrectImplementation:
        case RefinedCErrorType.UnfinishedProof:
            return {
                type: VerificationPlanType.StateLemmas,
                goals: extractGoals(rcError.stderr),
            };

        default:
            // Default to EditSpec if we don't recognize the error type
            return { type: VerificationPlanType.EditSpec };
    }
}

/*
    This function takes a RefinedCOutcome and returns a TaskOption<VerificationPlan>.
    If RefinedCOutcome is a right void, then it returns TO.none.
    If RefinedCOutcome is a left RefinedCError, then it processes the error and returns a TaskOption with the VerificationPlan.
*/
function processRefinedCOutcome(
    outcome: RefinedCOutcome,
): TO.TaskOption<VerificationPlan> {
    return pipe(
        outcome,
        TE.fold(
            (error) => TO.some(processRefinedCError(error)),
            () => TO.none,
        ),
    );
}

export {
    runRefinedCCheck,
    runRefinedCInit,
    processRefinedCError,
    processRefinedCOutcome,
};
