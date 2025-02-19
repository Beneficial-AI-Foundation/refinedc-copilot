from dataclasses import dataclass
from pathlib import Path
from pydantic import BaseModel, Field
from pydantic_ai import Agent, RunContext
from refinedc_copilot_scaffold.prompting import get_spec_assist_prompt
from refinedc_copilot_scaffold.codebase.models import CodebaseContext, SourceFile


@dataclass
class SpecAnalysisContext:
    """Context needed for specification analysis"""

    codebase: CodebaseContext
    current_file: SourceFile
    existing_specs: str | None = None


class SpecAssistResult(BaseModel):
    """Structured output for RefinedC specifications and annotations"""

    annotations: list[str] = Field(description="RefinedC annotations to insert")
    insertion_points: list[int] = Field(
        description="Line numbers where to insert annotations"
    )
    helper_lemmas: list[str] | None = Field(description="Helper lemmas if needed")
    explanation: str = Field(description="Explanation of the annotations and lemmas")


# Create the specification assistant agent
spec_assist_agent = Agent(
    "anthropic:claude-3-sonnet-20240229",
    deps_type=SpecAnalysisContext,
    result_type=SpecAssistResult,
    system_prompt=get_spec_assist_prompt(),
)


@spec_assist_agent.tool
async def analyze_function_context(
    ctx: RunContext[SpecAnalysisContext], function_name: str, line_number: int
) -> str:
    """Analyze the context around a function to help generate appropriate annotations"""
    file_content = ctx.deps.current_file.content
    lines = file_content.splitlines()

    # Get ~10 lines before and after for context
    start = max(0, line_number - 10)
    end = min(len(lines), line_number + 10)

    return "\n".join(lines[start:end])


@spec_assist_agent.tool
async def check_existing_specs(
    ctx: RunContext[SpecAnalysisContext],
) -> dict[str, str] | None:
    """Check any existing RefinedC specifications to avoid duplication and ensure consistency"""
    if ctx.deps.existing_specs:
        return {"existing": ctx.deps.existing_specs}
    return None


def insert_annotations(file: SourceFile, result: SpecAssistResult) -> None:
    """Insert annotations and lemmas into the source file"""
    lines = file.content.splitlines()

    # Insert annotations at specified points
    for point, annotation in zip(result.insertion_points, result.annotations):
        lines.insert(point, annotation)

    # Add helper lemmas at the top if present
    if result.helper_lemmas:
        lemma_text = "\n".join(result.helper_lemmas)
        lines.insert(0, lemma_text)

    file.content = "\n".join(lines)


async def process_file(
    codebase: CodebaseContext, file_path: Path, target_function: str | None = None
) -> None:
    """Process a single file to add RefinedC annotations"""
    file = codebase.files[file_path]
    context = SpecAnalysisContext(
        codebase=codebase,
        current_file=file,
        existing_specs=None,  # Could scan file for existing specs here
    )

    if target_function:
        # Find the function definition line
        lines = file.content.splitlines()
        for i, line in enumerate(lines):
            if target_function in line and "{" in line:
                result = await spec_assist_agent.run(
                    f"Please analyze this C code and generate appropriate RefinedC specifications "
                    f"for function: {target_function}",
                    deps=context,
                )
                insert_annotations(file, result.data)
                break


async def generate_specifications(
    codebase: CodebaseContext,
    file_path: Path,
    existing_specs: str | None = None,
    target_function: str | None = None,
) -> SpecAssistResult:
    """Main entry point to generate RefinedC specifications"""
    file = codebase.files[file_path]
    context = SpecAnalysisContext(
        codebase=codebase,
        current_file=file,
        existing_specs=existing_specs,
    )

    result = await spec_assist_agent.run(
        "Please analyze this C code and generate appropriate RefinedC specifications",
        deps=context,
    )

    return result.data
