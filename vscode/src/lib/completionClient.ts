import * as path from "path";
import * as dotenv from "dotenv";
import { ReaderTaskEither } from "fp-ts/ReaderTaskEither";
import * as TE from "fp-ts/TaskEither";
import * as T from "fp-ts/Task";
import * as R from "fp-ts/Reader";
import * as RT from "fp-ts/ReaderTask";
import OpenAI from "openai";
import { ChatCompletionMessageParam } from "openai/resources";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicConfig } from "./types";
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
function createCompletionOpenAI(
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
                return (
                    completion.choices[0].message.content ||
                    "Client returned empty message"
                );
            },
            (error): ApiError => ({ type: "ApiError", error }),
        );
}

/* Anthropic with history */
function makeAnthropic(): Anthropic {
    return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

function createUserMessage(prompt: string): Anthropic.MessageParam {
    return {
        role: "user",
        content: prompt,
    };
}

function createCompletion(
    messages: Anthropic.MessageParam[],
): RT.ReaderTask<AnthropicConfig, Anthropic.Message> {
    const anthropic = makeAnthropic();
    return ({
        model,
        maxTokens,
        systemPrompt,
        temperature,
    }: AnthropicConfig) => {
        return async () =>
            await anthropic.messages.create({
                model,
                messages,
                max_tokens: maxTokens,
                system: systemPrompt,
                temperature: temperature ?? 0.9,
            });
    };
}

export { createCompletionOpenAI, createUserMessage, createCompletion };
