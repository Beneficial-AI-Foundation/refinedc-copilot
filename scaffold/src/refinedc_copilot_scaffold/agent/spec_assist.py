from dataclasses import dataclass
from pathlib import Path
from pydantic import BaseModel, Field
from pydantic_ai import Agent, RunContext
import logfire
from dotenv import load_dotenv
from refinedc_copilot_scaffold.config import load_config
from refinedc_copilot_scaffold.prompting import get_spec_assist_prompt
from refinedc_copilot_scaffold.codebase.models import CodebaseContext, SourceFile


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


class SpecAssistResult(BaseModel):
    """Structured output for RefinedC specifications and annotations"""

    annotations: list[str] = Field(description="RefinedC annotations to insert")
    insertion_points: list[int] = Field(
        description="Line numbers where to insert annotations"
    )
    helper_lemmas: list[str] | None = Field(description="Helper lemmas if needed")
    explanation: str = Field(description="Explanation of the annotations and lemmas")
    final_annotations: str = Field(description="Complete file content with annotations")


# Update the agent initialization to use the config
config = load_config()
spec_assist_agent = Agent(
    config.agents.spec_assist.model,
    deps_type=SpecAnalysisContext,
    result_type=SpecAssistResult,
    system_prompt=get_spec_assist_prompt(),
)


@spec_assist_agent.tool
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
    file = codebase.files.get(file_path)  # Use .get() to avoid KeyError
    if file is None:
        if config.meta.logging:
            logfire.error(f"File not found in codebase: {file_path}")
        return  # Early exit if file is not found

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
    # Remove the RefinedC initialization from here since it should only happen in artifacts

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
