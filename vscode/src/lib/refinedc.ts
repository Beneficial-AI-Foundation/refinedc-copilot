import { exec } from "child_process";
import * as TE from "fp-ts/TaskEither";
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

const processRefinedCOutput = (rcError: RefinedCError): VerificationPlan => {
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

export { runRefinedCCheck, processRefinedCOutput };
