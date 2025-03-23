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
import { runRefinedCCheck, processRefinedCError, processRefinedCOutcome } from "../lib/spec/refinedc";
import { generateLemmas, extractAndRunLemmas } from "./../lib/lemma";
import logger from '../lib/util/logger';

function planToLemmaCompletions(
    plan: VerificationPlan,
): TO.TaskOption<string[]> {
    logger.info('Starting lemma completion generation', { planType: plan.type });
    return pipe(
        TO.some(plan),
        TO.chain((pln) => async () => {
            switch (pln.type) {
                case VerificationPlanType.StateLemmas:
                    logger.info('Generating lemmas for state goals', { goalsCount: pln.goals.length });
                    const lemmaStatements = await generateLemmas(pln.goals);
                    logger.info('Generated lemma statements', { count: lemmaStatements.length });
                    return O.some(await Promise.all(lemmaStatements));
                default:
                    logger.warn('Unsupported verification plan type', { type: VerificationPlanType[pln.type] });
                    return O.none;
            }
        })
    );
}

function generatePlan(filename: string): TO.TaskOption<VerificationPlan> {
    logger.info('Generating verification plan', { filename });
    const task = pipe(
        filename,
        runRefinedCCheck,
        (outcome) => pipe(outcome, TE.fold(
            (error) => {
                logger.info('RefinedC check resulted in error, processing as plan', { error });
                return TO.some(processRefinedCError(error));
            },
            () => {
                logger.info('RefinedC check succeeded, no plan needed');
                return TO.none;
            }
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
    logger.info('Starting verification run', { filename });
    const task = pipe(
        generatePlan(filename),
        TO.getOrElse(() => {
            logger.info('No plan generated, returning empty verification plan');
            return T.of({} as VerificationPlan);
        }),
        T.chain((plan) => {
            if (plan.type) {
                logger.info('Processing plan', { planType: VerificationPlanType[plan.type] });
                return coqOutcomes(plan);
            }
            logger.info('No plan type, returning empty outcomes');
            return T.of([] as CoqOutcome[]);
        }),
    );
    return await task();
}

async function loop(plan: VerificationPlan, fuel: number, successes: CoqOutcome[] = []): Promise<CoqOutcome[]> {
    logger.info('Starting verification loop', { fuel, currentSuccesses: successes.length });
    const task = coqOutcomes(plan);
    const result = await task();
    logger.info('Got loop outcomes', { outcomeCount: result.length });

    for (const outcome of result) {
        await pipe(
            outcome,
            TE.fold(
                () => {
                    logger.debug('Outcome resulted in error');
                    return T.of(null);
                },
                () => {
                    logger.debug('Outcome succeeded, adding to successes');
                    successes.push(outcome);
                    return T.of(null);
                }
            )
        )();
    }

    if (fuel > 0) {
        logger.info('Continuing loop', { remainingFuel: fuel - 1 });
        return loop(plan, fuel - 1, successes);
    }

    logger.info('Loop completed', { totalSuccesses: successes.length });
    return successes;
}

async function main(filename: string): Promise<boolean> {
    logger.info('Starting main verification process', { filename });
    const planTask = generatePlan(filename);
    const plan = await planTask();

    if (O.isNone(plan)) {
        logger.info('No plan generated, verification failed');
        return false;
    }

    const successes = await loop(plan.value, 5);
    logger.info('Verification completed', {
        successCount: successes.length,
        succeeded: successes.length > 0
    });
    return successes.length > 0;
}

const program = new Command();

program
    .name("lemmas-loop")
    .description("Loop over lemmas until successful")
    .argument("<filename>", "File to check")
    .action(async (filename) => {
        try {
            logger.info('Starting lemmas loop', { filename });
            const result = await main(filename);
            logger.info('Lemmas loop completed', { result });
            process.exit(result ? 0 : 1);
        } catch (err) {
            logger.error('Unexpected error occurred', { error: err });
            process.exit(1);
        }
    });

program.parse();
