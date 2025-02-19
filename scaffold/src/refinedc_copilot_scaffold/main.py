from pathlib import Path
from refinedc_copilot_scaffold.agent.verification_flow import (
    verification_flow,
    VerificationReport,
)


async def verify_code(source_path: Path, working_dir: Path) -> VerificationReport:
    """Run the verification flow on a source file.

    Args:
        source_path: Path to the C source file to verify
        working_dir: Working directory for verification tools

    Returns:
        A VerificationReport containing the results and any suggestions
    """
    report = await verification_flow(source_path, working_dir)

    # Print report for user feedback
    print("Verification Results:")
    print(f"Success: {report.success}")
    print(f"Iterations: {report.iterations}")

    print("\nAnnotations:")
    print(report.final_annotations)

    if report.helper_lemmas:
        print("\nHelper Lemmas:")
        for lemma in report.helper_lemmas:
            print(lemma)
            print("---")

    if report.error_message:
        print("\nError:")
        print(report.error_message)

        if report.suggestions:
            print("\nSuggestions:")
            print(report.suggestions)

    return report
