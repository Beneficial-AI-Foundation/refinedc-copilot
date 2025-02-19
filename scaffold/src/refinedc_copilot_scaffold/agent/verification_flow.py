from __future__ import annotations

from pathlib import Path
from typing import Optional, List

from pydantic import BaseModel
from pydantic_ai import Graph, RunContext

from refinedc_copilot_scaffold.agent.spec_assist import spec_agent
from refinedc_copilot_scaffold.agent.lemma_assist import lemma_agent
from refinedc_copilot_scaffold.tools.verification import (
    VerificationTools,
    run_coqc,
    run_refinedc,
)


class VerificationReport(BaseModel):
    """Final report of the verification attempt"""

    success: bool
    iterations: int
    final_annotations: str
    helper_lemmas: List[str]
    error_message: Optional[str]
    suggestions: Optional[str]


async def verification_flow(
    source_path: Path, working_dir: Path, max_iterations: int = 5
) -> VerificationReport:
    """Coordinate the verification flow between agents"""

    tools = VerificationTools(
        working_dir=working_dir,
        refinedc_path=Path("/path/to/refinedc"),
        coqc_path=Path("/path/to/coqc"),
    )

    graph = Graph()

    # Add both agents to the graph with their shared tools
    graph.add_agent("spec", spec_agent)
    graph.add_agent("lemma", lemma_agent)

    iterations = 0
    helper_lemmas = []
    current_annotations = None

    # Start with spec generation
    spec_result = await graph.run_agent(
        "spec",
        f"Generate RefinedC specifications for the code in {source_path}",
        deps=tools,
    )
    current_annotations = spec_result.data.annotations

    while iterations < max_iterations:
        # Try verification with current annotations
        refinedc_result = await run_refinedc(RunContext(deps=tools), source_path)

        if "failed" not in refinedc_result.lower():
            # Success!
            return VerificationReport(
                success=True,
                iterations=iterations,
                final_annotations=current_annotations,
                helper_lemmas=helper_lemmas,
                error_message=None,
                suggestions=None,
            )

        # Verification failed, try generating helper lemma
        lemma_result = await graph.run_agent(
            "lemma",
            f"Generate helper lemma for verification error:\n{refinedc_result}",
            deps=tools,
        )

        helper_lemmas.append(lemma_result.data.lemma)

        # Try to verify the lemma
        coq_result = await run_coqc(
            RunContext(deps=tools),
            f"lemma_{iterations}.v",  # You'd want better file naming
        )

        if "failed" in coq_result.lower():
            # Lemma failed, feed error back to lemma agent
            continue

        iterations += 1

    # If we get here, we've exceeded max iterations
    return VerificationReport(
        success=False,
        iterations=iterations,
        final_annotations=current_annotations,
        helper_lemmas=helper_lemmas,
        error_message="Max iterations exceeded",
        suggestions="""
        Consider:
        1. Reviewing and simplifying the code
        2. Adjusting the specifications
        3. Breaking the verification into smaller parts
        """,
    )
