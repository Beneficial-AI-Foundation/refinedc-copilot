{ pkgs ? import <nixpkgs> {} }:
# I don't know how to nixify refinedc, but maybe you'd like to install uv this way
let buildInputs = with pkgs; [ uv opam pnpm libclang dune_3 ]; in

pkgs.mkShell {
  inherit buildInputs;
}
