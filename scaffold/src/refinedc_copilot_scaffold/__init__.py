import asyncio
import typer
from refinedc_copilot_scaffold.logging import setup_logging
from refinedc_copilot_scaffold.config import load_config
from refinedc_copilot_scaffold.codebase.models import CodebaseContext
from refinedc_copilot_scaffold.agent.multi import verification_flow

config = load_config()
if config.meta.logging:
    setup_logging()


async def process_codebase(project: str) -> None:
    """Process an entire codebase through the full verification flow

    Args:
        project: Name of the project directory (used for both sources/project and artifacts/project)
    """
    codebase = CodebaseContext.from_project(project)
    _, artifacts_project_dir = config.get_project_dirs(project)

    # Create artifacts project directory and initialize RefinedC there
    artifacts_project_dir.mkdir(parents=True, exist_ok=True)

    # Initialize RefinedC in the artifacts directory
    # codebase.initialize_refinedc(artifacts_project_dir)

    try:
        source_files = [
            file_path
            for file_path, source_file in codebase.files.items()
            if source_file.is_source
        ]
        tasks = []
        for file_path in source_files:
            # Create working directory at the file level
            (artifacts_project_dir / file_path.parent).mkdir(
                parents=True, exist_ok=True
            )

            # Run verification flow for each source file
            tasks.append(
                verification_flow(
                    source_path=artifacts_project_dir / file_path,
                    project_dir=project,
                    codebase=codebase,
                )
            )

        results = await asyncio.gather(*tasks, return_exceptions=True)

        # Process results
        for file_path, result in zip(source_files, results):
            if isinstance(result, Exception):
                print(f"Error processing {file_path}: {result}")
            else:
                print(f"Results for {file_path}:")
                print(f"  Success: {result.success}")
                print(f"  Iterations: {result.iterations}")
                if not result.success:
                    print(f"  Error: {result.error_message}")
                    if result.suggestions:
                        print(f"  Suggestions: {result.suggestions}")

                # Update codebase with final annotations
                if result.final_annotations:
                    codebase.files[file_path].content = result.final_annotations

        try:
            codebase.save_changes()
        except Exception as exc:
            print(f"Error saving changes to codebase: {exc}")
            raise exc

    except Exception as exc:
        print(f"Error processing codebase: {exc}")
        raise exc


app = typer.Typer()


@app.command()
def main(project: str) -> None:
    """RefinedC verification tool - processes C code with RefinedC

    The tool expects your C project to be in the sources/ directory.
    Annotated and verified output will be written to the artifacts/ directory.
    Example: For a project in sources/fib/, outputs will be in artifacts/fib/

    The tool will:
    1. Generate RefinedC specifications
    2. Attempt verification
    3. Generate helper lemmas if needed
    4. Save the verified code and lemmas
    """
    asyncio.run(process_codebase(project))
