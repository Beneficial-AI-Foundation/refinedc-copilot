import { exec } from "child_process";
import { pipe } from "fp-ts/function";
import * as TE from "fp-ts/TaskEither";
import * as O from "fp-ts/Option";
import * as TO from "fp-ts/TaskOption";
import {
    RefinedCErrorType,
    RefinedCError,
    RefinedCOutcome,
    VerificationPlan,
    VerificationPlanType,
} from "./../lib/types";

function classifyRefinedCError(error: {
    stderr: string;
    exitcode: number | null | undefined;
}): RefinedCErrorType {
    if (error.stderr.includes("Cannot solve side condition")) {
        return RefinedCErrorType.NeedsLemmasOrIncorrectImplementation;
    }
    return RefinedCErrorType.MalformedSpec;
}

const extractGoals = (stderr: string): string[] => {
    const goalMatches = stderr.matchAll(/Goal:\n([\s\S]*?)\n\n/g);
    const allGoalLines: string[] = [];

    for (const match of goalMatches) {
        if (match[1]) {
            const goalText = match[1].trim();
            allGoalLines.push(goalText);
        }
    }

    return allGoalLines;
};

function runRefinedCCheck(filename: string): RefinedCOutcome {
    return TE.tryCatch(
        () =>
            new Promise<void>((resolve, reject) => {
                exec(`refinedc check ${filename}`, (exit, stdout, stderr) => {
                    if (exit) {
                        reject({
                            type: classifyRefinedCError({
                                stderr,
                                exitcode: exit.code,
                            }),
                            stdout,
                            stderr,
                            exitcode: exit.code ?? -1,
                        });
                    } else {
                        resolve();
                    }
                });
            }),
        (rcError): RefinedCError => ({
            ...(rcError as RefinedCError),
            exitcode: (rcError as RefinedCError).exitcode ?? -1,
        }),
    );
}

const processRefinedCError = (rcError: RefinedCError): VerificationPlan => {
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
};

/*
    This function takes a RefinedCOutcome and returns a TaskOption<VerificationPlan>.
    If RefinedCOutcome is a right void, then it returns TO.none.
    If RefinedCOutcome is a left RefinedCError, then it processes the error and returns a TaskOption with the VerificationPlan.
*/
function processRefinedCOutcome(outcome: RefinedCOutcome): TO.TaskOption<VerificationPlan> {
    return pipe(
        outcome,
        TE.fold(
            (error) => TO.some(processRefinedCError(error)),
            () => TO.none
        )
    );
}

export { runRefinedCCheck, processRefinedCError, processRefinedCOutcome };
