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
      functionSignature?: string;
      functionBody?: string;
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

    let userPrompt = `Analyze this C function and generate RefinedC annotations:

Function Name: ${functionName}

C Source Code:
\`\`\`c
${sourceCode}
\`\`\`

Generate all required annotations for formal verification.`;

    // If we have more detailed function information, use it
    if (options.functionSignature || options.functionBody) {
      userPrompt = `Analyze this C function and generate RefinedC annotations:

Function Name: ${functionName}

${options.functionSignature ? `Function Signature:\n\`\`\`c\n${options.functionSignature}\n\`\`\`\n\n` : ''}
${options.functionBody ? `Function Body:\n\`\`\`c\n${options.functionBody}\n\`\`\`\n\n` : ''}

Full Source Context:
\`\`\`c
${sourceCode}
\`\`\`

Generate all required annotations for formal verification.`;
    }

    // Create message array for Anthropic API
    const messages: MessageParam[] = [
      { role: 'user', content: userPrompt }
    ];

    // Call Claude API to generate annotations
    const response = await this.client.messages.create({
      model: 'claude-3-5-sonnet-20240620',
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: messages
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
Always follow the standard format for RefinedC helper lemmas, including all necessary imports and proof tactics.

When analyzing RefinedC errors:
1. Identify the specific proof obligation that's failing
2. Determine what helper lemma would be needed
3. Generate a well-formed Coq lemma with the proper type signatures
4. Include any necessary imports at the top of the file
5. Provide a proof implementation using appropriate tactics
6. Make sure the lemma handles edge cases like overflow`;

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

    // Define tools for lemma generation
    const tools: Tool[] = [
      {
        name: 'parse_error',
        description: 'Parse RefinedC error message to identify the verification problem',
        input_schema: {
          type: 'object',
          properties: {
            errorMessage: {
              type: 'string',
              description: 'The error message from RefinedC'
            }
          },
          required: ['errorMessage']
        }
      },
      {
        name: 'generate_lemma',
        description: 'Generate a helper lemma in Coq to resolve a verification issue',
        input_schema: {
          type: 'object',
          properties: {
            problemDescription: {
              type: 'string',
              description: 'Description of the verification problem'
            },
            sourceContext: {
              type: 'string',
              description: 'Relevant source code context'
            }
          },
          required: ['problemDescription', 'sourceContext']
        }
      }
    ];

    // Call Claude API to generate helper lemma
    const response = await this.client.messages.create({
      model: 'claude-3-5-sonnet-20240620',
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userPrompt }
      ],
      tools: tools
    });

    // Extract lemma code from the response
    const textBlock = response.content.find(block => block.type === 'text') as TextBlock | undefined;
    return textBlock?.text || '';
  }

  /**
   * Parse annotations from LLM response text
   *
   * @param text - The raw text from the LLM
   * @returns Array of annotation strings
   */
  public parseAnnotations(text: string): string[] {
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
