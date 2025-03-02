import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { exec } from "child_process";
import { pipe } from "fp-ts/function";
import * as E from "fp-ts/Either";
import * as TE from "fp-ts/TaskEither";
import * as O from "fp-ts/Option";
import nunjucks from "nunjucks";
import { XMLParser } from "fast-xml-parser";
import { createCompletion } from "./completion";
import { CoqErrorType, CoqError, CoqOutcome } from "./types";

async function generateLemmas(goals: string[]): Promise<string[]> {
    const devPrompt = nunjucks.render("prompts/lemmaStatements.dev.prompt");
    const model = "gpt-4o";
    const lemmaPromises = goals.map((goal) => {
        return new Promise<string>((resolve, reject) => {
            const task = pipe(
                createCompletion({ prompt: goal }),
                (rte) => rte({ devPrompt, model }),
                TE.map((response) => {
                    resolve(response);
                    return response;
                }),
                TE.mapLeft((error) => {
                    reject(error);
                    return error;
                }),
            );
            task();
        });
    });
    return Promise.all(lemmaPromises);
}

const imports: string[] = [
    "From caesium Require Import base notation tactics.",
    "From refinedc.typing Require Import naive_simpl typing type_options.",
    "From lithium Require Import hooks.",
];
const admitted: string = "Admitted.";

function classifyCoqError(stderr: string): CoqError {
    if (stderr.includes("Syntax error:")) {
        return {
            type: CoqErrorType.SyntaxError,
            stdout: "",
            stderr,
            exitcode: 1,
        };
    }
    if (stderr.includes("There are pending proofs")) {
        return {
            type: CoqErrorType.IncompleteProof,
            stdout: "",
            stderr,
            exitcode: 1,
        };
    }
    return {
        type: CoqErrorType.UnknownErrorType,
        stdout: "",
        stderr,
        exitcode: 1,
    };
}

interface LemmaCompletionParseError {
    miscParseError: string;
}

/**
 * Extract Coq code from lemma results using XML parser
 */
function extractCoqCode(
    lemmaResults: string[],
): E.Either<LemmaCompletionParseError, string>[] {
    const parser = new XMLParser({
        isArray: () => false,
        ignoreAttributes: true,
        preserveOrder: false,
    });

    const coqPrograms = lemmaResults.map((result) => {
        try {
            const wrappedResult = `<root>${result}</root>`;
            const parsed = parser.parse(wrappedResult);
            return E.right(parsed.root?.coq as string);
        } catch (miscParseError) {
            return E.left({ miscParseError: String(miscParseError) });
        }
    });
    return coqPrograms;
}

interface FileIOError {
    miscFileIOError: string;
}
/**
 * Create a temporary file with Coq code.
 */
function createTempFile(
    coqProgram: string,
): TE.TaskEither<FileIOError, path.ParsedPath> {
    return TE.tryCatch(
        async () => {
            const tempFilePath = path.join(
                os.tmpdir(),
                `lemmas_${Date.now()}.v`,
            );
            const fileContent = [...imports, "", coqProgram, "", admitted].join(
                "\n",
            );

            await fs.promises.writeFile(tempFilePath, fileContent);
            return path.parse(tempFilePath);
        },
        (error) => {
            return {
                miscFileIOError: String(error),
            };
        },
    );
}

/**
 * Clean up a temporary file
 */
function cleanupTempFile(filePath: string): TE.TaskEither<FileIOError, void> {
    return TE.tryCatch(
        async () => {
            await fs.promises.unlink(filePath).catch(() => {});
        },
        (error) => {
            return {
                miscFileIOError: String(error),
            };
        },
    );
}

/**
 * Run coqc on a file
 */
function runCoqc(filePath: path.ParsedPath): CoqOutcome {
    return TE.tryCatch(
        () =>
            new Promise<void>((resolve, reject) => {
                exec(`coqc ${filePath}`, (exit, stdout, stderr) => {
                    if (exit) {
                        reject({
                            type: classifyCoqError(stderr),
                            stdout,
                            stderr,
                            exitcode: exit.code,
                        });
                    } else {
                        resolve();
                    }
                });
            }),
        (coqError): CoqError => ({
            ...(coqError as CoqError),
            exitcode: (coqError as CoqError).exitcode ?? -1,
        }),
    );
}

function extractAndRunLemmas(lemmaResults: string[]): CoqOutcome[] {
    const task = pipe(
        TE.fromEither(extractCoqCode(lemmaResults)),
        TE.chain((coqProgram: string) => {
            const coqcTask = pipe(
                createTempFile(coqProgram),
                TE.chainFirst(runCoqc),
                TE.chain(cleanupTempFile),
            );
            return coqcTask();
        }),
    );
    return task();
}

export { generateLemmas, extractAndRunLemmas };
