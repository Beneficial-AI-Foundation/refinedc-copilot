import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { exec } from "child_process";
import { pipe } from "fp-ts/function";
import * as A from "fp-ts/Array";
import * as E from "fp-ts/Either";
import * as TE from "fp-ts/TaskEither";
import * as T from "fp-ts/Task";
import nunjucks from "nunjucks";
import { XMLParser } from "fast-xml-parser";
import { createCompletionOpenAI } from "./completionClient";
import { CoqErrorType, CoqError, CoqOutcome } from "./types";
import logger from './util/logger';

async function generateLemmas(goals: string[]): Promise<string[]> {
    logger.info('Generating lemmas', { goalCount: goals.length });
    const devPrompt = nunjucks.render("prompts/lemmaStatements.dev.prompt");
    const model = "gpt-4o";

    const lemmaPromises = goals.map((goal) => {
        return new Promise<string>((resolve, reject) => {
            logger.debug('Processing goal', { goal });
            const task = pipe(
                createCompletionOpenAI({ prompt: goal }),
                (rte) => rte({ devPrompt, model }),
                TE.map((response) => {
                    logger.debug('Generated lemma successfully');
                    resolve(response);
                    return response;
                }),
                TE.mapLeft((error) => {
                    logger.error('Failed to generate lemma', { error });
                    reject(error);
                    return error;
                }),
            );
            task();
        });
    });

    const results = await Promise.all(lemmaPromises);
    logger.info('Completed lemma generation', { count: results.length });
    return results;
}

const imports: string[] = [
    "From caesium Require Import base notation tactics.",
    "From refinedc.typing Require Import naive_simpl typing type_options.",
    "From lithium Require Import hooks.",
];
const admitted: string = "Proof. Admitted.";

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

function parseErrorToCoqError(parseError: LemmaCompletionParseError): CoqError {
    return {
        type: CoqErrorType.FileSystemError,
        stdout: "",
        stderr: parseError.miscParseError,
        exitcode: 1,
    };
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

function fileErrorToCoqError(fileError: FileIOError): CoqError {
    return {
        type: CoqErrorType.FileSystemError,
        stdout: "",
        stderr: fileError.miscFileIOError,
        exitcode: 1,
    };
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
function cleanupTempFile(
    filePath: path.ParsedPath,
): TE.TaskEither<FileIOError, void> {
    return TE.tryCatch(
        async () => {
            await fs.promises.unlink(String(filePath)).catch(() => {});
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

function extractAndRunLemmas(lemmaResults: string[]): Promise<CoqOutcome[]> {
    logger.info('Extracting and running lemmas', { resultCount: lemmaResults.length });

    const processLemmas = pipe(
        extractCoqCode(lemmaResults),
        A.map(
            E.fold(
                (error) => {
                    logger.error('Failed to parse lemma result', { error });
                    return TE.left(parseErrorToCoqError(error));
                },
                (coqProgram) => {
                    logger.debug('Successfully extracted Coq program');
                    return pipe(
                        createTempFile(coqProgram),
                        TE.mapLeft((error) => {
                            logger.error('Failed to create temp file', { error });
                            return fileErrorToCoqError(error);
                        }),
                        TE.chain((path) =>
                            pipe(
                                runCoqc(path),
                                TE.map(() => {
                                    logger.debug('Successfully ran Coq program');
                                    return path;
                                }),
                            ),
                        ),
                        TE.chain((path) =>
                            pipe(
                                cleanupTempFile(path),
                                TE.mapLeft(fileErrorToCoqError),
                            ),
                        ),
                    );
                },
            ),
        ),
        (tasks) => Promise.all(tasks),
    );

    return processLemmas;
}

export { generateLemmas, extractAndRunLemmas };
