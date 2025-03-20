import { pipe } from "fp-ts/function";
import * as A from "fp-ts/Array";
import * as T from "fp-ts/Task";
import * as E from "fp-ts/Either";
import * as TE from "fp-ts/TaskEither";
import * as RT from "fp-ts/ReaderTask";
import {
    Agent,
    RefinedCOutcome,
    Messages,
    AgentState,
    RefinedCErrorType,
    AnthropicConfig,
    VerificationPlanType,
    AnnotationPoint,
    Annotation,
    RefinedCError,
} from "./../types";
import { findAnnotationPoints, insertAnnotations } from "./insertion";
import { readCFile, writeCFile } from "./fsio";
import { runRefinedCCheck } from "../refinedc";
import {
    continueGenerateAnnotationsForPoint,
    initGenerateAnnotationsForPoint,
} from "./completion";

/**
 * Agent<RefinedCOutcome> is a writer for tracking messages, returning refinedc outcome
 * Specifically, it is `Writer<Anthropic.MessageParam[], ReaderTask<AnthropicConfig, RefinedCOutcome>>`
 * So we need to make `ReaderTask<AnthropicConfig, RefinedCOutcome>` that takes a completion, writes it to file, and sends it to refinedc.
 * Now `RefinedCOutcome = TaskEither<RefinedCError, void>`, so this is `ReaderTask<AnthropicConfig, TaskEither<RefinedCError, void>>`
 * Which may profitably just be a `ReaderTaskEither<AnthropicConfig, RefinedCError, void>`
 *
 * Anyways
 *
 * */

/**
 * Creates an agent state with initial value
 * */
function createInitialAgentState(filepath: string): AgentState {
    return {
        messages: [],
        jobType: VerificationPlanType.EditSpec,
        currentFile: filepath,
        iterations: 0,
        maxIterations: 5,
        completed: false,
    };
}

/**
 * Checks if the agent has completed its task or reached max iterations
 */
const shouldContinue = (state: AgentState): boolean =>
    !state.completed && state.iterations < state.maxIterations;

/**
 * Updates the agent state with new messages and increments iteration count
 */
function updateState(
    state: AgentState,
    newMessages: Messages,
    completed: boolean = false,
): AgentState {
    return {
        ...state,
        messages: [...state.messages, ...newMessages],
        iterations: state.iterations + 1,
        completed: completed,
    };
}

/**
 * Reads a C file and finds annotation points
 */
const readFileAndFindPoints = (
    filePath: string,
): TE.TaskEither<Error, { code: string; points: AnnotationPoint[] }> => {
    return pipe(
        filePath,
        readCFile,
        TE.chain((code: string) => {
            // Find annotation points
            const pointsEither = findAnnotationPoints(code);

            // Convert to TaskEither
            return pipe(
                pointsEither,
                E.mapLeft(
                    (error) =>
                        new Error(
                            `Failed to find annotation points: ${error.message}`,
                        ),
                ),

                E.map((points) => ({ code, points })),
                TE.fromEither,
            );
        }),
    );
};

/**
 * Generates annotations for all points in the code
 */
function initGenerateAnnotations(
    points: AnnotationPoint[],
): T.Task<Annotation[]> {
    // Create a task that resolves to an array of annotation arrays
    return () =>
        pipe(
            // Create promises for each point
            points.map(initGenerateAnnotationsForPoint),
            // Convert array of promises to a task of array
            (promises) => Promise.all(promises).then(A.flatten),
            // Flatten the result after all promises resolve
        );
}

/**
 * Continues generating annotations based on an error
 */
function continueGeneratingAnnotations(
    points: AnnotationPoint[],
    error: RefinedCError,
    messages: Messages,
): T.Task<Annotation[]> {
    return () =>
        pipe(
            // Create promises for each point
            points.map((point) =>
                continueGenerateAnnotationsForPoint(point, error, messages),
            ),
            // Convert array of promises to a task of array
            (promises) => Promise.all(promises),
            // Flatten the result after all promises resolve
            (task) => task.then(A.flatten),
        );
}

/**
 * Processes a file by finding annotation points, generating and inserting annotations,
 * and then running the RefinedC checker
 */
function initProcessFile(filePath: string): RefinedCOutcome {
    return pipe(
        // Read the file and find annotation points
        filePath,
        readFileAndFindPoints,

        // Generate and insert annotations
        TE.map(({ code, points }) => {
            return pipe(
                // Generate annotations for all points
                points,
                initGenerateAnnotations,
                // Insert annotations into the code
                T.chain((annotations) =>
                    T.of(insertAnnotations(code, annotations)),
                ),
            );
        }),

        // Write the annotated code back to the file
        TE.chain((annotatedCodeTask) =>
            writeCFile(filePath, annotatedCodeTask()),
        ),

        // Run RefinedC check on the annotated file
        TE.chain(() => runRefinedCCheck(filePath)),
    );
}
