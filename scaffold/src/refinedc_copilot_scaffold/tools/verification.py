from __future__ import annotations

from pathlib import Path
import subprocess
import logfire
from pydantic import BaseModel, Field
from pydantic_ai import Tool, RunContext
from refinedc_copilot_scaffold.config import load_config

config = load_config()


class CommandResult(BaseModel):
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


class InvalidAnnotation(BaseModel):
    """Information about an invalid annotation"""

    location: str
    reason: str


class ProofFailure(BaseModel):
    """Information about a proof failure"""

    function: str
    message: str


class RefinedCOutput(BaseModel):
    """Structured output from RefinedC verification"""

    returncode: int
    output: str
    success: bool = Field(description="True if verification succeeded")
    has_syntax_errors: bool = Field(
        description="True if there are syntax errors in annotations"
    )
    has_proof_failures: bool = Field(description="True if there are proof failures")
    invalid_annotations: list[InvalidAnnotation] = Field(default_factory=list)
    proof_failures: list[ProofFailure] = Field(default_factory=list)
    error_summary: str = Field(default="")


def parse_refinedc_output(output: str) -> dict:
    """Parse RefinedC output to categorize errors and extract useful information.

    Returns:
        A dictionary with error types and details
    """
    result = {
        "invalid_annotations": [],
        "proof_failures": [],
        "has_syntax_errors": False,
        "has_proof_failures": False,
        "error_summary": "",
    }

    lines = output.splitlines()

    # Look for invalid annotation errors
    for i, line in enumerate(lines):
        # Check for frontend errors
        if "Frontend error" in line:
            location = line.split("]")[0].strip("[") if "]" in line else "unknown"
            reason = ""
            # Collect the next few lines for the error message
            for j in range(1, min(4, len(lines) - i)):
                reason += lines[i + j].strip() + " "

            result["invalid_annotations"].append(
                {"location": location, "reason": reason.strip()}
            )
            result["has_syntax_errors"] = True

        elif "Invalid annotation" in line:
            # Extract the location and reason
            location = line.split("]")[0].strip("[") if "]" in line else "unknown"
            reason = lines[i + 1].strip() if i + 1 < len(lines) else "Unknown reason"

            result["invalid_annotations"].append(
                {"location": location, "reason": reason}
            )
            result["has_syntax_errors"] = True

        elif "Annotations on function" in line and "invalid" in line:
            function = (
                line.split("[")[1].split("]")[0]
                if "[" in line and "]" in line
                else "unknown"
            )
            result["invalid_annotations"].append(
                {
                    "location": f"function {function}",
                    "reason": "Invalid annotations on function",
                }
            )
            result["has_syntax_errors"] = True

        # Look for proof failures (valid annotations that couldn't be verified)
        elif "Failed to verify" in line or "Verification failed" in line:
            result["has_proof_failures"] = True
            if "function" in line:
                function = (
                    line.split("function")[1].strip()
                    if "function" in line
                    else "unknown"
                )
                result["proof_failures"].append({"function": function, "message": line})

        # Check for unexpected token errors which are also syntax errors
        elif "unexpected token" in line:
            location = "unknown"
            # Try to find the location from previous line
            if i > 0 and "]" in lines[i - 1]:
                location = lines[i - 1].split("]")[0].strip("[")

            result["invalid_annotations"].append(
                {"location": location, "reason": line.strip()}
            )
            result["has_syntax_errors"] = True

    # Create a summary of the errors
    if result["has_syntax_errors"]:
        result["error_summary"] = (
            f"Found {len(result['invalid_annotations'])} invalid annotations. Fix syntax errors first."
        )
    elif result["has_proof_failures"]:
        result["error_summary"] = (
            f"Found {len(result['proof_failures'])} proof failures. Annotations are syntactically valid but couldn't be verified."
        )

    return result


async def run_refinedc(
    file_path: Path,
    working_dir: Path | None = None,
) -> RefinedCOutput:
    """Run RefinedC verification on a file and return the results.

    Args:
        file_path: Path to the C file to verify
        working_dir: Working directory for the verification process. If None, defaults to file_path.parent.parent

    Returns:
        A RefinedCOutput object with verification results including parsed error information
    """
    # Set default working directory if not provided
    if working_dir is None:
        working_dir = file_path.parent.parent

    if config.meta.logging:
        logfire.info(
            "Running RefinedC verification",
            working_dir=str(working_dir),
            file_path=str(file_path),
            file_exists=Path(file_path).exists(),
            file_size=Path(file_path).stat().st_size if Path(file_path).exists() else 0,
        )

    # Check if file exists and log its content for debugging
    if Path(file_path).exists():
        try:
            with open(file_path, "r") as f:
                content = f.read()
            logfire.debug(
                "File content before verification",
                file_path=str(file_path),
                content_preview=content[:200] if content else "Empty content",
                content_size=len(content),
            )
        except Exception as e:
            logfire.error(
                "Error reading file before verification",
                file_path=str(file_path),
                error=str(e),
            )
    cmd = [config.tools.refinedc, "check", str(file_path)]
    result = subprocess.run(
        cmd,
        # cwd=str(working_dir),
        capture_output=True,
        text=True,
    )

    # Combine stdout and stderr to create the output
    output = ""
    if result.stdout:
        output += result.stdout
    if result.stderr:
        output += "\n" + result.stderr if output else result.stderr

    parsed_results = parse_refinedc_output(output)

    # Convert the parsed dictionaries to model instances
    invalid_annotations = [
        InvalidAnnotation(**item) for item in parsed_results["invalid_annotations"]
    ]
    proof_failures = [ProofFailure(**item) for item in parsed_results["proof_failures"]]

    return RefinedCOutput(
        returncode=result.returncode,
        output=output,
        success=result.returncode == 0,
        has_syntax_errors=parsed_results["has_syntax_errors"],
        has_proof_failures=parsed_results["has_proof_failures"],
        invalid_annotations=invalid_annotations,
        proof_failures=proof_failures,
        error_summary=parsed_results["error_summary"],
    )


async def run_coqc(
    ctx: RunContext, lemma_file: str, working_dir: Path
) -> CommandResult:
    """Compile and check a Coq lemma file."""
    result = subprocess.run(
        [config.tools.coqc, lemma_file],
        # cwd=str(working_dir),
        capture_output=True,
        text=True,
    )
    subprocess.run(["rm", f"{lemma_file.stem}.glob"])
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
