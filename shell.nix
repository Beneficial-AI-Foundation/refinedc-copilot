{ pkgs ? import (builtins.fetchTarball
  "https://github.com/NixOS/nixpkgs/archive/c3bb7450f2be4c01acc9d1b3e2ff45b7a21cd584.tar.gz")
  { } }:
# I don't know how to nixify refinedc, but maybe you'd like to install uv this way
let
  buildInputs = with pkgs; [
    uv
    opam
    pnpm
    typescript
    nodePackages.ts-node
    libclang
    dune_3
    mpfr
    gnumake
    gnupatch
    pkg-config
    python3
  ];
  name = "refinedc-copilot-dev";
  shellHook = "echo 'RefinedC Copilot Development'";
in pkgs.mkShell { inherit name buildInputs shellHook; }
