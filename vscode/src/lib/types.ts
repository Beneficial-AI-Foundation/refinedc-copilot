import { TaskEither } from "fp-ts/TaskEither";
import { ReaderTask } from "fp-ts/ReaderTask";
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
}

interface RefinedCError {
    type: RefinedCErrorType;
    stdout: string;
    stderr: string;
    exitcode: number;
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
 */
enum AnnotationPointType {
    Function,
    Loop,
}

interface AnnotationPoint {
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

type Agent<ToolOutcome> = State<
    AgentState,
    ReaderTask<AnthropicConfig, ToolOutcome>
>;

export {
    VerificationOutcome,
    RefinedCError,
    RefinedCErrorType,
    RefinedCOutcome,
    CoqError,
    CoqErrorType,
    CoqOutcome,
    VerificationPlan,
    VerificationPlanType,
    AnnotationPoint,
    AnnotationPointType,
    Annotation,
    AnthropicConfig,
    Messages,
    AgentState,
    Agent,
};
