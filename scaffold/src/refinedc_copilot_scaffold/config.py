from dataclasses import dataclass
from pathlib import Path
import tomllib


@dataclass
class PathConfig:
    sources_dir: Path
    artifacts_dir: Path


@dataclass
class AgentSettings:
    model: str
    max_iterations: int
    enabled: bool


@dataclass
class AgentConfig:
    spec_assist: AgentSettings
    lemma_assist: AgentSettings

    @classmethod
    def from_dict(cls, data: dict) -> "AgentConfig":
        return cls(
            spec_assist=AgentSettings(**data["spec_assist"]),
            lemma_assist=AgentSettings(**data["lemma_assist"]),
        )


@dataclass
class MetaConfig:
    logging: bool
    debug: bool = False


@dataclass
class ToolsConfig:
    refinedc: Path
    coqc: Path


@dataclass
class Config:
    paths: PathConfig
    agents: AgentConfig
    tools: ToolsConfig
    meta: MetaConfig
    root_dir: Path  # Store the root directory where config was found

    @classmethod
    def load(cls, config_path: Path) -> "Config":
        """Load configuration from the TOML file"""
        with open(config_path, "rb") as f:
            data = tomllib.load(f)

        # Convert tool paths to Path objects
        tools_data = data.get("tools", {})
        tools_config = ToolsConfig(
            refinedc=Path(tools_data.get("refinedc", "refinedc"))
            .expanduser()
            .resolve(),
            coqc=Path(tools_data.get("coqc", "coqc")).expanduser().resolve(),
        )

        path_data = data.get("paths", {})
        paths_config = PathConfig(
            sources_dir=Path(path_data.get("sources_dir", "sources")),
            artifacts_dir=Path(path_data.get("artifacts_dir", "artifacts")),
        )

        return cls(
            paths=paths_config,
            agents=AgentConfig.from_dict(data["agents"]),
            tools=tools_config,
            meta=MetaConfig(**data["meta"]),
            root_dir=config_path.parent,
        )

    def get_project_dirs(self, project_name: str) -> tuple[Path, Path]:
        """Get the source and artifact directories for a given project"""
        return (
            self.root_dir / self.paths.sources_dir / project_name,
            self.root_dir / self.paths.artifacts_dir / project_name,
        )


def find_config_file(start_dir: Path | None = None) -> Path:
    """
    Find the refinedc-copilot-config.toml in the scaffold directory.
    """
    if start_dir is None:
        start_dir = Path.cwd()

    # Look for scaffold directory
    current = start_dir.absolute()
    while current != current.parent:
        if (current / "pyproject.toml").exists():
            config_path = current / "refinedc-copilot-config.toml"
            if config_path.exists():
                return config_path
            raise FileNotFoundError(
                f"Configuration file not found at {config_path}. "
                "Please ensure refinedc-copilot-config.toml exists in the scaffold directory."
            )
        current = current.parent

    raise FileNotFoundError(
        "Could not find scaffold directory (identified by pyproject.toml)"
    )


def load_config(config_path: Path | None = None) -> Config:
    """
    Load the configuration from the specified path or find it in parent directories.
    """
    if config_path is None:
        config_path = find_config_file()
    elif not config_path.exists():
        raise FileNotFoundError(f"Configuration file not found at {config_path}")

    config = Config.load(config_path)

    # Ensure artifacts directory exists
    Path(config.paths.artifacts_dir).mkdir(parents=True, exist_ok=True)

    return config
