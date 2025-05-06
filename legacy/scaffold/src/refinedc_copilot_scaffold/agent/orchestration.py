from __future__ import annotations

from pathlib import Path

import logfire
from pydantic import BaseModel, Field

from refinedc_copilot_scaffold.config import load_config, get_coq_root
from refinedc_copilot_scaffold.agent.spec_assist import (
    spec_assist_agent,
    CodebaseContext,
    SpecAnalysisContext,
    SpecAssistResult,
)
from refinedc_copilot_scaffold.agent.lemma_assist import (
    lemma_assist_agent,
    LemmaContext,
    generate_coq_file,
    LEMMAS_FILENAME,
)
from refinedc_copilot_scaffold.tools.verification import run_refinedc
from refinedc_copilot_scaffold.tools.io import (
    write_file,
    get_artifact_path,
    insert_annotations,
)
from refinedc_copilot_scaffold.codebase.models import SourceFile

config = load_config()


class VerificationReport(BaseModel):
    """Final report of the verification attempt"""

    success: bool
    iterations: int
    source_with_specs_final: str
    helper_lemmas: list[str]
    error_message: str | None
    suggestions: str | None
    current_state: VerificationState | None = None  # Add state for resuming


class VerificationState(BaseModel):
    """State of the verification process"""

    current_annotations: list[str] | None = None
    helper_lemmas: list[str] = Field(default_factory=list)
    last_error: str | None = None
    iterations_used: int = 0


async def _initialize_verification(
    source_path: Path,
    project_dir: str,
    codebase: CodebaseContext,
    previous_state: VerificationState | None = None,
) -> tuple[Path, SpecAnalysisContext, VerificationState]:
    """Initialize the verification process and return working context"""
    working_dir = config.paths.artifacts_dir / project_dir

    if config.meta.logging:
        logfire.info(
            "Starting verification flow",
            source=str(source_path),
            working_dir=str(working_dir),
            project_dir=project_dir,
            resuming=previous_state is not None,
        )

    state = previous_state or VerificationState()

    try:
        relative_path = source_path.relative_to(working_dir.absolute())
        file = codebase.files.get(relative_path)
    except ValueError:
        logfire.error(
            "File lookup failed",
            attempted_path=str(relative_path),
            available_files=list(codebase.files.keys()),
        )
        raise ValueError(f"File not found in codebase: {relative_path}")

    analysis_context = SpecAnalysisContext(
        codebase=codebase,
        current_file=file,
        existing_specs=None,
    )

    return working_dir, analysis_context, state


async def _generate_initial_specs(
    source_path: Path,
    analysis_context: SpecAnalysisContext,
    state: VerificationState,
) -> list[str]:
    """Generate initial specifications if none exist"""

    if not state.current_annotations:
        if config.meta.logging:
            logfire.info("Starting specification generation")

        spec_result = await spec_assist_agent.run(
            f"Generate RefinedC specifications for the code in {source_path}",
            deps=analysis_context,
        )
        state.current_annotations = spec_result.data.annotations  # Store in state

        # Write annotations to the file
        modified_content = insert_annotations(
            analysis_context.current_file.content, spec_result.data
        )

        # Check if annotations were actually inserted
        if (
            modified_content == analysis_context.current_file.content
            and spec_result.data.annotations
        ):
            logfire.warning(
                "No annotations were inserted automatically, adding them manually"
            )
            lines = analysis_context.current_file.content.splitlines()
            for annotation in spec_result.data.annotations:
                if not annotation.strip().startswith("//"):
                    annotation = f"// {annotation}"
                lines.insert(0, annotation)
            modified_content = "\n".join(lines)

        # Update the file content with the modified content
        analysis_context.current_file.content = modified_content

        logfire.info(
            "Generated initial specifications",
            num_annotations=len(spec_result.data.annotations),
            content_preview=modified_content[:200],
        )

        return spec_result.data.annotations
    else:
        logfire.info(
            "Resuming with existing specifications",
            count=len(state.current_annotations),
        )
        return state.current_annotations


async def _try_verification_with_specs(
    source_path: Path,
    working_dir: Path,
    analysis_context: SpecAnalysisContext,
    current_annotations: list[str],
    state: VerificationState,
) -> VerificationReport:
    """Try verification with current specifications"""
    max_iterations = config.agents.spec_assist.max_iterations
    remaining_iterations = max_iterations - state.iterations_used

    # Loop through multiple attempts at generating specs
    for iteration in range(remaining_iterations):
        state.iterations_used += 1
        current_iteration = state.iterations_used

        # Get the path where we'll write the file
        file_path = get_artifact_path(source_path, working_dir)

        # Log the artifact path and ensure it exists
        logfire.info(
            "Verification attempt",
            iteration=current_iteration,
            max_iterations=max_iterations,
            source_path=str(source_path),
            working_dir=str(working_dir),
            artifact_path=str(file_path),
            parent_exists=file_path.parent.exists(),
        )

        # Log the annotations we're trying to insert
        for i, annotation in enumerate(current_annotations):
            logfire.info(f"Annotation {i}: {annotation}")

        # Create a copy of the source file for the artifact
        artifact_file = SourceFile(
            path=file_path,
            content=analysis_context.current_file.content,
            original_content=analysis_context.current_file.content,
        )

        # Create a SpecAssistResult with the current annotations
        spec_result = SpecAssistResult(
            annotations=current_annotations,  # Use the annotations directly
            insertion_points=[],  # We'll use automatic insertion based on function names
            helper_lemmas=state.helper_lemmas,
            explanation="Generated annotations for verification",
            source_file_with_specs_final="",
        )

        # Apply annotations to the artifact file
        modified_content = insert_annotations(artifact_file.content, spec_result)

        # If no annotations were inserted, manually add them at the top
        if modified_content == artifact_file.content and current_annotations:
            logfire.warning(
                "No annotations were inserted automatically, adding them manually"
            )
            lines = artifact_file.content.splitlines()
            for annotation in current_annotations:
                lines.insert(0, annotation)
            modified_content = "\n".join(lines)

        # Update the artifact file content with the modified content
        artifact_file.content = modified_content

        # Write the annotated file to the artifact path
        write_file(file_path, modified_content)

        # Verify file was written with annotations
        try:
            with open(file_path, "r") as f:
                written_content = f.read()

            annotations_found = [
                annotation
                for annotation in current_annotations
                if annotation in written_content
            ]
            logfire.info(
                "Written file content check",
                path=str(file_path),
                content_preview=written_content[:200],
                annotations_found=len(annotations_found),
                total_annotations=len(current_annotations),
            )

            if not annotations_found and current_annotations:
                logfire.error(
                    "No annotations found in written file!",
                    path=str(file_path),
                    content_size=len(written_content),
                )
        except Exception as e:
            logfire.error("Error checking written file", error=str(e))

        # Verify the file was written correctly
        if not file_path.exists():
            logfire.error(
                "Failed to write artifact file",
                file_path=str(file_path),
            )
            raise FileNotFoundError(f"Failed to write artifact file: {file_path}")

        # Run verification on the artifact file
        result = await run_refinedc(
            file_path=file_path,
        )

        # First check return code for success/failure
        if result.success:
            # If we get here, verification succeeded
            logfire.info(
                "Verification succeeded",
                iteration=current_iteration,
                file=str(file_path),
                num_annotations=len(current_annotations),
            )

            # Update the analysis context with the modified content
            analysis_context.current_file.content = modified_content

            # Get the final annotated content
            final_annotated_content = modified_content

            # Write the final verified file again to ensure it has the annotations
            try:
                write_file(file_path, final_annotated_content)

                logfire.info(
                    "Wrote final verified file",
                    path=str(file_path),
                    size=file_path.stat().st_size,
                    content_preview=final_annotated_content[:200],
                )
            except Exception as e:
                logfire.error(
                    "Failed to write final file", path=str(file_path), error=str(e)
                )

            return VerificationReport(
                success=True,
                iterations=current_iteration,
                source_with_specs_final=final_annotated_content,
                helper_lemmas=state.helper_lemmas,
                error_message=None,
                suggestions=None,
                current_state=state,
            )

        # Verification failed, try again with new specs if we have iterations left
        logfire.error(
            "Verification attempt failed",
            iteration=current_iteration,
            returncode=result.returncode,
            error_snippet=result.output[:200],
            full_error=result.output,
            file=str(file_path),
        )

        # Store the last error in the state
        state.last_error = result.output

        # If we have more iterations, generate new specs
        if iteration < remaining_iterations - 1:
            try:
                spec_result = await spec_assist_agent.run(
                    f"Generate RefinedC specifications for the code in {source_path}. Previous attempt failed: {result.output}",
                    deps=analysis_context,
                )
                current_annotations = spec_result.data.annotations
                state.current_annotations = current_annotations  # Update state

                logfire.info(
                    "Generated new specifications",
                    iteration=current_iteration,
                    num_new_annotations=len(current_annotations),
                )
            except Exception as e:
                logfire.error(
                    "Failed to generate specifications",
                    error=str(e),
                    iteration=current_iteration,
                    file=str(file_path),
                )
                raise

    # If we get here, we've exhausted all iterations
    return VerificationReport(
        success=False,
        iterations=state.iterations_used,
        source_with_specs_final=modified_content,
        helper_lemmas=state.helper_lemmas,
        error_message=f"Verification failed after {state.iterations_used} iterations. Last error: {state.last_error}",
        suggestions="Consider trying with helper lemmas or manually adjusting the specifications.",
        current_state=state,
    )


async def _try_verification_with_lemmas(
    source_path: Path,
    working_dir: Path,
    analysis_context: SpecAnalysisContext,
    state: VerificationState,
) -> VerificationReport:
    """Try verification by generating helper lemmas"""

    # Get the artifact path once at the start
    file_path = get_artifact_path(source_path, working_dir)

    # Make sure the file path includes the project structure
    # Use the same logic as in _try_verification_with_specs
    if not file_path.is_relative_to(working_dir):
        # Create a path that preserves the structure: working_dir/project_name/src/file.c
        # project_name = working_dir.name
        src_dir = working_dir / "src"
        file_path = src_dir / source_path.name
        src_dir.mkdir(parents=True, exist_ok=True)

        logfire.info(
            "Adjusted artifact path to preserve project structure",
            original=str(source_path),
            adjusted=str(file_path),
        )

    # Extract project directory name from working_dir
    project_dir = working_dir.name

    # Get coq_root from project config
    coq_root = get_coq_root(project_dir, config)

    # Create the import annotation for the C file
    import_annotation = f"//@rc::import {LEMMAS_FILENAME} from {coq_root}"

    # Add the import annotation to the current annotations if not already present
    if state.current_annotations is None:
        state.current_annotations = []

    if import_annotation not in state.current_annotations:
        state.current_annotations.insert(0, import_annotation)

        # Update the file content with the import annotation
        # Instead of just inserting at the beginning, we need to preserve existing annotations
        lines = analysis_context.current_file.content.splitlines()

        # Find where to insert the import annotation
        # We want to insert it at the top, but after any existing annotations that start with //@rc::
        insert_position = 0
        for i, line in enumerate(lines):
            if line.strip().startswith("//@rc::") and import_annotation not in line:
                insert_position = i + 1
            elif not line.strip().startswith("//@rc::") and i > 0:
                break

        # Insert the import annotation at the appropriate position
        lines.insert(insert_position, import_annotation)
        analysis_context.current_file.content = "\n".join(lines)

        logfire.info(
            "Added lemma import annotation to C file",
            annotation=import_annotation,
            position=insert_position,
        )

        # Write the updated C file with the import annotation immediately
        write_file(file_path, analysis_context.current_file.content)

        logfire.info(
            "Wrote C file with import annotation to disk",
            path=str(file_path),
            content_preview=analysis_context.current_file.content[:200],
        )

    for lemma_iterations in range(config.agents.lemma_assist.max_iterations):
        if config.meta.logging:
            logfire.warning(
                "Valid specs but need helper lemmas",
                iteration=lemma_iterations + 1,
                error_snippet=state.last_error[:200] if state.last_error else None,
            )

        # Create lemma context
        lemma_context = LemmaContext(
            codebase=analysis_context.codebase,
            c_file=analysis_context.current_file,
            existing_lemmas=None,
        )

        # Generate lemmas
        lemma_result = await lemma_assist_agent.run(
            f"Generate helper lemma for verification error:\n{state.last_error}",
            deps=lemma_context,
        )

        # Create output path for lemma file
        lemma_output_path = (
            working_dir / "src" / "proofs" / source_path.stem / f"{LEMMAS_FILENAME}.v"
        )
        lemma_output_path.parent.mkdir(parents=True, exist_ok=True)

        # Generate the Coq file with the lemmas - don't pass project_dir since we're handling the import in the C file
        generate_coq_file(lemma_result.data, lemma_output_path)

        # Get the lemma content as a string
        lemma_content = "\n".join(
            "\n".join(
                [
                    f"Lemma {lemma.name}" + ":" if not lemma.name.endswith(":") else "",
                    f"  {lemma.statement}" + "."
                    if not lemma.statement.endswith(".")
                    else "",
                    # "Proof.",
                    # *[f"  {line}." for line in lemma.proof.splitlines()],
                    # "Qed.",
                    "Proof.",
                    "Admitted.",
                    "",
                ]
            )
            for lemma in lemma_result.data.lemmas
        )

        # Add the lemma to the state
        state.helper_lemmas.append(lemma_content)

        # Only write the file if we've modified it since the last write
        if lemma_iterations > 0:  # Skip first write since we already wrote it above
            write_file(file_path, analysis_context.current_file.content)
            logfire.info(
                "Wrote updated C file for verification",
                path=str(file_path),
                iteration=lemma_iterations,
            )

        # Run verification with the lemma
        result = await run_refinedc(
            file_path=file_path,
        )

        if result.success:
            final_annotated_content = analysis_context.current_file.content
            return VerificationReport(
                success=True,
                iterations=state.iterations_used + lemma_iterations,
                source_with_specs_final=final_annotated_content,
                helper_lemmas=state.helper_lemmas,
                error_message=None,
                suggestions=None,
                current_state=state,
            )

        # Update state with latest error
        state.last_error = result.output

    if config.meta.logging:
        logfire.error(
            "Verification failed - max iterations exceeded",
            spec_iterations=state.iterations_used,
            lemma_iterations=lemma_iterations,
            total_lemmas=len(state.helper_lemmas),
        )

    final_annotated_content = analysis_context.current_file.content
    return VerificationReport(
        success=False,
        iterations=state.iterations_used + lemma_iterations,
        source_with_specs_final=final_annotated_content,
        helper_lemmas=state.helper_lemmas,
        error_message="Max iterations exceeded",
        suggestions="""
        Consider:
        1. Adjusting the specifications
        2. Breaking the verification into smaller parts
        3. Resuming the verification with the current state
        """,
        current_state=state,
    )


async def flow(
    source_path: Path,
    project_dir: str,
    codebase: CodebaseContext,
) -> VerificationReport:
    """Main verification flow for a single source file"""
    # Initialize verification state and context
    working_dir, analysis_context, state = await _initialize_verification(
        source_path=source_path,
        project_dir=project_dir,
        codebase=codebase,
        previous_state=None,
    )

    # Generate initial specifications only if enabled in config
    if config.agents.spec_assist.enabled:
        current_annotations = await _generate_initial_specs(
            source_path=source_path, analysis_context=analysis_context, state=state
        )
    else:
        logfire.info(
            "Specification generation is disabled, using existing annotations if any",
            file=str(source_path),
        )
        # Use existing annotations from the file if any
        current_annotations = state.current_annotations or []
        if not current_annotations:
            # Try to extract existing annotations from the file content
            lines = analysis_context.current_file.content.splitlines()
            current_annotations = [
                line.strip() for line in lines if line.strip().startswith("[[rc::")
            ]
            state.current_annotations = current_annotations

            logfire.info(
                "Found existing annotations in file",
                count=len(current_annotations),
                annotations=current_annotations,
            )

    # Try verification with specs first
    result = await _try_verification_with_specs(
        source_path=source_path,
        working_dir=working_dir,
        analysis_context=analysis_context,
        current_annotations=current_annotations,
        state=state,
    )

    # Get the artifact path
    file_path = get_artifact_path(source_path, working_dir)

    # Ensure the final file has the annotations
    if result.source_with_specs_final:
        logfire.info(
            "Writing final result to artifact file",
            path=str(file_path),
            success=result.success,
            content_preview=result.source_with_specs_final[:200],
        )

        # Write the final file with annotations
        write_file(file_path, result.source_with_specs_final)

        # Verify the file was written with annotations
        try:
            with open(file_path, "r") as f:
                final_content = f.read()

            logfire.info(
                "Final file content check",
                path=str(file_path),
                content_preview=final_content[:200],
                content_size=len(final_content),
                has_annotations=any(
                    ann in final_content for ann in current_annotations
                ),
            )
        except FileNotFoundError as e:
            logfire.error("Error checking final file", error=str(e))

    # If specs verification failed but we haven't tried lemmas yet, try with lemmas
    if not result.success and config.agents.lemma_assist.enabled:
        lemma_result = await _try_verification_with_lemmas(
            source_path=source_path,
            working_dir=working_dir,
            analysis_context=analysis_context,
            state=state,
        )

        # Ensure the final file has the annotations after lemma verification
        if lemma_result.source_with_specs_final:
            logfire.info(
                "Writing final lemma result to artifact file",
                path=str(file_path),
                success=lemma_result.success,
                content_preview=lemma_result.source_with_specs_final[:200],
            )

            # Write the final file with annotations
            write_file(file_path, lemma_result.source_with_specs_final)

            return lemma_result

    return result
