#!/usr/bin/env ts-node
/**
 * RefinedC Copilot CLI
 *
 * This script provides a unified CLI interface to all RefinedC Copilot functionality.
 */
import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import {
  initProject,
  checkFile,
  applyAnnotations,
  extractFunctions,
  prepareArtifactFile
} from '../lib/utils/refinedc';
import {
  generateHelperLemma,
  saveHelperLemma,
  verifyHelperLemma,
  extractProofObligations
} from '../lib/utils/coqc';
import { readFile, writeFile } from "../lib/utils/promises";
import { runServer } from '../lib/mcp/server';
import { Annotation } from '../lib/types';

const program = new Command();

program
  .name('refinedc-copilot')
  .description('RefinedC Copilot CLI - Tools for working with RefinedC')
  .version('0.0.1');

// Project Commands
const projectCmd = program
  .command('project')
  .description('Project management commands');

// Initialize a RefinedC project
projectCmd
  .command('init')
  .description('Initialize a RefinedC project in the artifacts directory')
  .argument('<path>', 'Path to the source file or directory (will initialize in corresponding artifacts directory)')
  .action(async (projectPath) => {
    const result = await initProject(projectPath);
    if (result.success) {
      console.log('✅ Project initialized successfully in artifacts directory');
      if (result.output) { console.log(result.output); }
    } else {
      console.error('❌ Failed to initialize project');
      if (result.errors) {
        result.errors.forEach(error => console.error(error));
      }
    }
  });

// Check a C file with RefinedC
projectCmd
  .command('check')
  .description('Check a C file with RefinedC')
  .argument('<filePath>', 'Path to the C file to check')
  .option('--original', 'Check the original file instead of the artifact', false)
  .action(async (filePath, options) => {
    let fileToCheck = filePath;

    // If not using the original file, prepare the artifact file
    if (!options.original) {
      try {
        fileToCheck = await prepareArtifactFile(filePath);
      } catch (error) {
        const err = error as Error;
        console.error(`❌ Failed to prepare artifact file: ${err.message}`);
        process.exit(1);
      }
    }

    const result = await checkFile(fileToCheck);
    if (result.success) {
      console.log(`✅ File ${fileToCheck} checked successfully`);
      if (result.output) { console.log(result.output); }
    } else {
      console.error(`❌ Check failed for ${fileToCheck}`);
      if (result.errors) {
        result.errors.forEach(error => console.error(error));
      }
    }
  });

// Annotation Commands
const annotateCmd = program
  .command('annotate')
  .description('Annotation generation and management commands');

// Extract function information from a C file
annotateCmd
  .command('extract')
  .description('Extract functions from a C file')
  .argument('<filePath>', 'Path to the C file')
  .option('-o, --output <outputPath>', 'Save output to file')
  .action(async (filePath, options) => {
    try {
      const source = await readFile(filePath, 'utf8');
      const functions = extractFunctions(source);

      const output = JSON.stringify(functions, null, 2);

      if (options.output) {
        await writeFile(options.output, output);
        console.log(`✅ Extracted ${functions.length} functions to ${options.output}`);
      } else {
        console.log(`Found ${functions.length} functions:`);
        console.log(output);
      }
    } catch (error) {
      const err = error as Error;
      console.error(`❌ Error: ${err.message}`);
      process.exit(1);
    }
  });

// List functions in a C file
annotateCmd
  .command('list')
  .description('List functions in a C file')
  .argument('<filePath>', 'Path to the C file')
  .action(async (filePath) => {
    try {
      const source = await readFile(filePath, 'utf8');
      const functions = extractFunctions(source);

      console.log(`Found ${functions.length} functions in ${filePath}:`);
      functions.forEach((func, i) => {
        console.log(`${i+1}. ${func.name}`);
        if (func.annotations.length > 0) {
          console.log(`   Has ${func.annotations.length} annotation(s)`);
        }
      });
    } catch (error) {
      const err = error as Error;
      console.error(`❌ Error: ${err.message}`);
      process.exit(1);
    }
  });

// Generate LLM-based annotations for C functions
annotateCmd
  .command('generate-llm')
  .description('Generate annotations for C functions using LLM')
  .argument('<filePath>', 'Path to the C file')
  .argument('[functionName]', 'Name of the function to annotate (optional, annotates all functions if not specified)')
  .option('-o, --output <outputPath>', 'Save annotated file to custom path')
  .option('-p, --provider <provider>', 'LLM provider (openai, anthropic, local)', 'local')
  .option('-m, --model <model>', 'LLM model to use', 'local')
  .option('-c, --consider-overflow', 'Consider overflow in operations', false)
  .option('--post-conditions', 'Generate postconditions for return values', false)
  .option('--no-apply', 'Generate annotations but don\'t apply them')
  .action(async (filePath, functionName, options) => {
    try {
      // Prepare command for the generate-annotations.ts script
      const scriptPath = path.join(__dirname, 'generate-annotations.ts');
      const args = [
        scriptPath,
        filePath
      ];

      // Add function name if specified
      if (functionName) {
        args.push(functionName);
      }

      // Add options
      if (options.output) {
        args.push('-o', options.output);
      }

      if (options.provider) {
        args.push('-p', options.provider);
      }

      if (options.model) {
        args.push('-m', options.model);
      }

      if (options.considerOverflow) {
        args.push('-c');
      }

      if (options.postConditions) {
        args.push('--post-conditions');
      }

      if (options.apply === false) {
        args.push('--no-apply');
      }

      // Run the generator script
      const child = spawn('ts-node', args, {
        stdio: 'inherit',
        shell: true
      });

      // Forward exit code
      child.on('exit', (code) => {
        process.exit(code || 0);
      });
    } catch (error) {
      const err = error as Error;
      console.error(`❌ Error: ${err.message}`);
      process.exit(1);
    }
  });

// Generate basic annotations for a C function
annotateCmd
  .command('generate')
  .description('Generate annotations for a C function')
  .argument('<filePath>', 'Path to the C file')
  .argument('<functionName>', 'Name of the function to annotate')
  .option('-r, --returns <type>', 'Override the return type')
  .option('-a, --args <args>', 'Override the argument types (comma-separated)')
  .option('-p, --parameters <params>', 'Add parameters')
  .option('-q, --requires <reqs>', 'Add requirements')
  .option('-o, --output <outputPath>', 'Save annotated file to custom path')
  .action(async (filePath, functionName, options) => {
    try {
      // Prepare artifact file path (always copy to artifacts directory first)
      const targetPath = options.output || await prepareArtifactFile(filePath);

      // Read the source file
      const source = await readFile(targetPath, 'utf8');

      // Prepare annotations
      const annotations: Annotation[] = [];

      if (options.args) {
        annotations.push({
          type: 'args',
          content: options.args
        });
      }

      if (options.returns) {
        annotations.push({
          type: 'returns',
          content: options.returns
        });
      }

      if (options.parameters) {
        annotations.push({
          type: 'parameters',
          content: options.parameters
        });
      }

      if (options.requires) {
        annotations.push({
          type: 'requires',
          content: options.requires
        });
      }

      // If no custom annotations provided, generate function signature based ones
      if (annotations.length === 0) {
        // Simple C type to RefinedC type mapping
        const typeMap: Record<string, string> = {
          'int': 'int<i32>',
          'unsigned': 'int<u32>',
          'unsigned int': 'int<u32>',
          'char': 'int<i8>',
          'unsigned char': 'int<u8>',
          'long': 'int<i64>',
          'unsigned long': 'int<u64>',
          'void': 'void',
        };

        // Find the function signature
        const functionRegex = new RegExp(`[\\s\\n]+(\\w+\\s+${functionName}\\s*\\([^)]*\\))\\s*\\{`, 'g');
        const match = functionRegex.exec(source);

        if (!match) {
          console.error(`❌ Function ${functionName} not found in source code`);
          process.exit(1);
        }

        // Extract return type and parameters
        const signature = match[1];
        const returnTypeMatch = signature.match(/^(\w+)\s+/);
        const returnType = returnTypeMatch ? returnTypeMatch[1] : 'void';

        const paramsMatch = signature.match(/\(([^)]*)\)/);
        const params = paramsMatch ? paramsMatch[1].split(',') : [];

        // Detect if return type includes "unsigned" for proper RefinedC type
        const isUnsigned = returnType.includes('unsigned');
        const baseReturnType = isUnsigned ? 'int<u32>' : 'int<i32>';
        const returnRefinedType = typeMap[returnType] || baseReturnType;

        // Generate parameter types
        const paramTypes = params.map(param => {
          const trimmed = param.trim();
          if (!trimmed) { return ''; }

          const parts = trimmed.split(/\s+/);
          // Check if the parameter type includes "unsigned"
          const isParamUnsigned = parts.includes('unsigned');
          const type = parts.length > 1 ? parts.slice(0, -1).join(' ') : 'int';
          return typeMap[type] || (isParamUnsigned ? 'int<u32>' : 'int<i32>');
        }).filter(t => t);

        annotations.push({
          type: 'args',
          content: paramTypes.map(t => `"${t}"`).join(', ')
        });

        annotations.push({
          type: 'returns',
          content: returnRefinedType
        });
      }

      // Apply the annotations - note this will read from targetPath and write to targetPath
      const result = await applyAnnotations(targetPath, targetPath, [
        { functionName, annotations }
      ]);

      if (result.success) {
        console.log(`✅ Successfully applied annotations to ${functionName} in ${targetPath}`);
        console.log('Applied annotations:');
        annotations.forEach(anno => {
          console.log(`  [[rc::${anno.type}("${anno.content}")]]`);
        });
      } else {
        console.error(`❌ Failed to apply annotations: ${result.message}`);
        if (result.errors) {
          result.errors.forEach(error => console.error(error));
        }
      }
    } catch (error) {
      const err = error as Error;
      console.error(`❌ Error: ${err.message}`);
      process.exit(1);
    }
  });

// Apply a set of annotations from a JSON file
annotateCmd
  .command('apply')
  .description('Apply annotations from a JSON file')
  .argument('<filePath>', 'Path to the C file')
  .argument('<annotationsPath>', 'Path to JSON file with annotations')
  .option('-o, --output <outputPath>', 'Save annotated file to custom path')
  .action(async (filePath, annotationsPath, options) => {
    try {
      // Prepare artifact file path (always copy to artifacts directory first)
      const targetPath = options.output || await prepareArtifactFile(filePath);

      // Read the annotations file
      const annotationsJson = await readFile(annotationsPath, 'utf8');
      const annotationSpecs = JSON.parse(annotationsJson);

      // Apply the annotations
      const result = await applyAnnotations(targetPath, targetPath, annotationSpecs);

      if (result.success) {
        console.log(`✅ Successfully applied annotations to ${targetPath}`);
      } else {
        console.error(`❌ Failed to apply annotations: ${result.message}`);
        if (result.errors) {
          result.errors.forEach(error => console.error(error));
        }
      }
    } catch (error) {
      const err = error as Error;
      console.error(`❌ Error: ${err.message}`);
      process.exit(1);
    }
  });

// Lemma Commands
const lemmaCmd = program
  .command('lemma')
  .description('Helper lemma generation and management commands');

// Generate and save a helper lemma
lemmaCmd
  .command('generate')
  .description('Generate a helper lemma based on an error message')
  .argument('<sourcePath>', 'Path to the source C file')
  .option('-e, --error <errorMessage>', 'Error message to parse', '')
  .option('-f, --error-file <errorFile>', 'File containing the error message')
  .action(async (sourcePath, options) => {
    try {
      // Always work with the artifact file
      const targetPath = await prepareArtifactFile(sourcePath);
      let errorMessage = options.error;

      // If an error file was provided, read from it
      if (options.errorFile) {
        try {
          errorMessage = fs.readFileSync(options.errorFile, 'utf8');
        } catch (error) {
          const err = error as Error;
          console.error(`❌ Failed to read error file: ${err.message}`);
          process.exit(1);
        }
      }

      // If no error message was provided, prompt the user
      if (!errorMessage) {
        console.error('❌ No error message provided. Use -e or -f option.');
        process.exit(1);
      }

      // Generate and save the lemma
      const lemmaContent = generateHelperLemma(errorMessage);
      console.log('Generated lemma:');
      console.log(lemmaContent);

      const saveResult = await saveHelperLemma(targetPath, lemmaContent);
      if (saveResult.success) {
        console.log(`✅ ${saveResult.message}`);

        // Verify the lemma
        console.log('Verifying lemma...');
        const verifyResult = await verifyHelperLemma(targetPath);
        if (verifyResult.success) {
          console.log('✅ Lemma verified successfully');
        } else {
          console.error('❌ Lemma verification failed');
          if (verifyResult.errors) {
            verifyResult.errors.forEach(error => console.error(error));
          }
        }
      } else {
        console.error(`❌ Failed to save lemma: ${saveResult.message}`);
        if (saveResult.errors) {
          saveResult.errors.forEach(error => console.error(error));
        }
      }
    } catch (error) {
      const err = error as Error;
      console.error(`❌ Error: ${err.message}`);
      process.exit(1);
    }
  });

// Extract proof obligations from error output
lemmaCmd
  .command('extract-obligations')
  .description('Extract proof obligations from RefinedC error output')
  .option('-e, --error <errorMessage>', 'Error message to parse', '')
  .option('-f, --error-file <errorFile>', 'File containing the error message')
  .action(async (options) => {
    let errorMessage = options.error;

    // If an error file was provided, read from it
    if (options.errorFile) {
      try {
        errorMessage = fs.readFileSync(options.errorFile, 'utf8');
      } catch (error) {
        const err = error as Error;
        console.error(`❌ Failed to read error file: ${err.message}`);
        process.exit(1);
      }
    }

    // If no error message was provided, prompt the user
    if (!errorMessage) {
      console.error('❌ No error message provided. Use -e or -f option.');
      process.exit(1);
    }

    // Extract the obligations
    const obligations = extractProofObligations(errorMessage);
    console.log(`Found ${obligations.length} proof obligations:`);
    obligations.forEach((obligation, i) => {
      console.log(`\nObligation ${i + 1}:`);
      console.log(obligation);
    });
  });

// Server Commands
const serverCmd = program
  .command('server')
  .description('MCP server management commands');

// Start the MCP server
serverCmd
  .command('start')
  .description('Start the MCP server')
  .option('-p, --port <port>', 'Port for HTTP transport (if enabled)', '3000')
  .option('-H, --host <host>', 'Host for HTTP transport (if enabled)', 'localhost')
  .option('-t, --transport <transport>', 'Transport type: stdio (default) or http', 'stdio')
  .option('-v, --verbose', 'Enable verbose logging')
  .action(async (options) => {
    try {
      console.log('Starting RefinedC Copilot MCP server...');
      console.log(`Transport: ${options.transport}`);

      if (options.transport === 'http') {
        console.log(`Host: ${options.host}`);
        console.log(`Port: ${options.port}`);
      }

      if (options.verbose) {
        console.log('Verbose logging enabled');
      }

      // For now, we only support stdio transport
      if (options.transport !== 'stdio') {
        console.warn('Warning: Only stdio transport is currently supported. Falling back to stdio.');
      }

      // Run the server
      await runServer();

    } catch (error) {
      const err = error as Error;
      console.error(`❌ Error starting server: ${err.message}`);
      process.exit(1);
    }
  });

// Parse arguments
program.parse(process.argv);

// If no arguments provided, show help
if (process.argv.length <= 2) {
  program.help();
}
