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
  // First, sort annotations by their position in the file (from end to beginning)
  // This ensures that when we insert annotations, the indices remain valid
  const sortedAnnotations = [...annotations].sort((a, b) => b.point.startIndex - a.point.startIndex);

  let result = code;

  for (const annotation of sortedAnnotations) {
    const { point, content } = annotation;
    const { startIndex } = point;
    let indentation = "";

    // Find the start of the line containing the insertion point
    let lineStart = result.lastIndexOf("\n", startIndex);
    if (lineStart === -1) {
      lineStart = 0;
    } else {
      lineStart += 1;
    }

    // Extract the indentation from the line
    indentation = result.substring(lineStart, startIndex).match(/^\s*/)?.[0] || "";

    // Check if there's an existing annotation at this point
    // Look for RefinedC annotations in the [[rc::...]] format
    const nextContentRegex = /^((?:\[\[rc::.*?\]\]\s*)+)/;
    const afterInsertionPoint = result.substring(startIndex);
    const existingAnnotationMatch = afterInsertionPoint.match(nextContentRegex);

    // Add a newline after the content if it doesn't already end with one
    let formattedContent = content;
    if (!formattedContent.endsWith("\n")) {
      formattedContent += "\n";
    }

    // Apply indentation to each line of the content
    const indentedContent = formattedContent
      .split("\n")
      .map((line) => (line ? indentation + line : line))
      .join("\n");

    // If there's an existing annotation, replace it; otherwise, insert the new annotation
    if (existingAnnotationMatch) {
      const existingAnnotationLength = existingAnnotationMatch[1].length;
      result =
        result.substring(0, startIndex) +
        indentedContent +
        result.substring(startIndex + existingAnnotationLength);
    } else {
      result =
        result.substring(0, startIndex) +
        indentedContent +
        result.substring(startIndex);
    }
  }

  return result;
}

export { findAnnotationPoints, insertAnnotations };
