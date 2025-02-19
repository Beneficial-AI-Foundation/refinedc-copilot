from dataclasses import dataclass
from pathlib import Path


@dataclass
class SourceFile:
    path: Path
    content: str
    original_content: str  # Keep original for diffing


@dataclass
class CodebaseContext:
    """Represents input and output codebases"""

    input_dir: Path
    output_dir: Path
    files: dict[Path, SourceFile]

    @classmethod
    def from_directory(cls, input_dir: Path, output_dir: Path) -> "CodebaseContext":
        """Initialize by reading all .c and .h files from input directory"""
        files = {}
        for path in input_dir.rglob("*.[ch]"):
            relative_path = path.relative_to(input_dir)
            content = path.read_text()
            files[relative_path] = SourceFile(
                path=relative_path, content=content, original_content=content
            )

        return cls(input_dir=input_dir, output_dir=output_dir, files=files)

    def save_outputs(self) -> None:
        """Save modified files to output directory"""
        for rel_path, source_file in self.files.items():
            if source_file.content != source_file.original_content:
                output_path = self.output_dir / rel_path
                output_path.parent.mkdir(parents=True, exist_ok=True)
                output_path.write_text(source_file.content)
