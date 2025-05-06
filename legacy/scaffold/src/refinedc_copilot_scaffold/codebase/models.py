from dataclasses import dataclass
from pathlib import Path
from typing import Iterator
from refinedc_copilot_scaffold.config import load_config, Config
import subprocess


@dataclass
class SourceFile:
    path: Path  # Relative path from project root
    content: str | list[str]  # Can be either original content or list of annotations
    original_content: str  # Keep original for diffing
    annotation_locations: dict[str, int] | None = (
        None  # Maps annotations to line numbers
    )

    @property
    def is_header(self) -> bool:
        return self.path.suffix == ".h"

    @property
    def is_source(self) -> bool:
        return self.path.suffix == ".c"

    def merge_annotations(self) -> str:
        """Merge annotations with original code at correct locations"""
        if not isinstance(self.content, list):
            return self.content

        # Split original content into lines
        lines = self.original_content.splitlines()

        # Find the function definition line (first non-empty, non-comment line)
        func_line = 0
        for i, line in enumerate(lines):
            stripped = line.strip()
            if (
                stripped
                and not stripped.startswith("//")
                and not stripped.startswith("/*")
            ):
                func_line = i
                break

        # Insert all annotations right before the function
        for annotation in reversed(self.content):
            lines.insert(func_line, annotation)

        return "\n".join(lines)


@dataclass
class CodebaseContext:
    """Represents the codebase being analyzed and modified"""

    project: Path  # Path in the original sources directory
    files: dict[Path, SourceFile]

    @classmethod
    def from_project(
        cls, project_name: str, config: Config | None = None
    ) -> "CodebaseContext":
        """Initialize by reading all .c and .h files from project directory using config"""
        if config is None:
            config = load_config()

        source_dir, artifacts_dir = config.get_project_dirs(project_name)

        # Verify the project directory exists
        if not source_dir.exists():
            raise ValueError(f"Project directory not found: {source_dir}")

        files = {}
        for source_file in cls._find_c_files(source_dir):
            relative_path = source_file.relative_to(source_dir)
            content = source_file.read_text()
            files[relative_path] = SourceFile(
                path=relative_path, content=content, original_content=content
            )

        context = cls(project=source_dir, files=files)
        context.initialize_refinedc()
        return context

    @staticmethod
    def _find_c_files(root: Path) -> Iterator[Path]:
        """Recursively find all C source and header files, handling various project structures"""
        # Common source directory names
        SRC_DIRS = {"src", "source", "lib", "crypto", "core", "modules"}

        def is_ignored(path: Path) -> bool:
            """Check if path should be ignored"""
            # Skip common test/build directories
            IGNORE_DIRS = {
                "test",
                "tests",
                "build",
                "dist",
                "doc",
                "docs",
                "example",
                "examples",
                ".git",
                ".svn",
                "node_modules",
            }
            parts = path.parts
            return any(
                part.startswith(".") or part.lower() in IGNORE_DIRS for part in parts
            )

        # First try to find source files in common source directories
        src_files = []
        for src_dir in SRC_DIRS:
            potential_src = root / src_dir
            if potential_src.is_dir():
                for path in potential_src.rglob("*.[ch]"):
                    if not is_ignored(path.relative_to(root)):
                        src_files.append(path)

        # If no files found in common directories, search entire project
        if not src_files:
            for path in root.rglob("*.[ch]"):
                if not is_ignored(path.relative_to(root)):
                    src_files.append(path)

        return iter(sorted(set(src_files)))  # Remove duplicates and sort

    def get_related_files(self, file_path: Path) -> list[SourceFile]:
        """Get related source/header files for a given file"""
        stem = file_path.stem
        return [
            f
            for f in self.files.values()
            if f.path.stem == stem and f.path != file_path
        ]

    def save_changes(self) -> None:
        """Save any changes back to the artifacts directory"""
        config = load_config()
        artifacts_dir = config.paths.artifacts_dir / self.project.name

        for rel_path, source_file in self.files.items():
            # Use absolute paths for both
            output_path = artifacts_dir.absolute() / rel_path
            output_path.parent.mkdir(parents=True, exist_ok=True)

            # Use merge_annotations to combine specs with code
            content = source_file.merge_annotations()
            output_path.write_text(content)

    def initialize_refinedc(self) -> None:
        """Initialize RefinedC project structure in artifacts directory if needed"""
        config = load_config()
        _, artifacts_dir = config.get_project_dirs(self.project.name)

        # Check if already initialized
        if (artifacts_dir / "_CoqProject").exists():
            return

        # Ensure artifacts directory exists
        artifacts_dir.mkdir(parents=True, exist_ok=True)

        # Copy source files to artifacts directory to prepare for refinedc init
        for rel_path, source_file in self.files.items():
            dest_path = artifacts_dir / rel_path
            dest_path.parent.mkdir(parents=True, exist_ok=True)
            dest_path.write_text(source_file.content)

        try:
            # Run refinedc init using verification tools
            subprocess.run(
                [config.tools.refinedc, "init"],
                cwd=artifacts_dir,
                capture_output=True,
                text=True,
                check=True,
            )

        except subprocess.CalledProcessError as e:
            raise RuntimeError(
                f"Failed to initialize RefinedC project: {e.stderr}"
            ) from e
