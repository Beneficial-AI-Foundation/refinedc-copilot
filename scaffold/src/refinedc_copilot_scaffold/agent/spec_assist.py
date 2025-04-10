from pathlib import Path
from pydantic_ai import Agent, RunContext, Tool
import logfire
from dotenv import load_dotenv

from refinedc_copilot_scaffold.config import load_config
from refinedc_copilot_scaffold.prompting import get_spec_assist_prompt
from refinedc_copilot_scaffold.tools.verification import run_refinedc
from refinedc_copilot_scaffold.tools.io import (
    insert_annotations,
    write_file,
    get_artifact_path,
)
from refinedc_copilot_scaffold.codebase.models import CodebaseContext
from refinedc_copilot_scaffold.agent.models import SpecAnalysisContext, SpecAssistResult


load_dotenv()
config = load_config()


async def analyze_file_context(
    ctx: RunContext[SpecAnalysisContext],
    line_number: int | None = None,
) -> str:
    """Analyze the context around a location, including related header/source files"""
    thefile = ctx.deps.current_file
    related_files = ctx.deps.codebase.get_related_files(thefile.path)

    # Build context from current file
    if line_number is not None:
        lines = thefile.content.splitlines()
        start = max(0, line_number - 10)
        end = min(len(lines), line_number + 10)
        current_context = "\n".join(lines[start:end])
    else:
        current_context = thefile.content

    # Add context from related files
    related_context = ""
    for related in related_files:
        if related.is_header:
            related_context += (
                f"\n\n// Related header file {related.path}:\n{related.content}"
            )
        else:
            # For source files, just include function signatures
            lines = [
                line
                for line in related.content.splitlines()
                if not line.strip().startswith("//")
            ]
            related_context += (
                f"\n\n// Related source file {related.path}:\n" + "\n".join(lines[:20])
            )

    return f"// Current file {thefile.path}:\n{current_context}{related_context}"


async def check_existing_specs(
    ctx: RunContext[SpecAnalysisContext],
) -> dict[str, str] | None:
    """Check any existing RefinedC specifications to avoid duplication and ensure consistency"""
    if ctx.deps.existing_specs:
        return {"existing": ctx.deps.existing_specs}
    return None


async def verify_specs(
    ctx: RunContext[SpecAnalysisContext],
    specs: list[str],
) -> dict[str, str | bool | dict]:
    """Verify the generated specifications"""
    # Use the centralized verification function from tools.verification
    result = await run_refinedc(
        file_path=ctx.deps.c_file,
    )
    if config.meta.logging:
        logfire.info(
            "Verification result",
            returncode=result.returncode,
            output_preview=result.output[:200],
            has_syntax_errors=result.has_syntax_errors,
            has_proof_failures=result.has_proof_failures,
        )
    return {
        "success": result.success,
        "output": result.output,
        "returncode": result.returncode,
        "has_syntax_errors": result.has_syntax_errors,
        "has_proof_failures": result.has_proof_failures,
        "error_details": {
            "invalid_annotations": [
                ann.model_dump() for ann in result.invalid_annotations
            ],
            "proof_failures": [pf.model_dump() for pf in result.proof_failures],
            "error_summary": result.error_summary,
        },
    }


# Create the agent with tools
spec_assist_agent = Agent(
    config.agents.spec_assist.model,
    deps_type=SpecAnalysisContext,
    result_type=SpecAssistResult,
    system_prompt=get_spec_assist_prompt(),
    tools=[
        Tool(analyze_file_context),
        Tool(check_existing_specs),
        Tool(verify_specs),
    ],
)


async def process_file(
    codebase: CodebaseContext,
    file_path: Path,
) -> None:
    """Process a single file to add RefinedC annotations"""
    file = codebase.files.get(file_path)
    if file is None:
        if config.meta.logging:
            logfire.error(f"File not found in codebase: {file_path}")
        return

    context = SpecAnalysisContext(
        codebase=codebase,
        current_file=file,
        existing_specs=None,
    )

    result = await spec_assist_agent.run(
        "Please analyze this C code and generate appropriate RefinedC specifications",
        deps=context,
    )

    # Update the file content with annotations
    annotated_content = insert_annotations(file.content, result.data)
    file.content = annotated_content

    # Write the annotated content to the artifacts directory
    if hasattr(config, "artifacts_dir") and config.artifacts_dir:
        artifact_path = get_artifact_path(file_path, Path(config.artifacts_dir))
        write_file(artifact_path, annotated_content)
        logfire.info(f"Wrote annotated file to {artifact_path}")


async def generate_specifications(
    codebase: CodebaseContext,
    file_path: Path,
    existing_specs: str | None = None,
) -> SpecAssistResult:
    """Main entry point to generate RefinedC specifications"""
    file = codebase.files[file_path]
    context = SpecAnalysisContext(
        codebase=codebase,
        current_file=file,
        existing_specs=existing_specs,
    )

    # Generate initial specs
    result = await spec_assist_agent.run(
        "Please analyze this C code and generate appropriate RefinedC specifications",
        deps=context,
    )

    # Ensure insertion points are properly formatted
    if hasattr(result.data, "insertion_points") and result.data.insertion_points:
        # Convert any dict insertion points to InsertionPoint objects
        from refinedc_copilot_scaffold.agent.models import InsertionPoint

        formatted_points = []
        for point in result.data.insertion_points:
            if isinstance(point, dict):
                # Set defaults for missing fields
                if "position" not in point:
                    point["position"] = "before"
                formatted_points.append(InsertionPoint(**point))
            else:
                formatted_points.append(point)

        result.data.insertion_points = formatted_points

    # Apply the annotations to the file content
    annotated_content = insert_annotations(file.content, result.data)
    file.content = annotated_content

    # Write the annotated content to the artifacts directory
    artifact_path = get_artifact_path(file_path, Path(config.paths.artifacts_dir))
    write_file(artifact_path, annotated_content)
    logfire.info(f"Wrote annotated file to {artifact_path}")

    # Verify the specs before returning
    verification = await verify_specs(RunContext(deps=context), result.data.annotations)

    if not verification["success"]:
        if verification["has_syntax_errors"]:
            # Handle syntax errors
            error_details = verification["error_details"]
            if config.meta.logging:
                logfire.error(
                    "Generated specs have syntax errors",
                    error_summary=error_details["error_summary"],
                    invalid_annotations=error_details["invalid_annotations"],
                )

            logfire.info("Attempting to fix syntax errors automatically")
            # Create a more specific prompt with error information
            error_prompt = (
                "The previous specifications had syntax errors. Please fix them:\n"
                f"{error_details['error_summary']}\n\n"
                "Details of invalid annotations:\n"
            )
            for err in error_details["invalid_annotations"]:
                error_prompt += f"- {err['location']}: {err['reason']}\n"

            error_prompt += "\nPlease generate corrected RefinedC specifications."

            # Regenerate with error information
            result = await spec_assist_agent.run(error_prompt, deps=context)
            file.content = insert_annotations(file.content, result.data)

            # Verify again
            verification = await verify_specs(
                RunContext(deps=context), result.data.annotations
            )
            if verification["has_syntax_errors"]:
                raise ValueError(
                    f"Failed to fix syntax errors in specifications: {verification['error_details']['error_summary']}"
                )
        elif verification["has_proof_failures"]:
            # Handle proof failures (valid syntax but couldn't be verified)
            if config.meta.logging:
                logfire.warning(
                    "Generated specs have valid syntax but failed verification",
                    proof_failures=verification["error_details"]["proof_failures"],
                )
        else:
            # Generic error
            if config.meta.logging:
                logfire.error(
                    "Generated specs failed verification",
                    error=verification["output"][:200],
                )
            raise ValueError(
                f"Generated specifications failed verification: {verification['output'][:200]}"
            )

    return result.data
