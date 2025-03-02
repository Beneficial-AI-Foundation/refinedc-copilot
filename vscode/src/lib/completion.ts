import { ReaderTaskEither } from "fp-ts/ReaderTaskEither";
import * as TE from "fp-ts/TaskEither";
import OpenAI from "openai";
import * as dotenv from "dotenv";
import * as path from "path";
import { ChatCompletionMessageParam } from "openai/resources";
dotenv.config({ path: path.resolve(__dirname, "./../../../.env") });

interface OpenAIConfig {
    devPrompt: string; // Also known as system prompt
    model: string;
}

function makeOpenAI(): OpenAI {
    return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// Define error type
interface ApiError {
    type: "ApiError";
    error: unknown;
}

// Define request parameters
interface CompletionParams {
    prompt: string;
}

// Create the RTE function
function createCompletion(
    params: CompletionParams,
): ReaderTaskEither<OpenAIConfig, ApiError, string> {
    return ({ devPrompt, model }) =>
        TE.tryCatch(
            async () => {
                const openai = makeOpenAI();
                const messages: ChatCompletionMessageParam[] = [
                    {
                        content: devPrompt,
                        role: "developer",
                        name: "system",
                    },
                    {
                        content: params.prompt,
                        role: "user",
                        name: "quinn",
                    },
                ];
                const completion = await openai.chat.completions.create({
                    model,
                    messages,
                });
                return completion.choices[0].message.content || "";
            },
            (error): ApiError => ({ type: "ApiError", error }),
        );
}

export { createCompletion };
