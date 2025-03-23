import * as fs from "fs/promises";
import * as path from "path";
import * as TE from "fp-ts/TaskEither";

/**
 * Reads a C file and returns its content
 */
function readCFile(filePath: string): TE.TaskEither<Error, string> {
  return TE.tryCatch(
    () => fs.readFile(filePath, "utf8"),
    (reason) => new Error(`Failed to read file: ${reason}`),
  );
}

/**
 * Writes content to a file
 */
function writeCFile(
  filePath: string,
  content: string,
): TE.TaskEither<Error, void> {
  return TE.tryCatch(
    () => fs.writeFile(filePath, content, "utf8"),
    (reason) => new Error(`Failed to write file: ${reason}`),
  );
}

export { readCFile, writeCFile };
