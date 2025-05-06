import { pipe } from "fp-ts/function";
import * as T from "fp-ts/Task";
import { XMLParser } from "fast-xml-parser";
import logger from "../util/logger";
import { createCompletion } from "../completionClient";
import {
    AnnotationPoint,
    Annotation,
    RefinedCError,
    Messages,
    messagesFrom,
    AnnotationCompletion,
} from "../types";
import {
    specsSystemPrompt,
    generateAnnotationInitPrompt,
    generateAnnotationContinuePrompt,
} from "../prompting";

interface xmlTag {
    "#text": string;
    "@_description": string;
}

function parseAnnotations(
    response: string,
    point: AnnotationPoint,
): Annotation[] {
    const parser = new XMLParser({
        isArray: () => false,
        ignoreAttributes: false,
        preserveOrder: false,
    });
    const wrappedResult = `<root>${response}</root>`;
    const parsed = parser.parse(wrappedResult);
    logger.debug("Parsed response", { parsed });
    // Sometimes it follows instructions and returns each spec in separate tags, other times it does not
    if (parsed.root.annotation.map) {
        const annotationStrings = parsed.root.annotation as xmlTag[];
        logger.debug("Extracted annotations", { annotationStrings });
        const annotations = annotationStrings.map((annotation) => ({
            point,
            content: annotation["#text"],
            description:
                annotation["@_description"] ||
                "TODO: annotation description failed to parse",
        }));
        logger.debug("Generated annotations", { annotations });
        return annotations;
    } else {
        const annotationStrings = parsed.root.annotation as xmlTag;
        logger.debug("Extracted annotations", { annotationStrings });
        const annotations = [
            {
                point,
                content: annotationStrings["#text"],
                description:
                    annotationStrings["@_description"] ||
                    "TODO: annotation description failed to parse",
            },
        ];
        logger.debug("Generated annotations", { annotations });
        return annotations;
    }
}

async function generateAnnotationsForPoint(
    point: AnnotationPoint,
    messages: Messages,
): Promise<AnnotationCompletion> {
    logger.info("Generating annotation", { point });
    const cfg = {
        model: "claude-3-7-sonnet-20250219",
        maxTokens: 2000,
        systemPrompt: await specsSystemPrompt,
    };
    const task = pipe(
        messages,
        createCompletion,
        (rt) => rt(cfg),
        T.map((response) => {
            const text =
                response.content[0].type === "text"
                    ? response.content[0].text
                    : "TODO: handle";
            return {
                annotations: parseAnnotations(text, point),
                messages: messagesFrom(response),
            };
        }),
    );
    return task();
}

function initGenerateAnnotationsForPoint(
    point: AnnotationPoint,
): Promise<AnnotationCompletion> {
    return generateAnnotationsForPoint(point, [
        { role: "user", content: generateAnnotationInitPrompt(point) },
    ]);
}

function continueGenerateAnnotationsForPoint(
    point: AnnotationPoint,
    { stdout, stderr }: RefinedCError,
    messagesSoFar: Messages,
): Promise<AnnotationCompletion> {
    return generateAnnotationsForPoint(point, [
        ...messagesSoFar,
        {
            role: "user",
            content: generateAnnotationContinuePrompt(point, stdout, stderr),
        },
    ]);
}

export { initGenerateAnnotationsForPoint, continueGenerateAnnotationsForPoint };
