import { pipe } from "fp-ts/function";
import * as A from "fp-ts/Array";
import * as T from "fp-ts/Task";
import * as E from "fp-ts/Either";
import * as O from "fp-ts/Option";
import * as S from "fp-ts/State";
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
    errorToRefinedCError,
} from "./../types";
import { findAnnotationPoints, insertAnnotations } from "./insertion";
import { readCFile, writeCFile } from "./fsio";
import { runRefinedCCheck } from "./refinedc";
import {
    continueGenerateAnnotationsForPoint,
    initGenerateAnnotationsForPoint,
} from "./completion";

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

function writeAndCheck(
    filePath: string,
    annotatedCode: string,
): RefinedCOutcome {
    return pipe(
        writeCFile(filePath, annotatedCode),
        TE.mapLeft(errorToRefinedCError),
        TE.chain(() => runRefinedCCheck(filePath)),
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
        TE.mapLeft(errorToRefinedCError),
        // Generate and insert annotations
        TE.chain(({ code, points }) => {
            return pipe(
                // Generate annotations for all points
                points,
                initGenerateAnnotations,
                // Insert annotations into the code
                T.map((annotations) => insertAnnotations(code, annotations)),
                TE.fromTask<string, Error>,
                TE.mapLeft(errorToRefinedCError),
            );
        }),
        TE.chain((annotatedCode: string) =>
            writeAndCheck(filePath, annotatedCode),
        ),
    );
}

/**
 * Handles errors by continuing to generate annotations based on the error
 */
function continueProcessFile(
    state: AgentState,
    error: RefinedCError,
): RefinedCOutcome {
    return pipe(
        // Read the file and find annotation points
        readFileAndFindPoints(state.currentFile),

        // Continue generating annotations based on the error
        TE.chain(({ code, points }) => {
            return pipe(
                // Continue generating annotations for all points
                continueGeneratingAnnotations(points, error, state.messages),

                // Insert annotations into the code
                T.map((annotations) => insertAnnotations(code, annotations)),

                // Convert to TaskEither
                TE.rightTask<Error, string>,
            );
        }),
        // Write the updated code back to the file
        TE.chain((annotatedCode) =>
            writeCFile(state.currentFile, annotatedCode),
        ),
        TE.mapLeft(errorToRefinedCError),
        // Run RefinedC check again
        TE.chain(() => runRefinedCCheck(state.currentFile)),
    );
}

/**
 * Runs RefinedC check and determines if there's an error to handle
 */
function checkAndHandleError
    (state: AgentState): RefinedCOutcome {
        return pipe(
            // Run RefinedC check on the current file
            runRefinedCCheck(state.currentFile),

            // Convert the outcome to an Option of error
            TE.fold(
                (error) => T.of(O.some(error)),
                () => T.of(O.none),
            ),

            // If there's an error, handle it, otherwise we're done
            T.chain((errorOption) =>
                pipe(
                    errorOption,
                    O.fold(
                        // No error, we're done
                        () => TE.right(undefined),
                        // Handle the error
                        (error) => continueProcessFile(state, error),
                    ),
                ),
            ),
        );
    };

function specAgent(filePath: string): [RefinedCOutcome, AgentState] {
    const initialState = createInitialAgentState(filePath);

    // Define a recursive function to handle the loop
    function runLoop (state: AgentState, firstRun = false): [RefinedCOutcome, AgentState] {
        // If we shouldn't continue, return the current state
        if (!shouldContinue(state)) {
            return [TE.right(undefined), state];
        }

        // For the first run, initialize the process
        const processTask = firstRun
            ? initProcessFile(filePath)
            : checkAndHandleError(state);

        const outcome = pipe(
            processTask,
            TE.fold(
                (error: RefinedCError) => {
                    console.log("Error in processTask", error);
                    // If there's an error, update state and continue processing
                    const updatedState = updateState(state, []);

                    // If we should continue, recurse
                    if (shouldContinue(updatedState)) {
                        return runLoop(updatedState)[0];
                    } else {
                        // Otherwise return the error
                        return TE.left(error);
                    }
                },
                () => {
                    // If successful, mark as completed
                    const updatedState = updateState(state, [], true);
                    return TE.right(undefined);
                }
            )
        );

        return [outcome, state];
    };

    // Start the loop with the initial state
    return runLoop(initialState, true);
}

export { specAgent };
