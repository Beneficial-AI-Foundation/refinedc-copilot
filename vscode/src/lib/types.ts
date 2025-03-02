import { TaskEither } from "fp-ts/TaskEither";

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

type RefinedCOutcome = TaskEither<RefinedCError, void>;

enum CoqErrorType {
    SyntaxError,
    IncompleteProof,
    HasAdmitted,
    UnknownErrorType,
}

interface CoqError {
    type: CoqErrorType;
    stdout: string;
    stderr: string;
    exitcode: number;
}

type CoqOutcome = TaskEither<CoqError, void>;

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
    RefinedCError,
    RefinedCErrorType,
    RefinedCOutcome,
    CoqError,
    CoqErrorType,
    CoqOutcome,
    VerificationPlan,
    VerificationPlanType,
};
