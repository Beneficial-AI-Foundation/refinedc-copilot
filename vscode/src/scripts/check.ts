import { Command } from "commander";
import { pipe } from "fp-ts/function";
import * as TE from "fp-ts/TaskEither";
import { VerificationPlan, VerificationPlanType } from "./../lib/types";
import { runRefinedCCheck, processRefinedCOutput } from "./../lib/refinedc";

async function runCheck(filename: string) {
    console.log(`Checking ${filename} with RefinedC...`);

    return pipe(
        runRefinedCCheck(filename),
        TE.mapLeft(processRefinedCOutput),
        TE.match(
            (plan: VerificationPlan) => {
                console.log(
                    `Verification plan type: ${VerificationPlanType[plan.type]}!`,
                );
                return false;
            },
            () => {
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
            const result = await runCheck(filename);
            process.exit(result ? 0 : 1);
        } catch (err) {
            console.error("Unexpected error:", err);
            process.exit(1);
        }
    });

program.parse();
