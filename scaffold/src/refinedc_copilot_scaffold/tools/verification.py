from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import subprocess

from pydantic_ai import Tool, RunContext


@dataclass
class VerificationTools:
    """Common tools needed for verification"""

    working_dir: Path
    refinedc_path: Path
    coqc_path: Path


async def run_refinedc(ctx: RunContext[VerificationTools], source_file: str) -> str:
    """Run RefinedC on the given source file and return the output."""
    try:
        result = subprocess.run(
            [str(ctx.deps.refinedc_path), "check", source_file],
            cwd=str(ctx.deps.working_dir),
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout
    except subprocess.CalledProcessError as e:
        return f"RefinedC failed:\n{e.stdout}\n{e.stderr}"


async def run_coqc(ctx: RunContext[VerificationTools], lemma_file: str) -> str:
    """Compile and check a Coq lemma file."""
    try:
        result = subprocess.run(
            [str(ctx.deps.coqc_path), lemma_file],
            cwd=str(ctx.deps.working_dir),
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout
    except subprocess.CalledProcessError as e:
        return f"Coq compilation failed:\n{e.stdout}\n{e.stderr}"


# Common tools that both agents will use
verification_tools = [
    Tool(run_refinedc),
    Tool(run_coqc),
]
