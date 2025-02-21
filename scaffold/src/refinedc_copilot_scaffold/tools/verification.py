from __future__ import annotations

from pathlib import Path
import subprocess

from pydantic_ai import Tool, RunContext
from refinedc_copilot_scaffold.config import load_config

config = load_config()


async def run_refinedc(
    context: RunContext,
    source_path: Path,
    working_dir: Path,
    check_only: bool = False,
) -> str:
    """Run RefinedC on a source file"""
    cmd = [config.tools.refinedc, "check" if check_only else "verify", str(source_path)]
    result = subprocess.run(
        cmd,
        cwd=str(working_dir),
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return f"RefinedC failed:\n{result.stdout}\n{result.stderr}"
    return result.stdout


async def run_coqc(ctx: RunContext, lemma_file: str, working_dir: Path) -> str:
    """Compile and check a Coq lemma file."""
    result = subprocess.run(
        [str(config.tools.coqc), lemma_file],
        cwd=str(working_dir),
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return f"Coq compilation failed:\n{result.stdout}\n{result.stderr}"
    return result.stdout


# Common tools that both agents will use
verification_tools = [
    Tool(run_refinedc),
    Tool(run_coqc),
]
