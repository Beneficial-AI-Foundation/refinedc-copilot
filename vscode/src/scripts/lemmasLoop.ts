import { Command } from "commander";
import { pipe } from "fp-ts/function";
import * as T from "fp-ts/Task";
import * as TO from "fp-ts/TaskOption";
import * as TE from "fp-ts/TaskEither";
import * as E from "fp-ts/Either";
import * as O from "fp-ts/Option";
import {
    VerificationPlan,
    VerificationPlanType,
    CoqError,
    CoqErrorType,
    CoqOutcome,
} from "./../lib/types";
import { runRefinedCCheck, processRefinedCError, processRefinedCOutcome } from "./../lib/refinedc";
import { generateLemmas, extractAndRunLemmas } from "./../lib/lemmas";

function planToLemmaCompletions(
    plan: VerificationPlan,
): TO.TaskOption<string[]> {
    return pipe(
        TO.some(plan),
        TO.chain((pln) => async () => {
            switch (pln.type) {
                case VerificationPlanType.StateLemmas:
                    const lemmaStatements = await generateLemmas(pln.goals);
                    console.log("Lemma statements:", lemmaStatements);
                    return O.some(await Promise.all(lemmaStatements));
                default:
                    console.log(
                        "Not covering this VerificationPlanType in this script:",
                        VerificationPlanType[pln.type],
                    );
                    return O.none;
            }
        })
    );
}

function generatePlan(filename: string): TO.TaskOption<VerificationPlan> {
    const task = pipe(
        filename,
        runRefinedCCheck,
        (outcome) => pipe(outcome, TE.fold(
            (error) => TO.some(processRefinedCError(error)),
            () => TO.none
        )),
    );
    return () => task();
}

function coqOutcomes(plan: VerificationPlan): T.Task<CoqOutcome[]> {
    return pipe(
        planToLemmaCompletions(plan),
        TO.chain((lemmas) => TO.tryCatch(() => extractAndRunLemmas(lemmas))),
        TO.getOrElse(() => T.of([] as CoqOutcome[]))
    );
}

async function run(filename: string): Promise<CoqOutcome[]> {
    console.log(`Checking ${filename} with RefinedC and generating lemmas if needed...`);
    const task = pipe(
        generatePlan(filename),
        TO.getOrElse(() => T.of({} as VerificationPlan)),
        T.chain((plan) => plan.type ? coqOutcomes(plan) : T.of([] as CoqOutcome[])),
    );
    return await task();
}

async function loop(plan: VerificationPlan, fuel: number): Promise<CoqOutcome[]> {
    const result = await coqOutcomes(plan);
    const successes = [];
    for (const outcome of result) {
        if (outcome.exitcode === 0) {
            successes.push(outcome);
        }
    }
    if (fuel > 0) {
        return loop(plan, fuel - 1);
    }
    return ;
}
async function main(filename: string): Promise<boolean> {
    const result = await run(filename);
    console.log(result.map(async (f) => await f()));
    if (result.length > 0) {
        return true;
    }
    return false;
}

const program = new Command();

program
    .name("refinedC-checker")
    .description("Check files with RefinedC")
    .argument("<filename>", "File to check")
    .action(async (filename) => {
        try {
            const result = await main(filename);
            process.exit(result ? 0 : 1);
        } catch (err) {
            console.error("Unexpected error:", err);
            process.exit(1);
        }
    });

program.parse();
