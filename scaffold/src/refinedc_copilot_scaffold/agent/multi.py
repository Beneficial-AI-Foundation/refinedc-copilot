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
)
from refinedc_copilot_scaffold.agent.lemma_assist import lemma_assist_agent
from refinedc_copilot_scaffold.tools.verification import (
    run_refinedc,
)


class VerificationReport(BaseModel):
    """Final report of the verification attempt"""

    success: bool
    iterations: int
    final_annotations: list[str]
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


async def verification_flow(
    source_path: Path,
    project_dir: str,
    codebase: CodebaseContext,
    previous_state: VerificationState | None = None,
) -> VerificationReport:
    """Coordinate the verification flow between agents"""
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

    # Initialize state from previous attempt if available
    state = previous_state or VerificationState()
    iterations = state.iterations_used
    helper_lemmas = state.helper_lemmas
    current_annotations = state.current_annotations

    # Get just the src/file.c part from the artifacts path
    try:
        relative_path = source_path.relative_to(
            working_dir.absolute()
        )  # Fixed direction
        # Construct source path relative to codebase root
        file = codebase.files.get(relative_path)
    except ValueError:
        logfire.error(
            "File lookup failed",
            attempted_path=str(relative_path),
            available_files=list(codebase.files.keys()),
        )
        raise ValueError(f"File not found in codebase: {relative_path}")

    # Create analysis context
    analysis_context = SpecAnalysisContext(
        codebase=codebase,
        current_file=file,
        existing_specs=None,
    )

    # Only generate initial specs if we don't have any from previous attempt
    if not current_annotations:
        if config.meta.logging:
            logfire.info("Starting specification generation")

        spec_result = await spec_assist_agent.run(
            f"Generate RefinedC specifications for the code in {source_path}",
            deps=analysis_context,
        )
        current_annotations = spec_result.data.annotations

        if config.meta.logging:
            logfire.info(
                "Generated initial specifications",
                annotation_count=len(current_annotations),
            )
    else:
        logfire.info(
            "Resuming with existing specifications", count=len(current_annotations)
        )

    # First loop: Keep trying until we get valid specs
    remaining_iterations = config.agents.spec_assist.max_iterations - iterations
    for i in range(remaining_iterations):
        iterations = state.iterations_used + i + 1
        if config.meta.logging:
            logfire.info(
                "Checking specifications",
                iteration=iterations,
            )

        refinedc_check = await run_refinedc(
            RunContext(
                deps=analysis_context,
                model=config.agents.spec_assist,
                usage="check",
                prompt="Check if the annotations are valid",
            ),
            source_path,
            working_dir,
            check_only=True,
        )

        # If we get a successful check, great!
        if (
            "successfully checked" in refinedc_check.lower()
            and "invalid" not in refinedc_check.lower()
        ):
            if config.meta.logging:
                logfire.info("Verification succeeded with valid specifications!")
            return VerificationReport(
                success=True,
                iterations=iterations,
                final_annotations=current_annotations,
                helper_lemmas=helper_lemmas,
                error_message=None,
                suggestions=None,
                current_state=state,
            )

        # If specs are invalid, regenerate them
        if any(
            x in refinedc_check.lower()
            for x in ["invalid", "annotations on function", "are invalid"]
        ):
            if config.meta.logging:
                logfire.error(
                    "Specifications are invalid, regenerating",
                    error_snippet=refinedc_check[:200],
                )

            spec_result = await spec_assist_agent.run(
                f"Generate RefinedC specifications for the code in {source_path}. Previous attempt was invalid: {refinedc_check}",
                deps=analysis_context,
            )
            current_annotations = spec_result.data.annotations
            continue

        # If we get here and see a side condition error, break to lemma generation
        if "cannot solve side condition" in refinedc_check.lower():
            break

        # If we get here, something unexpected happened
        if config.meta.logging:
            logfire.error(
                "Unexpected verification result",
                output=refinedc_check[:200],
            )
        return VerificationReport(
            success=False,
            iterations=iterations,
            final_annotations=current_annotations,
            helper_lemmas=helper_lemmas,
            error_message=f"Unexpected verification result: {refinedc_check[:200]}",
            suggestions="Please check the RefinedC output for details",
            current_state=state,
        )

    # Update state as we go
    state.current_annotations = current_annotations
    state.helper_lemmas = helper_lemmas
    state.iterations_used = iterations
    state.last_error = refinedc_check

    # If we get here with a side condition error, try generating lemmas
    if "cannot solve side condition" in refinedc_check.lower():
        for lemma_iterations in range(config.agents.lemma_assist.max_iterations):
            if config.meta.logging:
                logfire.warning(
                    "Valid specs but need helper lemmas",
                    iteration=lemma_iterations + 1,
                    error_snippet=refinedc_check[:200],
                )

            lemma_result = await lemma_assist_agent.run(
                f"Generate helper lemma for verification error:\n{refinedc_check}",
            )
            helper_lemmas.append(lemma_result.data.lemma)

            # Try verification again with the new lemma
            refinedc_check = await run_refinedc(
                RunContext(
                    deps=analysis_context,
                    model=config.agents.spec_assist,
                    usage="check",
                    prompt="Check if the annotations are valid with new lemma",
                ),
                source_path,
                working_dir,
                check_only=True,
            )

            if "successfully checked" in refinedc_check.lower():
                return VerificationReport(
                    success=True,
                    iterations=iterations + lemma_iterations,
                    final_annotations=current_annotations,
                    helper_lemmas=helper_lemmas,
                    error_message=None,
                    suggestions=None,
                    current_state=state,
                )

    # If we get here, we've exceeded max iterations
    if config.meta.logging:
        logfire.error(
            "Verification failed - max iterations exceeded",
            spec_iterations=iterations,
            lemma_iterations=lemma_iterations
            if "cannot solve side condition" in refinedc_check.lower()
            else 0,
            total_lemmas=len(helper_lemmas),
        )

    return VerificationReport(
        success=False,
        iterations=iterations
        + (
            lemma_iterations
            if "cannot solve side condition" in refinedc_check.lower()
            else 0
        ),
        final_annotations=current_annotations,
        helper_lemmas=helper_lemmas,
        error_message="Max iterations exceeded",
        suggestions="""
        Consider:
        1. Reviewing and simplifying the code
        2. Adjusting the specifications
        3. Breaking the verification into smaller parts
        4. Resuming the verification with the current state
        """,
        current_state=state,  # Include state in report for resuming later
    )
