from pathlib import Path
import logfire
import os
import sys

from refinedc_copilot_scaffold.codebase.models import SourceFile
from refinedc_copilot_scaffold.agent.models import SpecAssistResult
from refinedc_copilot_scaffold.codebase.parsing import CSourceParser


def insert_annotations(file: SourceFile, result: SpecAssistResult) -> None:
    """Insert annotations into the source file at appropriate points.

    Args:
        file: The source file to modify
        result: The SpecAssistResult containing annotations to insert
    """
    parser = CSourceParser()
    points = parser.find_annotation_points(parser.parse_file(file.content))

    lines = file.content.splitlines()
    insertions = []  # [(line_number, annotation)]

    # Make sure all annotations are strings and properly formatted as RefinedC annotations
    string_annotations = []
    for ann in result.annotations:
        ann_str = str(ann)

        # Check if this is already a properly formatted RefinedC annotation
        if "[[rc::" in ann_str:
            string_annotations.append(ann_str)
            continue

    # Log the formatted annotations
    logfire.info(
        "Formatted RefinedC annotations",
        original_count=len(result.annotations),
        formatted_count=len(string_annotations),
        samples=string_annotations[:5] if string_annotations else [],
    )

    # Track functions we've already processed to avoid duplicates
    processed_functions = set()

    # First check if we have explicit insertion points
    if result.insertion_points:
        for insertion_point in result.insertion_points:
            # Try to find the line number for the insertion point
            target_line = None

            # If location is a function name, find it in the parsed points
            for point in points:
                if (
                    point.context == "function"
                    and point.name == insertion_point.location
                ):
                    target_line = point.line
                    # Adjust line based on position (before/after)
                    if insertion_point.position == "after":
                        target_line += 1
                    break

            # If we couldn't find it by name, try to parse as line number
            if target_line is None:
                try:
                    target_line = int(insertion_point.location)
                except ValueError:
                    logfire.warning(
                        f"Could not find insertion point for location: {insertion_point.location}"
                    )
                    continue

            # Find annotations for this insertion point
            point_annotations = [
                ann for ann in string_annotations if insertion_point.location in ann
            ]

            if point_annotations:
                # Format annotations as RefinedC comments
                formatted_annotations = []
                for ann in point_annotations:
                    if not ann.strip().startswith("//"):
                        ann = f"// {ann}"
                    formatted_annotations.append(ann)

                # Add proper indentation (use default if we don't have a point)
                indent = 0
                for point in points:
                    if (
                        point.context == "function"
                        and point.name == insertion_point.location
                    ):
                        indent = point.indent
                        break

                indented_annotations = [
                    " " * indent + ann for ann in formatted_annotations
                ]
                insertions.extend((target_line, ann) for ann in indented_annotations)

    # Fall back to automatic insertion if no explicit points or if some annotations weren't matched
    remaining_annotations = []
    if not result.insertion_points:
        remaining_annotations = string_annotations
    else:
        # Find annotations that weren't matched to insertion points
        matched_annotations = []
        for point in result.insertion_points:
            matched_annotations.extend(
                [ann for ann in string_annotations if point.location in ann]
            )
        remaining_annotations = [
            ann for ann in string_annotations if ann not in matched_annotations
        ]

    # Process remaining annotations using the function-matching approach
    if remaining_annotations:
        for point in points:
            if point.context == "function" and point.name:
                # Skip if we've already processed this function
                if point.name in processed_functions:
                    continue

                processed_functions.add(point.name)

                func_annotations = [
                    ann for ann in remaining_annotations if point.name in ann
                ]

                if func_annotations:
                    # Format annotations as RefinedC comments
                    formatted_annotations = []
                    for ann in func_annotations:
                        if not ann.strip().startswith("//"):
                            ann = f"// {ann}"
                        formatted_annotations.append(ann)

                    # Add proper indentation to annotations
                    indented_annotations = [
                        " " * point.indent + ann for ann in formatted_annotations
                    ]
                    insertions.extend((point.line, ann) for ann in indented_annotations)

    # Sort insertions in reverse order to maintain line numbers
    for line, annotation in sorted(insertions, reverse=True):
        lines.insert(line - 1, annotation)  # -1 because line numbers are 1-based

    # Update file content
    file.content = "\n".join(lines)

    # Update the final source in the result
    result.source_file_with_specs_final = file.content

    # Log what we've done
    logfire.info(
        "Inserted annotations into file",
        file_path=str(file.path),
        num_annotations=len(result.annotations),
        num_insertions=len(insertions),
        num_insertion_points=len(result.insertion_points),
        processed_functions=list(processed_functions),
    )


def write_file_with_specs(
    file_path: Path,
    content: str,
    iteration: int | None = None,
) -> None:
    """Write content to a file, ensuring the parent directory exists."""
    try:
        # Convert to absolute path and ensure it's a Path object
        file_path = Path(file_path).absolute()

        logfire.info(
            "Writing file with detailed path info",
            path=str(file_path),
            parent_path=str(file_path.parent),
            parent_exists=file_path.parent.exists(),
            content_size=len(content),
            content_preview=content[:100] if content else "Empty content",
        )

        # Ensure parent directory exists with explicit error handling
        try:
            file_path.parent.mkdir(parents=True, exist_ok=True)
            logfire.info(
                "Created parent directory",
                parent_path=str(file_path.parent),
                parent_exists=file_path.parent.exists(),
            )
        except Exception as e:
            logfire.error(
                "Failed to create parent directory",
                parent_path=str(file_path.parent),
                error=str(e),
                error_type=type(e).__name__,
            )
            raise

        # Try multiple methods to write the file
        try:
            # Method 1: Using Path.write_text
            file_path.write_text(content)
            logfire.info("Wrote file using Path.write_text")
        except Exception as e1:
            logfire.warning(
                "Failed to write using Path.write_text, trying open()", error=str(e1)
            )
            try:
                # Method 2: Using open() with 'w' mode
                with open(file_path, "w") as f:
                    f.write(content)
                logfire.info("Wrote file using open()")
            except Exception as e2:
                logfire.error("Failed to write using open()", error=str(e2))
                raise

        # Verify the file was written
        if file_path.exists():
            file_size = file_path.stat().st_size
            logfire.info(
                "Successfully verified file exists",
                path=str(file_path),
                size=file_size,
                size_matches=file_size == len(content),
            )
        else:
            logfire.error(
                "File does not exist after write attempts", path=str(file_path)
            )

    except Exception as e:
        logfire.error(
            "Failed to write file (outer exception)",
            path=str(file_path),
            error=str(e),
            error_type=type(e).__name__,
        )
        raise


def get_artifact_path(
    source_path: Path,
    working_dir: Path,
) -> Path:
    """Get the appropriate path in the artifacts directory that preserves the original project structure.

    Args:
        source_path: Original source file path
        working_dir: Working directory (artifacts dir)

    Returns:
        Path where the file should be written in artifacts
    """
    # Extract the project name from the working_dir
    project_name = working_dir.name

    # Try to find the project directory in the source path
    source_parts = source_path.parts

    # Look for the project name in the source path parts
    if project_name in source_parts:
        # Get the path relative to the project directory
        project_index = source_parts.index(project_name)
        relative_path = Path(*source_parts[project_index + 1 :])
        file_path = working_dir / relative_path
    else:
        # If we can't find the project name, preserve as much structure as possible
        # by using the last two components (typically src/file.c)
        if len(source_parts) > 2:
            file_path = working_dir / source_parts[-2] / source_parts[-1]
        else:
            # Fallback to just src/filename.c
            file_path = working_dir / "src" / source_path.name

    # Ensure the directory exists
    file_path.parent.mkdir(parents=True, exist_ok=True)

    logfire.debug(
        "Created artifact path preserving structure",
        source=str(source_path),
        working_dir=str(working_dir),
        resolved=str(file_path),
    )

    return file_path


def check_file_system_access(working_dir: Path) -> None:
    """Check if we can write to the file system in the working directory."""
    try:
        # Get temp file in the working directory
        temp_path = working_dir / f"test_write_{os.getpid()}.tmp"

        # Try to write to it
        temp_path.write_text("Test write access")

        # Check if it exists
        exists = temp_path.exists()
        size = temp_path.stat().st_size if exists else 0

        # Try to read it back
        content = temp_path.read_text() if exists else ""

        # Clean up
        if exists:
            temp_path.unlink()

        logfire.info(
            "File system access check",
            working_dir=str(working_dir),
            temp_path=str(temp_path),
            write_succeeded=exists,
            size=size,
            content_matches=content == "Test write access",
            user=os.getlogin() if hasattr(os, "getlogin") else "unknown",
            permissions=oct(os.stat(working_dir).st_mode)[-3:]
            if working_dir.exists()
            else "unknown",
        )

        return exists and content == "Test write access"
    except Exception as e:
        logfire.error(
            "File system access check failed",
            working_dir=str(working_dir),
            error=str(e),
            error_type=type(e).__name__,
            platform=sys.platform,
        )
        return False
