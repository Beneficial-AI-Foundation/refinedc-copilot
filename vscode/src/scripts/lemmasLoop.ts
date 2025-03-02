import { Command } from "commander";
import { pipe } from "fp-ts/function";
import * as TE from "fp-ts/TaskEither";
import { VerificationPlan, VerificationPlanType } from "./../lib/types";
import { runRefinedCCheck, processRefinedCOutput } from "./../lib/refinedc";
import { generateLemmas, extractAndRunLemmas } from "./../lib/lemmas";

async function planToLemmaCompletions(
    plan: VerificationPlan,
): Promise<string[]> {
    switch (plan.type) {
        case VerificationPlanType.StateLemmas:
            const lemmaStatements = await generateLemmas(plan.goals);
            return Promise.all(lemmaStatements);
        default:
            console.log(
                "Not covering this VerificationPlanType in this script:",
                VerificationPlanType[plan.type],
            );
            return Promise.reject([]);
    }
}

async function main(filename: string): Promise<boolean> {
    console.log(`Checking ${filename} with RefinedC...`);
    const task = pipe(
        runRefinedCCheck(filename),
        TE.mapLeft(processRefinedCOutput),
        TE.mapLeft(planToLemmaCompletions),
        TE.mapLeft(extractAndRunLemmas),
    );
    return task();
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
