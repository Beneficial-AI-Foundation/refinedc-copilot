import pytest
from pathlib import Path
import tempfile
import shutil

from refinedc_copilot_scaffold.tools.io import (
    write_file,
    get_artifact_path,
    insert_annotations,
    check_file_system_access,
)
from refinedc_copilot_scaffold.codebase.models import SourceFile
from refinedc_copilot_scaffold.agent.models import SpecAssistResult, InsertionPoint


@pytest.fixture
def temp_dir():
    """Create a temporary directory for testing."""
    temp_dir = tempfile.mkdtemp()
    yield Path(temp_dir)
    shutil.rmtree(temp_dir)


def test_write_file_with_specs(temp_dir):
    """Test writing a file with specifications."""
    # Setup
    file_path = temp_dir / "test.c"
    content = "#include <stdio.h>\n\nint main() {\n    return 0;\n}\n"

    # Execute
    write_file(file_path, content)

    # Verify
    assert file_path.exists()
    assert file_path.read_text() == content


def test_get_artifact_path(temp_dir):
    """Test getting the artifact path."""
    # Setup
    source_path = Path("/home/user/project/src/test.c")
    working_dir = temp_dir / "artifacts" / "project"
    working_dir.mkdir(parents=True)

    # Execute
    result = get_artifact_path(source_path, working_dir)

    # Verify
    assert result == working_dir / "src" / "test.c"
    assert result.parent.exists()


def test_check_file_system_access(temp_dir):
    """Test checking file system access."""
    # Execute
    result = check_file_system_access(temp_dir)

    # Verify
    assert result is True


def test_insert_annotations_basic():
    """Test inserting annotations into a source file."""
    # Setup
    content = """
#include <stdio.h>

int add(int a, int b) {
    return a + b;
}

int main() {
    int result = add(1, 2);
    return 0;
}
"""
    file = SourceFile(path=Path("test.c"), content=content)

    result = SpecAssistResult(
        annotations=[
            "[[rc::function(add)]]",
            "[[rc::parameters(a, b)]]",
            "[[rc::requires(true)]]",
            "[[rc::ensures(ret == a + b)]]",
        ]
    )

    # Execute
    insert_annotations(file, result)

    # Verify
    assert "[[rc::function(add)]]" in file.content
    assert "[[rc::parameters(a, b)]]" in file.content
    assert "[[rc::requires(true)]]" in file.content
    assert "[[rc::ensures(ret == a + b)]]" in file.content

    # Check that annotations are inserted before the function
    lines = file.content.splitlines()
    add_line_idx = next(i for i, line in enumerate(lines) if "int add(" in line)
    assert "[[rc::function(add)]]" in lines[add_line_idx - 4]
    assert "[[rc::parameters(a, b)]]" in lines[add_line_idx - 3]
    assert "[[rc::requires(true)]]" in lines[add_line_idx - 2]
    assert "[[rc::ensures(ret == a + b)]]" in lines[add_line_idx - 1]


def test_insert_annotations_with_insertion_points():
    """Test inserting annotations with explicit insertion points."""
    # Setup
    content = """
#include <stdio.h>

int add(int a, int b) {
    return a + b;
}

int main() {
    int result = add(1, 2);
    return 0;
}
"""
    file = SourceFile(path=Path("test.c"), content=content, is_header=False)

    result = SpecAssistResult(
        annotations=[
            "[[rc::function(add)]]",
            "[[rc::parameters(a, b)]]",
        ],
        insertion_points=[InsertionPoint(location="add", position="before")],
    )

    # Execute
    insert_annotations(file, result)

    # Verify
    assert "[[rc::function(add)]]" in file.content
    assert "[[rc::parameters(a, b)]]" in file.content

    # Check that annotations are inserted before the function
    lines = file.content.splitlines()
    add_line_idx = next(i for i, line in enumerate(lines) if "int add(" in line)
    assert "[[rc::function(add)]]" in lines[add_line_idx - 2]
    assert "[[rc::parameters(a, b)]]" in lines[add_line_idx - 1]
