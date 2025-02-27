from pathlib import Path
from urllib.request import urlopen
from typing import Any
from jinja2 import Environment, FileSystemLoader

ANNOTATIONS_MD_URL = (
    "https://gitlab.mpi-sws.org/iris/refinedc/-/raw/master/ANNOTATIONS.md"
)
BINARY_SEARCH_EXAMPLE = (
    "https://gitlab.mpi-sws.org/iris/refinedc/-/raw/master/examples/binary_search.c"
)
WRAPPING_ADD_EXAMPLE = (
    "https://gitlab.mpi-sws.org/iris/refinedc/-/raw/master/examples/wrapping_add.c"
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


def get_template_vars_from_urls(*urls: str) -> dict[str, Any]:
    """Get variables for template rendering from a list of URLs

    Args:
        *urls: Variable number of URLs to fetch content from

    Returns:
        Dictionary containing fetched content and other template variables
    """
    template_vars = {}

    for url in urls:
        # Extract a simple name from the URL's filename
        name = url.split("/")[-1].split(".")[0].lower()
        content = fetch_remote_content(url)
        template_vars[f"{name}_docs"] = content

    return template_vars


def get_spec_assist_prompt() -> str:
    """Load and render the specification assistant system prompt"""
    template = env.get_template("spec-assist.system.prompt")
    vars = get_template_vars_from_urls(
        ANNOTATIONS_MD_URL, BINARY_SEARCH_EXAMPLE, WRAPPING_ADD_EXAMPLE
    )
    return template.render(**vars)


def get_lemma_assist_prompt() -> str:
    """Get the system prompt for the lemma assistant"""
    template = env.get_template("lemma-assist.system.prompt")
    return template.render()  # No variables needed for lemma assistant
