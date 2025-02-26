from pydantic import BaseModel, Field


class RefinedCAnnotation(BaseModel):
    """A RefinedC specification annotation for a C function or type"""

    annotation_text: str = Field(description="The complete RefinedC specification")
    location: str = Field(
        description="Where to insert the specification (before which function/type/command)"
    )
    explanation: str = Field(
        description="Explanation of what this specification ensures"
    )
    verification_goals: list[str] = Field(
        description="List of properties this specification helps verify"
    )


class HelperLemma(BaseModel):
    """A helper lemma needed to prove correctness"""

    lemma_text: str = Field(description="The complete helper lemma definition")
    purpose: str = Field(description="What this lemma helps prove")
    proof_sketch: str = Field(
        description="High-level sketch of how to prove this lemma"
    )


class InsertionPoint(BaseModel):
    """Specifies where to insert a RefinedC specification in the source code"""

    location: str = Field(
        description="The function/type name or line number where the specification should be inserted"
    )
    position: str = Field(
        description="Whether the specification should go 'before' or 'after' the location",
        pattern="^(before|after)$",
    )
    context: str | None = Field(
        description="Additional context about the insertion point (e.g., surrounding code)",
        default=None,
    )


class SpecAssistResult(BaseModel):
    """Result from the specification assistant"""

    annotations: list[str] = Field(default_factory=list)
    insertion_points: list[InsertionPoint] = Field(default_factory=list)
    helper_lemmas: list[str] = Field(default_factory=list)
    explanation: str = ""
    source_file_with_specs_final: str = ""

    # Additional fields from the original RefinedCAnnotation model
    verification_goals: list[str] | None = Field(
        description="List of properties these specifications help verify", default=None
    )
