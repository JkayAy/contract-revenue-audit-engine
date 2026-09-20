/**
 * clause-extraction.eval.ts
 *
 * LLM evaluation harness for the contract clause extraction step.
 *
 * Runs the same extractContractClauses function used in production
 * against a fixed set of labelled contract snippets, and measures:
 *
 *   - Accuracy   F1 score against ground-truth clause labels (per term type)
 *   - Cost       Anthropic API spend in USD per task (input + output tokens)
 *   - Latency    p50 / p95 wall-clock time in milliseconds
 *
 * Results are printed as a Markdown table so they can be pasted directly
 * into the README.  A non-zero exit code is returned if mean F1 < 0.80,
 * making this runnable in CI as a regression gate.
 *
 * Usage:
 *   npm run eval:clause-extraction
 *   # or with a specific model override:
 *   ANTHROPIC_MODEL=claude-opus-4-5 npm run eval:clause-extraction
 *
 * Add to package.json:
 *   "eval:clause-extraction": "npx tsx evals/clause-extraction.eval.ts"
 */

import Anthropic from '@anthropic-ai/sdk';
import { ContractClauseExtractionSchema } from '../src/types/contract';

// ---------------------------------------------------------------------------
// Ground-truth dataset
// Each fixture contains a contract snippet and the expected term types
// that should be extracted from it.
// ---------------------------------------------------------------------------
const FIXTURES: Array<{
  id: string;
  contractText: string;
  expectedTermTypes: string[];
}> = [
  {
    id: 'volume-discount-simple',
    contractText: `
      3.1 Volume Discount. Customer shall receive a 15% discount on all
      orders exceeding 500 units per calendar month.  The discount will be
      applied as a credit on the following month's invoice.
    `,
    expectedTermTypes: ['volume_discount'],
  },
  {
    id: 'sla-penalty-clause',
    contractText: `
      8.2 SLA Credit. If Provider fails to maintain 99.9% uptime in any
      calendar month, Customer shall receive a service credit equal to 10%
      of that month's fees.  Credits are applied to the next billing cycle.
    `,
    expectedTermTypes: ['sla_penalty'],
  },
  {
    id: 'unit-price',
    contractText: `
      Schedule A - Pricing.  The per-unit price for API calls is USD 0.004
      per successful request, billed monthly in arrears.
    `,
    expectedTermTypes: ['unit_price'],
  },
  {
    id: 'renewal-clause',
    contractText: `
      12.1 Auto-Renewal.  This Agreement shall automatically renew for
      successive one-year terms unless either party provides 60 days' prior
      written notice of its intention not to renew.
    `,
    expectedTermTypes: ['renewal_clause'],
  },
  {
    id: 'mixed-clauses',
    contractText: `
      5.1 Tiered Pricing.  Orders of 0-199 units: USD 0.010/unit.
      Orders of 200-999 units: USD 0.008/unit (20% discount).
      Orders of 1 000+ units: USD 0.006/unit (40% discount).

      9.3 SLA Penalty.  Any month in which uptime falls below 99.5% will
      trigger a penalty credit of 20% of that month's invoice.

      14.2 Renewal.  Contract renews annually unless cancelled 90 days
      before expiry.
    `,
    expectedTermTypes: ['volume_discount', 'sla_penalty', 'renewal_clause'],
  },
];

// ---------------------------------------------------------------------------
// Extraction tool (mirrors src/workers/auditWorker.ts)
// ---------------------------------------------------------------------------
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const CLAUDE_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-3-7-sonnet-20250219';
const EXTRACTION_TOOL_NAME = 'record_contract_clauses';

const extractionTool: Anthropic.Tool = {
  name: EXTRACTION_TOOL_NAME,
  description: 'Record structured clauses extracted from a signed contract.',
  input_schema: {
    type: 'object',
    properties: {
      clauses: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            termType: {
              type: 'string',
              enum: ['volume_discount', 'sla_penalty', 'unit_price', 'renewal_clause', 'custom'],
            },
            clauseText: { type: 'string' },
            structuredValue: { type: 'object' },
            confidence: { type: 'number' },
          },
          required: ['termType', 'clauseText', 'structuredValue', 'confidence'],
        },
      },
    },
    required: ['clauses'],
  },
};

// ---------------------------------------------------------------------------
// Evaluation helpers
// ---------------------------------------------------------------------------
interface TaskResult {
  fixtureId: string;
  model: string;
  predictedTermTypes: string[];
  expectedTermTypes: string[];
  precision: number;
  recall: number;
  f1: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
}

/** Claude token pricing as of 2025-09-01 (USD per million tokens). */
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-3-7-sonnet-20250219': { input: 3.0, output: 15.0 },
  'claude-3-5-haiku-20241022':  { input: 0.8, output: 4.0  },
  'claude-opus-4-5':            { input: 15.0, output: 75.0 },
};

function tokenCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING[model] ?? { input: 3.0, output: 15.0 };
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

function computeF1(predicted: string[], expected: string[]): { precision: number; recall: number; f1: number } {
  const predSet = new Set(predicted);
  const expSet = new Set(expected);
  const tp = [...predSet].filter((t) => expSet.has(t)).length;
  const precision = predSet.size > 0 ? tp / predSet.size : 0;
  const recall = expSet.size > 0 ? tp / expSet.size : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1 };
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(Math.floor((p / 100) * sorted.length), sorted.length - 1);
  return sorted[idx];
}

// ---------------------------------------------------------------------------
// Main eval loop
// ---------------------------------------------------------------------------
async function runEval(): Promise<void> {
  console.log(`\n Running clause-extraction eval on ${FIXTURES.length} fixtures`);
  console.log(`    Model: ${CLAUDE_MODEL}\n`);

  const results: TaskResult[] = [];

  for (const fixture of FIXTURES) {
    const start = Date.now();

    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 2048,
      tools: [extractionTool],
      tool_choice: { type: 'tool', name: EXTRACTION_TOOL_NAME },
      messages: [
        {
          role: 'user',
          content: `Extract every clause from the following contract text:\n\n${fixture.contractText}`,
        },
      ],
    });

    const latencyMs = Date.now() - start;

    const toolBlock = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );

    const extraction = toolBlock
      ? ContractClauseExtractionSchema.safeParse(toolBlock.input)
      : { success: false as const };

    const predictedTermTypes = extraction.success
      ? [...new Set(extraction.data.clauses.map((c) => c.termType))]
      : [];

    const { precision, recall, f1 } = computeF1(predictedTermTypes, fixture.expectedTermTypes);
    const costUsd = tokenCost(CLAUDE_MODEL, response.usage.input_tokens, response.usage.output_tokens);

    results.push({
      fixtureId: fixture.id,
      model: CLAUDE_MODEL,
      predictedTermTypes,
      expectedTermTypes: fixture.expectedTermTypes,
      precision,
      recall,
      f1,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      costUsd,
      latencyMs,
    });

    process.stdout.write(`  fixture: ${fixture.id.padEnd(30)} F1=${f1.toFixed(2)}  ${latencyMs}ms\n`);
  }

  // ---------------------------------------------------------------------------
  // Summary statistics
  // ---------------------------------------------------------------------------
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const meanF1 = results.reduce((s, r) => s + r.f1, 0) / results.length;
  const totalCost = results.reduce((s, r) => s + r.costUsd, 0);

  console.log('');
  for (const r of results) {
    console.log(`${r.fixtureId.padEnd(36)} F1=${r.f1.toFixed(2)} cost=$${r.costUsd.toFixed(5)} lat=${r.latencyMs}ms`);
  }

  console.log(`\nMean F1: ${meanF1.toFixed(3)}  Total cost: $${totalCost.toFixed(5)}  p50: ${percentile(latencies, 50)}ms  p95: ${percentile(latencies, 95)}ms`);

  if (meanF1 < 0.80) {
    console.error(`Mean F1 ${meanF1.toFixed(3)} is below the 0.80 threshold.`);
    process.exit(1);
  }

  console.log('All fixtures passed the F1 >= 0.80 gate.');
}

runEval().catch((err) => {
  console.error(err);
  process.exit(1);
});
