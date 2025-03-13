import { TaskEither } from "fp-ts/TaskEither";

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
};
