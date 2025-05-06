import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import * as TE from "fp-ts/TaskEither";
import logger from "../util/logger";

/**
 * Reads a C file and returns its content
 */
function readCFile(filePath: string): TE.TaskEither<Error, string> {
  return TE.tryCatch(
    () => fsp.readFile(filePath, "utf8"),
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
    () => fsp.writeFile(filePath, content, "utf8"),
    (reason) => new Error(`Failed to write file: ${reason}`),
  );
}

/**
 * Copies a file from a source path to an artifacts path, maintaining the directory structure
 * @param filename The source filename that starts with 'source/'
 * @returns The new filename in the artifacts directory
 */
function copyToArtifacts(filename: string): string {
    // Validate that filename starts with 'source/'
    if (!filename.startsWith("sources/")) {
        throw new Error('Filename must start with "sources/"');
    }

    // Calculate the new path by replacing 'source/' with 'artifacts/'
    const artifactsFilename = filename.replace(/^sources\//, "artifacts/");

    // Ensure destination directory exists
    const destDir = path.dirname(artifactsFilename);
    fs.mkdirSync(destDir, { recursive: true });

    // Copy the file
    fs.copyFileSync(filename, artifactsFilename);

    logger.info(`Copied ${filename} to ${artifactsFilename}`);

    return artifactsFilename;
}

export { readCFile, writeCFile, copyToArtifacts };
