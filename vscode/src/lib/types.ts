import { TaskEither } from "fp-ts/TaskEither";
import { ReaderTask } from "fp-ts/ReaderTask";
import { Option } from "fp-ts/Option";
import { Reader } from "fp-ts/Reader";
import { State } from "fp-ts/State";
import Anthropic from "@anthropic-ai/sdk";

/**
 * Types for verification outcomes
 */
type VerificationOutcome<T> = TaskEither<T, void>;

enum RefinedCErrorType {
    MalformedSpec,
    NeedsLemmasOrIncorrectImplementation,
    UnfinishedProof,
    FilesystemOrToolError,
}

interface RefinedCError {
    type: RefinedCErrorType;
    stdout: string;
    stderr: string;
    exitcode: number;
}

function errorToRefinedCError(error: Error) {
    return {
        type: RefinedCErrorType.FilesystemOrToolError,
        stdout: error.name,
        stderr: error.message,
        exitcode: -1,
    } as RefinedCError;
}

type RefinedCOutcome = VerificationOutcome<RefinedCError>;

enum CoqErrorType {
    SyntaxError,
    IncompleteProof,
    HasAdmitted,
    UnknownErrorType,
    FileSystemError,
}

interface CoqError {
    type: CoqErrorType;
    stdout: string;
    stderr: string;
    exitcode: number;
}

type CoqOutcome = VerificationOutcome<CoqError>;

/**
 * Types for verification plans
 */
enum VerificationPlanType {
    EditSpec,
    StateLemmas,
}

interface EditSpecPlan {
    type: VerificationPlanType.EditSpec;
}

interface StateLemmasPlan {
    type: VerificationPlanType.StateLemmas;
    goals: string[];
}

type VerificationPlan = EditSpecPlan | StateLemmasPlan;

/**
 * Types of annotation points
 * TODO: fill out as needed
 */
enum AnnotationPointType {
    Function,
    Loop,
}

interface AnnotationPoint {
    name: Option<string>;
    startIndex: number;
    type: AnnotationPointType;
    body: string;
}

interface Annotation {
    point: AnnotationPoint;
    content: string;
    description?: string;
}

/*
 * Types for completion clients
 */
interface AnthropicConfig {
    model: string;
    maxTokens: number;
    systemPrompt: string;
    temperature?: number;
}

type Messages = Anthropic.MessageParam[];

function messagesFrom(response: Anthropic.Messages.Message): Messages {
    return response.content.map((block) => ({
        role: "assistant",
        content: block.type === "text" ? block.text : block.type,
    }));
}

interface AnnotationCompletion {
    annotations: Annotation[];
    messages: Messages;
}

function flattenAnnotationCompletions(
    annotationCompletions: AnnotationCompletion[],
): AnnotationCompletion {
    return {
        annotations: annotationCompletions.flatMap(
            (completion) => completion.annotations,
        ),
        messages: annotationCompletions.flatMap(
            (completion) => completion.messages,
        ),
    };
}

/**
 * Types for agents
 */
interface AgentState {
    messages: Messages;
    readonly jobType: VerificationPlanType;
    readonly currentFile: string;
    iterations: number;
    readonly maxIterations: number;
    completed: boolean;
}

type Agent<ToolOutcome> = Reader<
    AnthropicConfig,
    State<AgentState, ToolOutcome>
>;

export {
    type VerificationOutcome,
    type RefinedCError,
    RefinedCErrorType,
    errorToRefinedCError,
    type RefinedCOutcome,
    type CoqError,
    CoqErrorType,
    type CoqOutcome,
    type VerificationPlan,
    VerificationPlanType,
    type AnnotationPoint,
    AnnotationPointType,
    type Annotation,
    type AnthropicConfig,
    type Messages,
    messagesFrom,
    type AnnotationCompletion,
    flattenAnnotationCompletions,
    type AgentState,
    type Agent,
};
