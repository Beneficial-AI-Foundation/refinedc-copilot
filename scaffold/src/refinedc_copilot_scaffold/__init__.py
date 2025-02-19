import asyncio
from pathlib import Path
from typing import Sequence
import typer
from refinedc_copilot_scaffold.codebase.models import CodebaseContext
from refinedc_copilot_scaffold.agent.spec_assist import process_file

SOURCES_DIR = Path("sources")
ARTIFACTS_DIR = Path("artifacts")


async def annotate_codebase(project: str, target_functions: Sequence[str]) -> None:
    """Process an entire codebase to add RefinedC annotations

    Args:
        project: Name of the project directory (used for both sources/project and artifacts/project)
        target_functions: Functions to analyze and annotate
    """
    source_dir = SOURCES_DIR / project
    if not source_dir.exists():
        raise ValueError(f"Project directory '{project}' not found in sources/")

    # Ensure artifacts directory exists
    (ARTIFACTS_DIR / project).mkdir(parents=True, exist_ok=True)

    codebase = CodebaseContext.from_directory(
        project
    )  # This signature will need to change in models.py

    for file_path in codebase.files:
        for function in target_functions:
            await process_file(codebase, file_path, function)

    codebase.save_outputs()


app = typer.Typer()


@app.command()
def main(
    project: str = typer.Argument(
        ...,
        help="Name of the project directory (will read from sources/project and write to artifacts/project)",
    ),
    functions: list[str] = typer.Option(
        [],
        "--function",
        "-f",
        help="Target function names to verify (can be specified multiple times)",
    ),
) -> None:
    """RefinedC annotation tool - adds RefinedC annotations to C code

    The tool expects your C project to be in the sources/ directory.
    Annotated output will be written to the artifacts/ directory.
    Example: For a project in sources/fib/, outputs will be in artifacts/fib/
    """
    asyncio.run(annotate_codebase(project, functions))
