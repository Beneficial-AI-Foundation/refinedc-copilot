from __future__ import annotations

from pathlib import Path

import logfire
from pydantic import BaseModel, Field

from refinedc_copilot_scaffold.config import load_config
from refinedc_copilot_scaffold.agent.spec_assist import (
    spec_assist_agent,
    CodebaseContext,
    SpecAnalysisContext,
    SpecAssistResult,
)
from refinedc_copilot_scaffold.agent.lemma_assist import lemma_assist_agent
from refinedc_copilot_scaffold.tools.verification import run_refinedc
from refinedc_copilot_scaffold.tools.io import (
    write_file_with_specs,
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
        write_file_with_specs(file_path, modified_content)

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
                write_file_with_specs(file_path, final_annotated_content)

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

    for lemma_iterations in range(config.agents.lemma_assist.max_iterations):
        if config.meta.logging:
            logfire.warning(
                "Valid specs but need helper lemmas",
                iteration=lemma_iterations + 1,
                error_snippet=state.last_error[:200] if state.last_error else None,
            )

        lemma_result = await lemma_assist_agent.run(
            f"Generate helper lemma for verification error:\n{state.last_error}",
        )
        state.helper_lemmas.append(lemma_result.data.lemma)

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
        1. Reviewing and simplifying the code
        2. Adjusting the specifications
        3. Breaking the verification into smaller parts
        4. Resuming the verification with the current state
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

    # Generate initial specifications
    current_annotations = await _generate_initial_specs(
        source_path=source_path, analysis_context=analysis_context, state=state
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
        write_file_with_specs(file_path, result.source_with_specs_final)

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
            write_file_with_specs(file_path, lemma_result.source_with_specs_final)

            return lemma_result

    return result
