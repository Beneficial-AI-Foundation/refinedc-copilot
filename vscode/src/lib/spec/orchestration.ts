import { pipe } from "fp-ts/function";
import * as A from "fp-ts/Array";
import * as T from "fp-ts/Task";
import * as E from "fp-ts/Either";
import * as O from "fp-ts/Option";
import * as S from "fp-ts/State";
import * as TE from "fp-ts/TaskEither";
import * as TO from "fp-ts/TaskOption";
import * as RT from "fp-ts/ReaderTask";
import * as fs from "fs";
import * as path from "path";
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
    AnnotationCompletion,
    flattenAnnotationCompletions,
    RefinedCError,
    errorToRefinedCError,
} from "./../types";
import logger from "./../util/logger";
import { findAnnotationPoints, insertAnnotations } from "./insertion";
import { readCFile, writeCFile } from "./fsio";
import { runRefinedCCheck, runRefinedCInit } from "./refinedc";
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
        maxIterations: 20,
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
): T.Task<AnnotationCompletion> {
    // Create a task that resolves to an array of annotation arrays
    return () =>
        pipe(
            // Create promises for each point
            points.map(initGenerateAnnotationsForPoint),
            // Convert array of promises to a task of array
            (promises) =>
                Promise.all(promises).then(flattenAnnotationCompletions),
        );
}

/**
 * Continues generating annotations based on an error
 */
function continueGeneratingAnnotations(
    points: AnnotationPoint[],
    error: RefinedCError,
    messages: Messages,
): T.Task<AnnotationCompletion> {
    return () =>
        pipe(
            // Create promises for each point
            points.map((point) =>
                continueGenerateAnnotationsForPoint(point, error, messages),
            ),
            // Convert array of promises to a task of array
            (promises) =>
                Promise.all(promises).then(flattenAnnotationCompletions),
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
function initProcessFile(
    initialState: AgentState,
): {
    outcome: RefinedCOutcome;
    state: AgentState;
} {
    let messages: Messages = [];

    // Create a RefinedCOutcome that handles the entire pipeline
    const outcome: RefinedCOutcome = pipe(
        // Read the file and find annotation points
        initialState.currentFile,
        readFileAndFindPoints,
        TE.mapLeft(errorToRefinedCError),
        // Generate and insert annotations
        TE.chain(({ code, points }) => {
            return pipe(
                // Generate annotations for all points
                points,
                initGenerateAnnotations,
                // Insert annotations into the code
                T.map<AnnotationCompletion, [string, Messages]>(
                    (annotationCompletion) => {
                        // Store messages here so they're available even if subsequent steps fail
                        messages = annotationCompletion.messages;

                        return [
                            insertAnnotations(
                                code,
                                annotationCompletion.annotations,
                            ),
                            annotationCompletion.messages,
                        ];
                    },
                ),
                TE.fromTask<[string, Messages], Error>,
                TE.mapLeft(errorToRefinedCError),
            );
        }),
        // Extract the annotated code and run writeAndCheck
        TE.chain(([annotatedCode, _]) => {
            // We've already captured the messages above, now just run the check
            return writeAndCheck(initialState.currentFile, annotatedCode);
        }),
    );

    // Return the object with both outcome and messages
    return { outcome, state: updateState(initialState, messages) };
}

/**
 * Handles errors by continuing to generate annotations based on the error
 */
function continueProcessFile(
    state: AgentState,
    error: RefinedCError,
): {
    outcome: RefinedCOutcome;
    state: AgentState;
} {
    // Initialize with a copy of the current state
    let newMessages: Messages = [];

    // Create the outcome TaskEither
    const outcome: RefinedCOutcome = pipe(
        // Read the file and find annotation points
        readFileAndFindPoints(state.currentFile),

        // Continue generating annotations based on the error
        TE.chain(({ code, points }) => {
            return pipe(
                // Continue generating annotations for all points
                continueGeneratingAnnotations(points, error, state.messages),

                // Capture messages and insert annotations into the code
                T.map((annotationCompletion) => {
                    // Store the new messages
                    newMessages = annotationCompletion.messages;

                    // Return the annotated code
                    return insertAnnotations(
                        code,
                        annotationCompletion.annotations,
                    );
                }),

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

    // Update the state with new messages and increment iterations
    const updatedState = updateState(state, newMessages);

    // Return both the outcome and updated state
    return { outcome, state: updatedState };
}

/**
 * Runs RefinedC check and determines if there's an error to handle
 */
function checkAndHandleError(state: AgentState): {
    outcome: RefinedCOutcome;
    state: AgentState;
} {
    // Create the final outcome as a composite TaskEither
    const outcome: RefinedCOutcome = pipe(
        // Run RefinedC check on the current file
        runRefinedCCheck(state.currentFile),

        // Handle any errors with continueProcessFile
        TE.orElse((error) => {
            // If there's an error, use continueProcessFile to get a new outcome
            const result = continueProcessFile(state, error);
            // Store the updated state reference for our return value
            updatedState = result.state;
            // Return the outcome from continueProcessFile
            return result.outcome;
        }),
    );

    // Track the updated state - initialize with original state
    // If there's no error, we'll mark it as completed
    let updatedState: AgentState = updateState(state, []);

    // Return the outcome and updated state
    return { outcome, state: updatedState };
}

/**
 * Generates specifications for C files.
 * Assumes that no specs have been annotated yet.
 * @param filePath string to the file to process
 * @returns Promise<[RefinedCOutcome, AgentState]>
 */
async function specAgent(
    filePath: string,
): Promise<[RefinedCOutcome, AgentState]> {
    const initialState = createInitialAgentState(filePath);

    const _void = await runRefinedCInit(filePath)();

    function runLoop(state: AgentState, firstRun = false): [RefinedCOutcome, AgentState] {
        // If we shouldn't continue, return the current state
        if (!shouldContinue(state)) {
            return [TE.right(undefined), state];
        }

        // For the first run, initialize the process
        const processTask = firstRun
            ? initProcessFile(state)
            : checkAndHandleError(state);

        // Create a variable to track the final state
        let finalState = processTask.state;

        const outcome = pipe(
            processTask.outcome,
            TE.fold(
                (error: RefinedCError) => {
                    logger.info("RefinedCError in processTask", error);

                    logger.info("Updated state messages", finalState.messages);

                    // If we should continue, recurse
                    if (shouldContinue(finalState)) {
                        const [nextOutcome, nextState] = runLoop(finalState);
                        finalState = nextState;
                        return nextOutcome;
                    } else {
                        // Otherwise return the error
                        return TE.left(error);
                    }
                },
                () => {
                    // If successful, mark as completed
                    finalState = updateState(finalState, [], true);
                    return TE.right(undefined);
                },
            ),
        );
        logger.debug("state in loop", finalState);

        return [outcome, finalState];
    }

    // Start the loop with the initial state
    return runLoop(initialState, true);
}

export { specAgent };
