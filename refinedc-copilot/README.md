# refinedc-copilot README

This is the README for your extension "refinedc-copilot". After writing up a brief description, we recommend including the following sections.

## Features

Describe specific features of your extension including screenshots of your extension in action. Image paths are relative to this README file.

For example if there is an image subfolder under your extension project workspace:

\!\[feature X\]\(images/feature-x.png\)

> Tip: Many popular extensions utilize animations. This is an excellent way to show off your extension! We recommend short, focused animations that are easy to follow.

## Requirements

If you have any requirements or dependencies, add a section describing those and how to install and configure them.

## Extension Settings

Include if your extension adds any VS Code settings through the `contributes.configuration` extension point.

For example:

This extension contributes the following settings:

* `myExtension.enable`: Enable/disable this extension.
* `myExtension.thing`: Set to `blah` to do something.

## Known Issues

Calling out known issues can help limit users opening duplicate issues against your extension.

## Release Notes

Users appreciate release notes as you update your extension.

### 1.0.0

Initial release of ...

### 1.0.1

Fixed issue #.

### 1.1.0

Added features X, Y, and Z.

---

## Following extension guidelines

Ensure that you've read through the extensions guidelines and follow the best practices for creating your extension.

* [Extension Guidelines](https://code.visualstudio.com/api/references/extension-guidelines)

## Working with Markdown

You can author your README using Visual Studio Code. Here are some useful editor keyboard shortcuts:

* Split the editor (`Cmd+\` on macOS or `Ctrl+\` on Windows and Linux).
* Toggle preview (`Shift+Cmd+V` on macOS or `Shift+Ctrl+V` on Windows and Linux).
* Press `Ctrl+Space` (Windows, Linux, macOS) to see a list of Markdown snippets.

## For more information

* [Visual Studio Code's Markdown Support](http://code.visualstudio.com/docs/languages/markdown)
* [Markdown Syntax Reference](https://help.github.com/articles/markdown-basics/)

## RefinedC Copilot

RefinedC Copilot is a tool that helps developers write correct C code using the RefinedC verification system with LLM assistance.

## Command-Line Usage Guide

Here's how to use the RefinedC Copilot from the command line:

### Setting Up

1. Navigate to the `refinedc-copilot` directory:
   ```
   cd refinedc-copilot
   ```

2. Make sure dependencies are installed:
   ```
   pnpm install
   ```

### Basic Workflow

The basic workflow follows these steps:

1. **Initialize a RefinedC project** in the artifacts directory:
   ```
   pnpm run rcc:cli project init ../sources/your-project/file.c
   ```
   This will create a corresponding directory structure in `../artifacts/` where all verification will take place.

2. **List functions** in a C file:
   ```
   pnpm run rcc:cli annotate list ../sources/your-project/file.c
   ```

3. **Generate annotations** for functions:
   ```
   pnpm run rcc:cli annotate generate-llm ../sources/your-project/file.c [optional-function-name]
   ```
   This copies the source file to the artifacts directory and adds annotations.

   Options:
   - `--consider-overflow` - Add overflow protection annotations
   - `--post-conditions` - Generate postconditions for return values
   - `--output <path>` - Save to a custom path
   - `--no-apply` - Generate annotations but don't apply them

4. **Check an annotated file** with RefinedC:
   ```
   pnpm run rcc:cli project check ../artifacts/your-project/file.c
   ```

5. If verification fails due to needed helper lemmas, **generate lemmas**:
   ```
   pnpm run rcc:cli lemma generate ../artifacts/your-project/lemmas/file.v
   ```

### Example Workflow

For a file `../sources/trivial/src/example.c`:

```bash
# Initialize the project in the artifacts directory
pnpm run rcc:cli project init ../sources/trivial/src/example.c
# This creates ../artifacts/trivial/ with RefinedC project files
# and copies the source file to ../artifacts/trivial/src/example.c

# See what functions are available in the source file
pnpm run rcc:cli annotate list ../sources/trivial/src/example.c

# Generate annotations with overflow protection
pnpm run rcc:cli annotate generate-llm ../sources/trivial/src/example.c --consider-overflow

# Verify the annotated file in the artifacts directory
pnpm run rcc:cli project check ../artifacts/trivial/src/example.c
```

The resulting directory structure in `artifacts/` will be:

```
artifacts/trivial/
│
├── _CoqProject
├── dune-project
├── rc-project.toml
└── src/
    └── example.c
```

### Annotation Server

For intelligent annotation completions, you can use the annotation server:

```bash
# Start the annotation server
pnpm run mcp:annotation-server
```

## VSCode Extension

This package can also be used as a VSCode extension. See the VSCode folder for details.

**Enjoy!**
