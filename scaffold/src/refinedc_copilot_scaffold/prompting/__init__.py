from pathlib import Path
from urllib.request import urlopen
from typing import Any
from jinja2 import Environment, FileSystemLoader

ANNOTATIONS_MD_URL = (
    "https://gitlab.mpi-sws.org/iris/refinedc/-/raw/master/ANNOTATIONS.md"
)
# Set up Jinja environment
templates_dir = Path(__file__).parent
env = Environment(loader=FileSystemLoader(templates_dir))


def fetch_remote_content(url: str) -> str:
    """Fetch content from a remote URL"""
    try:
        with urlopen(url) as response:
            return response.read().decode("utf-8")
    except Exception as e:
        print(f"Warning: Could not fetch content from {url}: {e}")
        return ""


def get_template_vars() -> dict[str, Any]:
    """Get variables for template rendering"""
    annotation_docs = fetch_remote_content(ANNOTATIONS_MD_URL)

    return {
        "annotation_docs": annotation_docs,
        # Add other template variables as needed
    }


def get_spec_assist_prompt() -> str:
    """Load and render the specification assistant system prompt"""
    template = env.get_template("spec-assist.system.txt")
    return template.render(**get_template_vars())


def get_lemma_assist_prompt() -> str:
    """Get the system prompt for the lemma assistant"""
    template = env.get_template("lemma-assist.system.txt")
    return template.render(**get_template_vars())
