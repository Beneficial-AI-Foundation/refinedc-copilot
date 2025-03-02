import { pipe } from "fp-ts/function";
import * as TE from "fp-ts/TaskEither";
import * as E from "fp-ts/Either";
import OpenAI from "openai";
import { exec } from "child_process";
import * as dotenv from "dotenv";
import * as path from "path";

// Load .env from parent directory
dotenv.config({ path: path.resolve(__dirname, "./../../../.env") });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const runCommand = (cmd: string): TE.TaskEither<Error, string> =>
    TE.tryCatch(
        () =>
            new Promise((resolve, reject) =>
                exec(cmd, (error, stdout) =>
                    error ? reject(error) : resolve(stdout),
                ),
            ),
        (error) => new Error(String(error)),
    );

const runRefinedCheck = (filepath: string): TE.TaskEither<Error, string> =>
    // Assumes you already ran refinedc init in the appropriate directory
    TE.tryCatch(
        () =>
            new Promise((resolve, reject) =>
                exec(`refinedc check ${filepath}`, (error, stdout) =>
                    error ? reject(error) : resolve(stdout),
                ),
            ),
        (error) => new Error(String(error)),
    );
const validatePath = (filepath: string): TE.TaskEither<Error, string> =>
    TE.fromEither(
        path.isAbsolute(filepath) || filepath.startsWith("./")
            ? E.right(filepath)
            : E.left(new Error("Invalid filepath")),
    );

const main = pipe(
    validatePath("./artifacts/trivial/src/example.c"),
    TE.chain(runRefinedCheck),
);

const callLLM = (content: string): TE.TaskEither<Error, string> =>
    TE.tryCatch(
        async () => {
            const response = await openai.chat.completions.create({
                model: "gpt-3.5-turbo",
                messages: [{ role: "user", content }],
            });
            return response.choices[0].message.content || "";
        },
        (error) => new Error(String(error)),
    );

main()
    .then((result) => console.log(result))
    .catch((error) => console.error(error));
