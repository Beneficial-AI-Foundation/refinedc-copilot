import nunjucks from "nunjucks";
import { pipe } from "fp-ts/function";
import { AnnotationPoint, AnnotationPointType } from "./types";

const lemmasDevPrompt = nunjucks.render(
    "prompts/lemmaStatements.system.prompt",
);

async function generateSpecsSystemPrompt(argUrls: string[]): Promise<string> {
    const templateContext: Record<string, string> = {};
    for (const url of argUrls) {
        const response = await fetch(url);
        const text = await response.text();
        const urlKey = url.split("/").pop()?.toLowerCase() || url;
        templateContext[urlKey] = text;
    }
    return nunjucks.render("prompts/specs.system.prompt", templateContext);
}

const annotationsMdUrl =
    "https://gitlab.mpi-sws.org/iris/refinedc/-/raw/master/ANNOTATIONS.md";
const binarySearchExampleUrl =
    "https://gitlab.mpi-sws.org/iris/refinedc/-/raw/master/examples/binary_search.c";
const wrappingAddExampleUrl =
    "https://gitlab.mpi-sws.org/iris/refinedc/-/raw/master/examples/wrapping_add.c";

const argUrls = [
    annotationsMdUrl,
    binarySearchExampleUrl,
    wrappingAddExampleUrl,
];

const specsSystemPrompt = generateSpecsSystemPrompt(argUrls);

function generateAnnotationInitPrompt(point: AnnotationPoint): string {
    return nunjucks.render("prompts/annotationInit.user.prompt", { point });
}

function generateAnnotationContinuePrompt(
    point: AnnotationPoint,
    stdout: string,
    stderr: string,
) {
    return nunjucks.render("prompts/annotationContinue.user.prompt", {
        point,
        stdout,
        stderr,
    });
}

export {
    lemmasDevPrompt,
    specsSystemPrompt,
    generateAnnotationInitPrompt,
    generateAnnotationContinuePrompt,
};
