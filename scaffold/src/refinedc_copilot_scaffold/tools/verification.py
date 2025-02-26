from __future__ import annotations

from pathlib import Path
import subprocess
from dataclasses import dataclass
import logfire
from pydantic_ai import Tool, RunContext
from refinedc_copilot_scaffold.config import load_config

config = load_config()


@dataclass
class CommandResult:
    """Result of running a command"""

    returncode: int
    stdout: str | None
    stderr: str | None

    @property
    def output(self) -> str:
        """Combined output string"""
        parts = []
        if self.stdout:
            parts.append(self.stdout)
        if self.stderr:
            parts.append(self.stderr)
        return "\n".join(parts)


async def run_refinedc(
    ctx: RunContext,
    working_dir: Path,
    file_path: Path,
) -> CommandResult:
    """Run RefinedC verification on a file

    Args:
        ctx: Run context with dependencies
        working_dir: Directory to run command in
        file_path: Path to the file to verify
    """
    if config.meta.logging:
        logfire.info(
            "Running RefinedC verification",
            working_dir=str(working_dir),
            file_path=str(file_path),
            file_exists=Path(file_path).exists(),
            file_size=Path(file_path).stat().st_size if Path(file_path).exists() else 0,
        )

    cmd = [config.tools.refinedc, "check", str(file_path)]
    result = subprocess.run(
        cmd,
        cwd=str(working_dir),
        capture_output=True,
        text=True,
    )

    return CommandResult(
        returncode=result.returncode,
        stdout=result.stdout if result.stdout else None,
        stderr=result.stderr if result.stderr else None,
    )


async def run_coqc(
    ctx: RunContext, lemma_file: str, working_dir: Path
) -> CommandResult:
    """Compile and check a Coq lemma file."""
    result = subprocess.run(
        [config.tools.coqc, lemma_file],
        cwd=str(working_dir),
        capture_output=True,
        text=True,
    )
    return CommandResult(
        returncode=result.returncode,
        stdout=result.stdout if result.stdout else None,
        stderr=result.stderr if result.stderr else None,
    )


# Common tools that both agents will use
verification_tools = [
    Tool(run_refinedc),
    Tool(run_coqc),
]
