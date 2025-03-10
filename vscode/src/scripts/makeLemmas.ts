import { Command } from "commander";
import { pipe } from "fp-ts/function";
import * as TE from "fp-ts/TaskEither";
import { VerificationPlan, VerificationPlanType } from "./../lib/types";
import { runRefinedCCheck, processRefinedCOutput } from "./../lib/refinedc";
import { generateLemmas } from "./../lib/lemmas";

// Assuming that the VerificationPlanType ends up being StateLemmas
async function main(filename: string): Promise<boolean> {
    console.log(`Checking ${filename} with RefinedC...`);

    return pipe(
        runRefinedCCheck(filename),
        TE.mapLeft(processRefinedCOutput),
        TE.match(
            async (plan: VerificationPlan) => {
                console.log(
                    `Verification plan type: ${VerificationPlanType[plan.type]}!`,
                );
                switch (plan.type) {
                    case VerificationPlanType.StateLemmas:
                        const lemmaStatements = await generateLemmas(
                            plan.goals,
                        );

                        lemmaStatements.map((lemmaStatement) => {
                            console.log("Generated lemma:");
                            console.log(lemmaStatement);
                            console.log("-----");
                        });
                    default:
                        console.log(
                            "Not covering this VerificationPlanType in this script",
                        );
                        return false;
                }
            },
            async () => {
                console.log("RefinedC check passed successfully!");
                return true;
            },
        ),
    )();
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
