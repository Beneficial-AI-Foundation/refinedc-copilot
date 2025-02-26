from dataclasses import dataclass
from pathlib import Path
from pydantic_ai import Agent, RunContext, Tool
import logfire
from dotenv import load_dotenv

from refinedc_copilot_scaffold.config import load_config
from refinedc_copilot_scaffold.prompting import get_spec_assist_prompt
from refinedc_copilot_scaffold.tools.verification import run_refinedc
from refinedc_copilot_scaffold.tools.io import insert_annotations
from refinedc_copilot_scaffold.codebase.models import CodebaseContext, SourceFile
from refinedc_copilot_scaffold.agent.models import SpecAssistResult


load_dotenv()
config = load_config()


@dataclass
class SpecAnalysisContext:
    """Context needed for specification analysis"""

    codebase: CodebaseContext
    current_file: SourceFile
    existing_specs: str | None = None

    @property
    def c_file(self) -> Path:
        """The path to the C file being verified, as expected by verification tools"""
        return self.current_file.path


# First define the tools
async def analyze_file_context(
    ctx: RunContext[SpecAnalysisContext],
    line_number: int | None = None,
) -> str:
    """Analyze the context around a location, including related header/source files"""
    file = ctx.deps.current_file
    related_files = ctx.deps.codebase.get_related_files(file.path)

    # Build context from current file
    if line_number is not None:
        lines = file.content.splitlines()
        start = max(0, line_number - 10)
        end = min(len(lines), line_number + 10)
        current_context = "\n".join(lines[start:end])
    else:
        current_context = file.content

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

    return f"// Current file {file.path}:\n{current_context}{related_context}"


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
) -> dict[str, str | bool]:
    """Verify the generated specifications"""
    # Use the centralized verification function from tools.verification
    result = await run_refinedc(
        ctx,
        working_dir=ctx.deps.codebase.project,
        file_path=ctx.deps.c_file,
    )
    if config.meta.logging:
        logfire.info(
            "Verification result",
            returncode=result.returncode,
            output_preview=result.output[:200],
        )
    return {
        "success": result.returncode == 0,
        "output": result.output,
        "returncode": result.returncode,
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
    insert_annotations(file, result.data)


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

    # Verify the specs before returning
    verification = await verify_specs(RunContext(deps=context), result.data.annotations)

    if not verification["success"]:
        if config.meta.logging:
            logfire.error(
                "Generated specs failed verification",
                error=verification["output"][:200],
            )
        raise ValueError(
            f"Generated specifications failed verification: {verification['output'][:200]}"
        )

    return result.data
