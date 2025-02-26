from dataclasses import dataclass
from pathlib import Path
from pydantic import BaseModel, Field
from pydantic_ai import Agent, RunContext

from refinedc_copilot_scaffold.config import load_config
from refinedc_copilot_scaffold.codebase.models import CodebaseContext, SourceFile
from refinedc_copilot_scaffold.prompting import get_lemma_assist_prompt
from refinedc_copilot_scaffold.tools.verification import run_refinedc, run_coqc


config = load_config()


@dataclass
class LemmaContext:
    """Context needed for lemma generation"""

    codebase: CodebaseContext
    c_file: SourceFile
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
    config.agents.lemma_assist.model,
    deps_type=LemmaContext,
    result_type=LemmaGenerationResult,
    system_prompt=get_lemma_assist_prompt(),
)


@lemma_assist_agent.tool
async def analyze_spec_context(
    ctx: RunContext[LemmaContext],
) -> dict[str, str]:
    """Analyze the RefinedC specifications to identify needed lemmas"""
    return {
        "c_code": ctx.deps.c_file.content,
        "existing_lemmas": ctx.deps.existing_lemmas or "",
    }


@lemma_assist_agent.tool
async def verify_lemma(
    ctx: RunContext,
    lemma_file: str,
    working_dir: Path,
) -> dict[str, str | bool]:
    """Verify a generated lemma"""
    result = await run_coqc(ctx, lemma_file, working_dir)
    return {
        "success": result.returncode == 0,
        "output": result.output,
    }


@lemma_assist_agent.tool
async def check_with_lemma(
    ctx: RunContext,
    source_file: Path,
    working_dir: Path,
) -> dict[str, str | bool]:
    """Check if the lemma helps with verification"""
    result = await run_refinedc(ctx, source_file, working_dir, check_only=True)
    return {
        "success": result.returncode == 0,
        "output": result.output,
    }


def generate_coq_file(result: LemmaGenerationResult, output_path: Path) -> None:
    """Generate a Coq file containing the helper lemmas

    The file will be created in the RefinedC proof directory structure:
    src/proofs/example/lemmas.v for a source file src/example.c
    """
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

    # Ensure the output directory exists
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("\n".join(content))


async def generate_helper_lemmas(
    codebase: CodebaseContext,
    c_file_path: Path,
    existing_lemmas_path: Path | None = None,
    output_path: Path | None = None,
) -> LemmaGenerationResult:
    """Main entry point to generate Coq helper lemmas

    If output_path is not specified, it will automatically use:
    artifacts/project/src/proofs/example/lemmas.v for a source file src/example.c
    """
    c_file = codebase.files[c_file_path]

    # If no output path specified, construct the default RefinedC path
    if output_path is None:
        output_path = (
            config.paths.artifacts_dir
            / c_file_path.parent
            / "proofs"
            / c_file_path.stem
            / "lemmas.v"
        )

    existing_lemmas = None
    if existing_lemmas_path and existing_lemmas_path in codebase.files:
        existing_lemmas = codebase.files[existing_lemmas_path].content

    context = LemmaContext(
        codebase=codebase,
        c_file=c_file,
        existing_lemmas=existing_lemmas,
    )

    result = await lemma_assist_agent.run(
        "Please analyze this code and specifications to generate appropriate Coq helper lemmas",
        deps=context,
    )

    if output_path:
        generate_coq_file(result.data, output_path)

    return result.data
