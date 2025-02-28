from pathlib import Path
import logfire
import os
import sys

from refinedc_copilot_scaffold.agent.models import SpecAssistResult
from refinedc_copilot_scaffold.codebase.parsing import CSourceParser


def insert_annotations(file_content: str, result: SpecAssistResult) -> str:
    """Insert annotations into source code content and return the modified content.

    Args:
        file_content: The source file content to modify
        result: The SpecAssistResult containing annotations to insert

    Returns:
        The modified source code with annotations inserted
    """
    parser = CSourceParser()
    points = parser.find_annotation_points(parser.parse_file(file_content))

    # If no annotation points were found, insert at the beginning
    if not points:
        logfire.warning(
            "No annotation points found, inserting at the beginning of the file"
        )
        lines = file_content.splitlines()
        for annotation in result.annotations:
            lines.insert(0, annotation)
        return "\n".join(lines)

    # Log the annotation points found
    for point in points:
        logfire.info(
            f"Found annotation point: line={point.line}, context={point.context}, name={point.name}"
        )

    # If we have annotations but no insertion points were specified,
    # insert all annotations before the first function
    if result.annotations and not result.insertion_points:
        first_function = None
        for point in points:
            if point.context == "function" and point.name:
                first_function = point
                break

        if first_function:
            logfire.info(
                f"Inserting all annotations before function {first_function.name} at line {first_function.line}"
            )
            lines = file_content.splitlines()
            formatted_annotations = []
            for annotation in result.annotations:
                formatted_annotations.append(" " * first_function.indent + annotation)

            # Insert all annotations before the first function
            for annotation in reversed(formatted_annotations):
                lines.insert(first_function.line - 1, annotation)

            return "\n".join(lines)

    # If we still haven't inserted anything, fall back to the original implementation
    # but with more logging
    logfire.warning(
        "Falling back to original insertion logic",
        num_annotations=len(result.annotations),
        num_points=len(points),
    )

    lines = file_content.splitlines()
    insertions = []  # [(line_number, annotation)]

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
                ann for ann in result.annotations if insertion_point.location in ann
            ]

            if point_annotations:
                # Add proper indentation (use default if we don't have a point)
                indent = 0
                for point in points:
                    if (
                        point.context == "function"
                        and point.name == insertion_point.location
                    ):
                        indent = point.indent
                        break

                indented_annotations = [" " * indent + ann for ann in point_annotations]
                insertions.extend((target_line, ann) for ann in indented_annotations)

    # Fall back to automatic insertion if no explicit points or if some annotations weren't matched
    remaining_annotations = []
    if not result.insertion_points:
        remaining_annotations = result.annotations
    else:
        # Find annotations that weren't matched to insertion points
        matched_annotations = []
        for point in result.insertion_points:
            matched_annotations.extend(
                [ann for ann in result.annotations if point.location in ann]
            )
        remaining_annotations = [
            ann for ann in result.annotations if ann not in matched_annotations
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
                    # Add proper indentation to annotations
                    indented_annotations = [
                        " " * point.indent + ann for ann in func_annotations
                    ]
                    insertions.extend((point.line, ann) for ann in indented_annotations)

    # Sort insertions in reverse order to maintain line numbers
    new_lines = lines.copy()
    for line, annotation in sorted(insertions, reverse=True):
        new_lines.insert(line - 1, annotation)  # -1 because line numbers are 1-based

    # Log what we've done
    logfire.info(
        "Inserted annotations",
        num_annotations=len(result.annotations),
        num_insertions=len(insertions),
        num_insertion_points=len(result.insertion_points)
        if result.insertion_points
        else 0,
        processed_functions=list(processed_functions),
    )

    # Return the modified content
    return "\n".join(new_lines)


def write_file(
    file_path: Path,
    content: str,
) -> None:
    """Write content to a file, ensuring the parent directory exists."""
    try:
        # Convert to absolute path and ensure it's a Path object
        file_path = Path(file_path).absolute()

        logfire.info(
            "Writing file",
            path=str(file_path),
            content_size=len(content),
        )

        # Ensure parent directory exists
        file_path.parent.mkdir(parents=True, exist_ok=True)

        # Write the file
        file_path.write_text(content)
    except Exception as exc:
        logfire.error(
            "Failed to write file",
            path=str(file_path),
            error=str(exc),
            error_type=type(exc).__name__,
        )
        raise exc


def get_artifact_path(
    source_path: Path,
    working_dir: Path,
) -> Path:
    """Get the appropriate path in the artifacts directory that preserves the original project structure."""
    # Ensure paths are absolute
    source_path = Path(source_path).absolute()
    working_dir = Path(working_dir).absolute()

    # Try to preserve the original directory structure
    # First, check if the source path contains a 'src' directory
    source_parts = source_path.parts
    src_index = -1

    # Look for 'src' directory in the path
    for i, part in enumerate(source_parts):
        if part == "src":
            src_index = i
            break

    if src_index >= 0:
        # If we found a 'src' directory, preserve the structure from there
        relative_path = Path(*source_parts[src_index:])
        file_path = working_dir / relative_path
    else:
        # If no 'src' directory found, try to preserve at least the last two components
        # of the path (typically directory/file.c)
        if len(source_parts) > 1:
            file_path = working_dir / "src" / source_parts[-2] / source_parts[-1]
        else:
            # Fallback to just src/filename.c
            file_path = working_dir / "src" / source_path.name

    # Ensure the directory exists
    file_path.parent.mkdir(parents=True, exist_ok=True)

    logfire.info(
        "Creating artifact path",
        source=str(source_path),
        working_dir=str(working_dir),
        artifact_path=str(file_path),
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
