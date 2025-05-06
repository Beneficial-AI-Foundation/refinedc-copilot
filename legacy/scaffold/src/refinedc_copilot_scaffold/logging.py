import os
import logfire
from dotenv import load_dotenv


def setup_logging() -> None:
    """Configure logfire with token from .env"""
    load_dotenv("./../.env")

    logfire_token = os.getenv("LOGFIRE_WRITE_TOKEN")
    if not logfire_token:
        raise ValueError("LOGFIRE__WRITE_TOKEN not found in .env file")

    logfire.configure(token=logfire_token)
