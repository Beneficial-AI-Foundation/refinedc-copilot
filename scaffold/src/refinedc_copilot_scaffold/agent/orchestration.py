from __future__ import annotations

from pathlib import Path

import logfire
from pydantic import BaseModel, Field
from pydantic_ai import RunContext

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
    check_file_system_access,
)


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
    config = load_config()
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
    config = load_config()

    if not state.current_annotations:
        if config.meta.logging:
            logfire.info("Starting specification generation")

        spec_result = await spec_assist_agent.run(
            f"Generate RefinedC specifications for the code in {source_path}",
            deps=analysis_context,
        )
        state.current_annotations = spec_result.data.annotations  # Store in state

        # Write annotations to the file
        insert_annotations(analysis_context.current_file, spec_result.data)

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
    config = load_config()
    remaining_iterations = (
        config.agents.spec_assist.max_iterations - state.iterations_used
    )

    # Get the path where we'll write the file
    file_path = get_artifact_path(source_path, working_dir)

    # Make sure the file path includes the project structure
    # If source_path is from the original project, we need to preserve its structure
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

    # Check file system access
    file_system_ok = check_file_system_access(working_dir)
    if not file_system_ok:
        logfire.error(
            "File system access check failed, verification may fail",
            working_dir=str(working_dir),
        )

    for i in range(remaining_iterations):
        iterations = state.iterations_used + i + 1

        logfire.info(
            "Starting verification attempt",
            iteration=iterations,
            num_annotations=len(current_annotations),
            file=str(file_path),
        )

        # Log the annotations we're about to try
        for idx, annotation in enumerate(current_annotations):
            logfire.debug(
                "Annotation to try",
                iteration=iterations,
                index=idx,
                annotation=annotation,
            )

        # Write current annotations to file before verification
        spec_result = SpecAssistResult(
            annotations=[
                str(annotation) for annotation in current_annotations
            ],  # Ensure all are strings
            insertion_points=[],  # We'll use automatic insertion based on function names
            helper_lemmas=[
                str(lemma) for lemma in state.helper_lemmas
            ],  # Ensure all are strings
            explanation="Generated annotations for verification",
            source_file_with_specs_final="",  # This will be populated after insertion
        )

        # Apply annotations
        insert_annotations(analysis_context.current_file, spec_result)

        # Update the final source with specs
        spec_result.source_file_with_specs_final = analysis_context.current_file.content

        # Write the file with annotations
        write_file_with_specs(
            file_path, spec_result.source_file_with_specs_final, iterations
        )

        # Log file path details
        logfire.info(
            "File path details after writing",
            file_path=str(file_path),
            file_path_absolute=str(Path(file_path).absolute()),
            file_path_exists=Path(file_path).exists(),
            parent_exists=Path(file_path).parent.exists(),
            parent_path=str(Path(file_path).parent),
        )

        # After writing the file, check if it exists and its content
        try:
            if Path(file_path).exists():
                with open(file_path, "r") as f:
                    content = f.read()
                logfire.info(
                    "File content verification",
                    file_exists=True,
                    file_size=Path(file_path).stat().st_size,
                    content_preview=content[:100] if content else "Empty content",
                )
            else:
                logfire.error(
                    "File does not exist after writing", file_path=str(file_path)
                )
        except Exception as e:
            logfire.error(
                "Error checking file after writing",
                file_path=str(file_path),
                error=str(e),
                error_type=type(e).__name__,
            )

        result = await run_refinedc(
            RunContext(
                deps=analysis_context,
                model=config.agents.spec_assist,
                usage="check",
                prompt="Check if the annotations are valid",
            ),
            working_dir=working_dir,
            file_path=file_path,
        )

        # First check return code for success/failure
        if result.returncode != 0:
            logfire.error(
                "Verification attempt failed",
                iteration=iterations,
                returncode=result.returncode,
                error_snippet=result.output[:200],
                full_error=result.output,  # Logfire will handle large strings appropriately
                file=str(file_path),
            )

            try:
                spec_result = await spec_assist_agent.run(
                    f"Generate RefinedC specifications for the code in {source_path}. Previous attempt failed: {result.output}",
                    deps=analysis_context,
                )
            except Exception as e:
                logfire.error(
                    "Failed to generate specifications",
                    error=str(e),
                    iteration=iterations,
                    file=str(file_path),
                )
                raise
            current_annotations = spec_result.data.annotations

            logfire.info(
                "Generated new specifications",
                iteration=iterations,
                num_new_annotations=len(current_annotations),
            )
            continue

        # If we get here, verification succeeded
        logfire.info(
            "Verification succeeded",
            iteration=iterations,
            file=str(file_path),
            num_annotations=len(current_annotations),
        )

        # Get the final annotated content
        final_annotated_content = analysis_context.current_file.content

        # Write the final successful version to a "final" file
        final_file_path = file_path.with_name(
            f"{file_path.stem}_final{file_path.suffix}"
        )
        try:
            with open(final_file_path, "w") as f:
                f.write(final_annotated_content)

            logfire.info(
                "Wrote final verified file",
                path=str(final_file_path),
                size=final_file_path.stat().st_size,
            )
        except Exception as e:
            logfire.error(
                "Failed to write final file", path=str(final_file_path), error=str(e)
            )

        return VerificationReport(
            success=True,
            iterations=iterations,
            source_with_specs_final=final_annotated_content,  # Use the full annotated content
            helper_lemmas=state.helper_lemmas,
            error_message=None,
            suggestions=None,
            current_state=state,
        )

    # If we get here, we've exceeded max iterations
    logfire.error(
        "Max specification iterations exceeded",
        max_iterations=remaining_iterations,
        last_error=result.output,
        file=str(file_path),
        total_attempts=iterations,
    )

    # Get the current annotated content even though verification failed
    final_annotated_content = analysis_context.current_file.content

    return VerificationReport(
        success=False,
        iterations=remaining_iterations,
        source_with_specs_final=final_annotated_content,  # Use the full annotated content
        helper_lemmas=state.helper_lemmas,
        error_message=f"Max iterations ({remaining_iterations}) exceeded. Last error: {result.output}",
        suggestions=None,
        current_state=state,
    )


async def _try_verification_with_lemmas(
    source_path: Path,
    working_dir: Path,
    analysis_context: SpecAnalysisContext,
    state: VerificationState,
) -> VerificationReport:
    """Try verification by generating helper lemmas"""
    config = load_config()

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
            ctx=RunContext(
                deps=analysis_context,
                model=config.agents.spec_assist,
                usage="check",
                prompt="Check if the annotations are valid with new lemma",
            ),
            working_dir=working_dir,
            file_path=file_path,
        )

        if result.returncode == 0:
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
    if result.success:
        return result

    # If specs weren't enough, try with lemmas
    return await _try_verification_with_lemmas(
        source_path=source_path,
        working_dir=working_dir,
        analysis_context=analysis_context,
        state=state,
    )
