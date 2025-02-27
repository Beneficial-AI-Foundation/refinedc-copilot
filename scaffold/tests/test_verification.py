import pytest
from pathlib import Path
from unittest.mock import patch, MagicMock
import tempfile
import shutil

from refinedc_copilot_scaffold.tools.verification import (
    run_refinedc,
)
from refinedc_copilot_scaffold.agent.orchestration import (
    _try_verification_with_specs,
    VerificationState,
)
from refinedc_copilot_scaffold.codebase.models import SourceFile, CodebaseContext
from refinedc_copilot_scaffold.agent.spec_assist import SpecAnalysisContext


@pytest.fixture
def temp_dir():
    """Create a temporary directory for testing."""
    temp_dir = tempfile.mkdtemp()
    yield Path(temp_dir)
    shutil.rmtree(temp_dir)


@pytest.fixture
def mock_codebase(temp_dir):
    """Create a mock codebase for testing."""
    # Create a simple C file
    c_file_path = temp_dir / "test.c"
    c_file_content = """
#include <stdio.h>

int add(int a, int b) {
    return a + b;
}

int main() {
    int result = add(1, 2);
    return 0;
}
"""
    c_file_path.write_text(c_file_content)

    # Create a CodebaseContext with the file
    file = SourceFile(path=c_file_path, content=c_file_content)
    codebase = CodebaseContext(
        project=temp_dir,
        files={c_file_path: file},
    )

    return codebase


@pytest.fixture
def analysis_context(mock_codebase):
    """Create a mock analysis context for testing."""
    file_path = next(iter(mock_codebase.files.keys()))
    file = mock_codebase.files[file_path]

    return SpecAnalysisContext(
        codebase=mock_codebase,
        current_file=file,
        existing_specs=None,
    )


@patch("refinedc_copilot_scaffold.tools.verification.subprocess.run")
def test_run_refinedc(mock_run, temp_dir, analysis_context):
    """Test running RefinedC verification."""
    # Setup
    mock_result = MagicMock()
    mock_result.returncode = 0
    mock_result.stdout = "Verification successful"
    mock_result.stderr = None
    mock_run.return_value = mock_result

    # Execute
    ctx = MagicMock()
    ctx.deps = analysis_context
    result = run_refinedc(ctx, temp_dir, analysis_context.current_file.path)

    # Verify
    assert result.returncode == 0
    assert result.stdout == "Verification successful"
    assert result.stderr is None
    mock_run.assert_called_once()


@patch("refinedc_copilot_scaffold.agent.orchestration.run_refinedc")
@patch("refinedc_copilot_scaffold.agent.orchestration.write_file_with_specs")
def test_try_verification_with_specs_success(
    mock_write, mock_run, temp_dir, analysis_context
):
    """Test verification with specs that succeeds."""
    # Setup
    mock_result = MagicMock()
    mock_result.returncode = 0
    mock_result.output = "Verification successful"
    mock_run.return_value = mock_result

    state = VerificationState(
        current_annotations=["[[rc::function(add)]]"],
        helper_lemmas=[],
        last_error=None,
        iterations_used=0,
    )

    # Execute
    result = _try_verification_with_specs(
        source_path=analysis_context.current_file.path,
        working_dir=temp_dir,
        analysis_context=analysis_context,
        current_annotations=["[[rc::function(add)]]"],
        state=state,
    )

    # Verify
    assert result.success is True
    assert result.iterations == 1
    assert "[[rc::function(add)]]" in result.source_with_specs_final
    mock_write.assert_called()
    mock_run.assert_called_once()
