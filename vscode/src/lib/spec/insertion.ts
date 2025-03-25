import * as E from "fp-ts/Either";
import { Annotation, AnnotationPoint } from "../types";
import { parser, traverseTree } from "./parser";

/**
 * Parses C code and finds all functions and loops
 */
function findAnnotationPoints(
  code: string,
): E.Either<Error, AnnotationPoint[]> {
  try {
    const tree = parser.parse(code);
    const points = traverseTree(tree.rootNode);

    // Sort points by their position in the file (from end to beginning)
    // This ensures that when we insert annotations, the indices remain valid
    return E.right(points.sort((a, b) => b.startIndex - a.startIndex));
  } catch (error) {
    return E.left(new Error(`Failed to parse C code: ${error}`));
  }
}

/**
 * Inserts annotations into the code at the specified points
 */
function insertAnnotations(code: string, annotations: Annotation[]): string {
  let result = code;

  for (const annotation of annotations) {
    const { point, content } = annotation;
    const { startIndex } = point;
    let indendation = "";
    let lineStart = result.lastIndexOf("\n", startIndex);
    if (lineStart === -1) {
      lineStart = 0;
    } else {
      lineStart += 1;
    }
    indendation =
      result.substring(lineStart, startIndex).match(/^\s*/)?.[0] || "";

    // Add a newline after the content if it doesn't already end with one
    let formattedContent = content;
    if (!formattedContent.endsWith("\n")) {
      formattedContent += "\n";
    }

    const indentedContent = formattedContent
      .split("\n")
      .map((line) => (line ? indendation + line : line))
      .join("\n");

    result =
      result.substring(0, startIndex) +
      indentedContent +
      result.substring(startIndex);
  }

  return result;
}

export { findAnnotationPoints, insertAnnotations };
