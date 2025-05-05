#!/usr/bin/env ts-node
/**
 * RefinedC Copilot MCP Server Runner
 *
 * This script starts the MCP server for the RefinedC Copilot.
 */
import { runServer } from '../lib/mcp/server';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

// Load environment variables from parent directory first
const envPath = path.resolve(process.cwd(), '..', '.env');
if (fs.existsSync(envPath)) {
  console.log(`Loading environment variables from ${envPath}`);
  dotenv.config({ path: envPath });
} else {
  // Fallback to local .env
  dotenv.config();
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('WARNING: ANTHROPIC_API_KEY environment variable not found. LLM features will be disabled.');
}

// Run the server
console.log('Starting RefinedC Copilot MCP server...');
runServer()
  .then(() => {
    console.log('Server running. Press Ctrl+C to stop.');
  })
  .catch(error => {
    console.error(`Error starting server: ${error.message}`);
    process.exit(1);
  });
