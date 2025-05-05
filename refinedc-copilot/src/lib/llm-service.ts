/**
 * LLM Service for RefinedC Copilot
 *
 * This module integrates the Anthropic Claude API with the RefinedC Copilot,
 * allowing for LLM-powered functionality through the MCP protocol.
 */

import { Anthropic } from '@anthropic-ai/sdk';
import { MessageParam, Tool, TextBlock } from '@anthropic-ai/sdk/resources/messages/messages.mjs';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

// Configuration
const MAX_TOKENS = 4096;

// Load environment variables from parent directory
const loadEnv = () => {
  const envPath = path.resolve(process.cwd(), '..', '.env');
  if (fs.existsSync(envPath)) {
    console.log(`Loading environment variables from ${envPath}`);
    dotenv.config({ path: envPath });
  } else {
    console.log('No .env file found in parent directory, using default environment');
    dotenv.config();
  }
};

/**
 * LLM Service Class
 * Handles communication with the Claude API
 */
export class LlmService {
  private client: Anthropic;
  private initialized: boolean = false;

  constructor() {
    loadEnv();
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      console.error('ANTHROPIC_API_KEY is not set in environment variables');
      this.initialized = false;
      this.client = null as unknown as Anthropic;
      return;
    }

    this.client = new Anthropic({
      apiKey
    });
    this.initialized = true;
  }

  /**
   * Check if the LLM service is properly initialized
   */
  public isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Generate annotations for a C function
   *
   * @param sourceCode - The C source code
   * @param functionName - The name of the function to annotate
   * @param options - Options for annotation generation
   * @returns The generated annotations and explanation
   */
  public async generateAnnotations(
    sourceCode: string,
    functionName: string,
    options: {
      considerOverflow?: boolean;
      generatePreconditions?: boolean;
      generatePostconditions?: boolean;
    } = {}
  ): Promise<{
    annotations: string[];
    explanation: string;
  }> {
    if (!this.initialized) {
      throw new Error('LLM service not initialized. Check ANTHROPIC_API_KEY.');
    }

    const systemPrompt = `You are a C programming expert specializing in RefinedC annotations for formal verification.
Your task is to analyze C functions and generate appropriate RefinedC annotations.
These annotations follow the standard C2X format: [[rc::annotation_type(annotation_content)]]

Follow these guidelines:
1. Generate [[rc::args(...)]] for function arguments
2. Generate [[rc::returns(...)]] for the return type
3. Include [[rc::parameters(...)]] if needed
4. Add [[rc::requires(...)]] for preconditions${options.considerOverflow ? '\n5. Pay special attention to potential integer overflow issues' : ''}${options.generatePostconditions ? '\n6. Include [[rc::ensures(...)]] for postconditions when appropriate' : ''}

Return annotations as a list, each on a new line, formatted exactly as they should appear in the code.`;

    const userPrompt = `Analyze this C function and generate RefinedC annotations:

Function Name: ${functionName}

C Source Code:
\`\`\`c
${sourceCode}
\`\`\`

Generate all required annotations for formal verification.`;

    const response = await this.client.messages.create({
      model: 'claude-3-5-sonnet-20240620',
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userPrompt }
      ]
    });

    // Extract annotations from the response
    const textBlock = response.content.find(block => block.type === 'text') as TextBlock | undefined;
    const text = textBlock?.text || '';
    const annotations = this.parseAnnotations(text);

    return {
      annotations,
      explanation: text
    };
  }

  /**
   * Generate helper lemmas for RefinedC proofs
   *
   * @param errorOutput - The error output from RefinedC
   * @param sourceCode - The original C source code
   * @returns The generated lemma code
   */
  public async generateHelperLemma(
    errorOutput: string,
    sourceCode: string
  ): Promise<string> {
    if (!this.initialized) {
      throw new Error('LLM service not initialized. Check ANTHROPIC_API_KEY.');
    }

    const systemPrompt = `You are an expert in RefinedC and Coq formal verification.
Your task is to analyze RefinedC error messages and generate appropriate helper lemmas to resolve verification failures.
Always follow the standard format for RefinedC helper lemmas, including all necessary imports.`;

    const userPrompt = `RefinedC failed to verify this code with the following error:

ERROR OUTPUT:
\`\`\`
${errorOutput}
\`\`\`

SOURCE CODE:
\`\`\`c
${sourceCode}
\`\`\`

Generate a helper lemma that will resolve this issue. Include all necessary imports and proof tactics.
Format your response as a complete Coq file that can be directly used with RefinedC.`;

    const response = await this.client.messages.create({
      model: 'claude-3-5-sonnet-20240620',
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userPrompt }
      ]
    });

    const textBlock = response.content.find(block => block.type === 'text') as TextBlock | undefined;
    return textBlock?.text || '';
  }

  /**
   * Parse annotations from LLM response text
   *
   * @param text - The raw text from the LLM
   * @returns Array of annotation strings
   */
  private parseAnnotations(text: string): string[] {
    // Extract all strings that match the pattern [[rc::...]]
    const annotationRegex = /\[\[rc::[^\]]+\]\]/g;
    const matches = text.match(annotationRegex);

    if (!matches) {
      return [];
    }

    return matches;
  }
}

// Singleton instance
export const llmService = new LlmService();
