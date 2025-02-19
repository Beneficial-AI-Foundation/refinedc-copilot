from dataclasses import dataclass
from pathlib import Path
from pydantic import BaseModel, Field
from pydantic_ai import Agent, RunContext

from refinedc_copilot_scaffold.codebase.models import CodebaseContext, SourceFile
from refinedc_copilot_scaffold.prompting import get_lemma_assist_prompt


@dataclass
class LemmaContext:
    """Context needed for lemma generation"""

    codebase: CodebaseContext
    c_file: SourceFile
    spec_file: SourceFile | None = None  # For when specs are in separate files
    existing_lemmas: str | None = None


class CoqLemma(BaseModel):
    """Represents a single Coq lemma with its proof"""

    name: str = Field(description="Name of the lemma")
    statement: str = Field(description="The lemma statement")
    proof: str = Field(description="The Coq proof script")
    dependencies: list[str] = Field(
        description="Other lemmas or theorems this lemma depends on",
        default_factory=list,
    )


class LemmaGenerationResult(BaseModel):
    """Structured output for Coq helper lemmas"""

    lemmas: list[CoqLemma] = Field(description="Generated helper lemmas")
    imports: list[str] = Field(
        description="Required Coq imports/requires", default_factory=list
    )
    explanation: str = Field(description="Explanation of the lemmas and their purpose")


lemma_assist_agent = Agent(
    "anthropic:claude-3-sonnet-20240229",
    deps_type=LemmaContext,
    result_type=LemmaGenerationResult,
    system_prompt=get_lemma_assist_prompt(),
)


@lemma_assist_agent.tool
async def analyze_spec_context(
    ctx: RunContext[LemmaContext], function_name: str
) -> dict[str, str]:
    """Analyze the RefinedC specifications to identify needed lemmas"""
    c_content = ctx.deps.c_file.content
    spec_content = ctx.deps.spec_file.content if ctx.deps.spec_file else ""

    return {
        "c_code": c_content,
        "specs": spec_content,
        "existing_lemmas": ctx.deps.existing_lemmas or "",
    }


def generate_coq_file(result: LemmaGenerationResult, output_path: Path) -> None:
    """Generate a Coq file containing the helper lemmas"""
    content = []

    # Add imports
    for imp in result.imports:
        content.append(f"Require Import {imp}.")
    content.append("")

    # Add lemmas with their proofs
    for lemma in result.lemmas:
        content.append(f"Lemma {lemma.name}:")
        content.append(f"  {lemma.statement}.")
        content.append("Proof.")
        content.extend(f"  {line}" for line in lemma.proof.splitlines())
        content.append("Qed.")
        content.append("")

    output_path.write_text("\n".join(content))


async def generate_helper_lemmas(
    codebase: CodebaseContext,
    c_file_path: Path,
    spec_file_path: Path | None = None,
    existing_lemmas_path: Path | None = None,
    output_path: Path | None = None,
) -> LemmaGenerationResult:
    """Main entry point to generate Coq helper lemmas"""
    c_file = codebase.files[c_file_path]
    spec_file = codebase.files.get(spec_file_path) if spec_file_path else None

    existing_lemmas = None
    if existing_lemmas_path and existing_lemmas_path in codebase.files:
        existing_lemmas = codebase.files[existing_lemmas_path].content

    context = LemmaContext(
        codebase=codebase,
        c_file=c_file,
        spec_file=spec_file,
        existing_lemmas=existing_lemmas,
    )

    result = await lemma_assist_agent.run(
        "Please analyze this code and specifications to generate appropriate Coq helper lemmas",
        deps=context,
    )

    if output_path:
        generate_coq_file(result.data, output_path)

    return result.data
