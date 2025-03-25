import Parser from "tree-sitter";
import C from "tree-sitter-c";
import * as O from "fp-ts/Option";
import { AnnotationPoint, AnnotationPointType } from "./../types";
import logger from "./../util/logger";

// Initialize the parser with the C grammar
const parser = new Parser();
parser.setLanguage(C as unknown as Parser.Language);

/**
 * Recursively traverses the syntax tree to find functions and loops
 * and returns a list of annotation points.
 */
function traverseTree(node: Parser.SyntaxNode): AnnotationPoint[] {
  let points: AnnotationPoint[] = [];

  // Check if the node is a function definition
  if (node.type === "function_definition") {
    const declarator = node.childForFieldName("declarator");
    const bodyNode = node.childForFieldName("body");
    let functionName = "TODO placeholder";
    let bodyText = "";

    // Try to extract the function name
    if (declarator) {
      const directDeclarator = declarator.childForFieldName("declarator");
      if (directDeclarator && directDeclarator.text) {
        functionName = directDeclarator.text;
      }
    }

    // Extract the body of the function
    if (bodyNode) {
      bodyText = bodyNode.text;
    }

    points.push({
      name: O.some(functionName),
      startIndex: node.startIndex,
      type: AnnotationPointType.Function,
      body: bodyText,
    });
  }

  // Check if the node is a loop (for, while, do-while)
  if (
    node.type === "for_statement" ||
    node.type === "while_statement" ||
    node.type === "do_statement"
  ) {
    const bodyNode = node.childForFieldName("body");
    let bodyText = "";

    // Extract the body of the loop
    if (bodyNode) {
      bodyText = bodyNode.text;
      logger.info("Found loop body", { bodyText });
    }

    points.push({
      name: O.none,
      startIndex: node.startIndex,
      type: AnnotationPointType.Loop,
      body: bodyText,
    });
  }
  // Recursively process child nodes and accumulate points
  for (let i = 0; i < node.childCount; i++) {
    points = points.concat(traverseTree(node.child(i)!));
  }

  return points;
}

function findAnnotationPoints(code: string): AnnotationPoint[] {
  const tree = parser.parse(code);
  return traverseTree(tree.rootNode);
}

export { parser, traverseTree, findAnnotationPoints };
