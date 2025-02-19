from pydantic import BaseModel, Field


class RefinedCAnnotation(BaseModel):
    """A RefinedC specification annotation for a C function or type"""

    annotation_text: str = Field(description="The complete RefinedC specification")
    location: str = Field(
        description="Where to insert the specification (before which function/type)"
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


class SpecAssistResult(BaseModel):
    """Result from analyzing C code for RefinedC specifications"""

    annotations: list[RefinedCAnnotation] = Field(
        description="RefinedC specifications to add"
    )
    explanation: str = Field(
        description="Overall explanation of the specification approach"
    )
    suggested_lemmas: list[str] = Field(
        description="High-level descriptions of lemmas that will be needed"
    )
