import { pipe } from "fp-ts/function";
import * as T from "fp-ts/Task";
import { XMLParser } from "fast-xml-parser";
import Anthropic from "@anthropic-ai/sdk";
import logger from "../util/logger";
import { createCompletion } from "../completionClient";
import { AnnotationPoint, Annotation, RefinedCError, Messages } from "../types";
import {
    specsSystemPrompt,
    generateAnnotationInitPrompt,
    generateAnnotationContinuePrompt,
} from "../prompting";

function parseAnnotations(
    response: string,
    point: AnnotationPoint,
): Annotation[] {
    const parser = new XMLParser({
        isArray: () => false,
        ignoreAttributes: true,
        preserveOrder: false,
    });
    const wrappedResult = `<root>${response}</root>`;
    const parsed = parser.parse(wrappedResult);
    const annotationStrings = parsed.root.annotation as string[];
    const annotations = annotationStrings.map((annotation) => ({
        point,
        content: annotation,
        description:
            "TODO placeholder while i figure out how to elicit attributes from fast-xml-parser",
    }));
    return annotations;
}

async function generateAnnotationsForPoint(
    point: AnnotationPoint,
    messages: Anthropic.MessageParam[],
): Promise<Annotation[]> {
    logger.info("Generating annotation", { point });
    const cfg = {
        model: "claude-3-7-sonnet-20250219",
        maxTokens: 8000,
        systemPrompt: await specsSystemPrompt,
    };
    const task: T.Task<Annotation[]> = pipe(
        messages,
        createCompletion,
        (rt) => rt(cfg),
        T.map((response) => parseAnnotations("TODO test string", point)),
    );
    return task();
}

function initGenerateAnnotationsForPoint(
    point: AnnotationPoint,
): Promise<Annotation[]> {
    return generateAnnotationsForPoint(point, [
        { role: "user", content: generateAnnotationInitPrompt(point) },
    ]);
}

function continueGenerateAnnotationsForPoint(
    point: AnnotationPoint,
    { stdout, stderr }: RefinedCError,
    messagesSoFar: Messages,
): Promise<Annotation[]> {
    return generateAnnotationsForPoint(point, [
        ...messagesSoFar,
        {
            role: "user",
            content: generateAnnotationContinuePrompt(point, stdout, stderr),
        },
    ]);
}

export { initGenerateAnnotationsForPoint, continueGenerateAnnotationsForPoint };
