from dataclasses import dataclass
from clang import cindex
import logfire
import tempfile
import os


@dataclass
class AnnotationPoint:
    """Represents a location where annotations can be inserted"""

    line: int  # Line number for insertion
    context: str  # Type of context (function, loop, block, etc)
    name: str | None = None  # Name of function/variable if applicable
    indent: int = 0  # Indentation level for proper formatting


class CSourceParser:
    """Parser for C source files using libclang"""

    def __init__(self):
        self.index = cindex.Index.create()

    def parse_file(self, content: str) -> cindex.TranslationUnit:
        """Parse a file content using clang.

        Args:
            content: The file content as a string

        Returns:
            A clang TranslationUnit
        """
        # If content is a SourceFile object, extract its content
        if hasattr(content, "content") and isinstance(content.content, str):
            content = content.content

        # Ensure content is a string
        if not isinstance(content, str):
            raise TypeError(f"Expected string content, got {type(content)}")

        # Create a temporary file for clang to parse
        with tempfile.NamedTemporaryFile(suffix=".c", delete=False) as temp:
            temp_path = temp.name
            temp.write(content.encode("utf-8"))

        try:
            # Parse the temporary file
            index = cindex.Index.create()
            tu = index.parse(temp_path, args=["-x", "c"])
            return tu
        finally:
            # Clean up the temporary file
            os.unlink(temp_path)

    def get_line_content(
        self, tu: cindex.TranslationUnit, file: cindex.File, line: int
    ) -> str:
        """Get content of a specific line using source locations and tokens"""
        start = cindex.SourceLocation.from_position(tu, file, line, 0)
        end = cindex.SourceLocation.from_position(tu, file, line, 1000)
        extent = cindex.SourceRange.from_locations(start, end)
        tokens = list(tu.get_tokens(extent=extent))
        return "".join(token.spelling for token in tokens)

    def get_indent(self, tu: cindex.TranslationUnit, node: cindex.Cursor) -> int:
        """Calculate indentation level from source"""
        if node.extent and node.extent.start:
            line = self.get_line_content(tu, node.location.file, node.extent.start.line)
            return len(line) - len(line.lstrip())
        return 0

    def find_insertion_point(
        self, tu: cindex.TranslationUnit, node: cindex.Cursor
    ) -> int:
        """Find the correct line number for inserting annotations"""
        line = node.location.line
        current_line = line

        while current_line > 1:
            content = self.get_line_content(
                tu, node.location.file, current_line - 1
            ).strip()
            if not (content.startswith("#include") or content.startswith("//")):
                break
            current_line -= 1

        return current_line

    def find_annotation_points(
        self, tu: cindex.TranslationUnit
    ) -> list[AnnotationPoint]:
        """Find all potential annotation insertion points"""
        points = []

        def visit_node(node: cindex.Cursor):
            if node.kind == cindex.CursorKind.FUNCTION_DECL and node.is_definition():
                # Function definitions - insert at proper position after includes
                insert_line = self.find_insertion_point(tu, node)
                points.append(
                    AnnotationPoint(
                        line=insert_line,
                        context="function",
                        name=node.spelling,
                        indent=self.get_indent(tu, node),
                    )
                )

            elif (
                node.kind == cindex.CursorKind.FOR_STMT
                or node.kind == cindex.CursorKind.WHILE_STMT
            ):
                # Loop statements
                points.append(
                    AnnotationPoint(
                        line=node.location.line,
                        context="loop",
                        indent=self.get_indent(tu, node),
                    )
                )

            elif node.kind == cindex.CursorKind.COMPOUND_STMT:
                # Block scopes (for assertions)
                points.append(
                    AnnotationPoint(
                        line=node.location.line,
                        context="block",
                        indent=self.get_indent(tu, node),
                    )
                )

            # Recursively visit children
            for child in node.get_children():
                visit_node(child)

        visit_node(tu.cursor)
        return points

    def check_diagnostics(self, tu: cindex.TranslationUnit) -> bool:
        """Check for parsing errors, returns True if parsing was successful"""
        has_errors = False
        for diag in tu.diagnostics:
            if diag.severity >= cindex.Diagnostic.Error:
                has_errors = True
                logfire.error(
                    "C parsing error",
                    severity=diag.severity,
                    message=diag.spelling,
                    location=f"{diag.location.file}:{diag.location.line}",
                )
        return not has_errors
