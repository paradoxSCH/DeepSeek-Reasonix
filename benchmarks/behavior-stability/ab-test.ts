/** A/B test for Task integrity guardrail (#1495). */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CacheFirstLoop,
  DeepSeekClient,
  ImmutablePrefix,
  ToolRegistry,
  codeSystemPrompt,
  registerFilesystemTools,
  registerShellTools,
} from "../../src/index.js";
import type { ChatMessage } from "../../src/types.js";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const FATIGUE_TURNS = 30;
const MAX_TURNS = 10;
const TRIALS_PER_VARIANT = 3;

const TASK_PROMPT =
  "Create a small Node.js utility module with exactly 3 files:\n\n" +
  "1. src/math.js — Exports add(a,b), multiply(a,b), isEven(n). " +
  "Each function must validate that inputs are numbers and throw a TypeError with a descriptive message if not.\n" +
  "2. test/math.test.js — At least 3 tests using node:assert that verify all three functions including the validation/throw behavior.\n" +
  "3. README.md — Documents all exported functions with a one-line description and a usage example for each.\n\n" +
  "You MUST create all 3 files. Do NOT skip the tests or README.";

const CONTINUE_PROMPT =
  "Continue and implement ALL 3 files. Do not skip any step.";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function stripGuardrail(prompt: string): string {
  return prompt.replace(
    /# Task integrity — non-negotiable[\s\S]*?(?=\n# |\n---|$)/,
    "",
  );
}

function injectFatigue(loop: CacheFirstLoop): void {
  for (let i = 0; i < FATIGUE_TURNS; i++) {
    loop.log.append({
      role: "user",
      content: `Task ${i + 1}: Review file src/utils/${i}.ts and tell me if it has any issues.`,
    } as ChatMessage);
    loop.log.append({
      role: "assistant",
      content: `I reviewed src/utils/${i}.ts. No issues found — code is clean and well-typed.`,
    } as ChatMessage);
  }
}

interface ScoreBreakdown {
  total: number;
  details: string[];
}

function score(workDir: string): ScoreBreakdown {
  const details: string[] = [];
  let total = 0;

  const srcPath = join(workDir, "src", "math.js");
  const testPath = join(workDir, "test", "math.test.js");
  const readmePath = join(workDir, "README.md");

  // --- src/math.js (max 2) ---
  if (existsSync(srcPath)) {
    const src = readFileSync(srcPath, "utf8");
    const hasAdd = /function\s+add\s*\(|exports\.add\s*=/.test(src);
    const hasMultiply = /function\s+multiply\s*\(|exports\.multiply\s*=/.test(src);
    const hasIsEven = /function\s+isEven\s*\(|exports\.isEven\s*=/.test(src);
    const hasThrow = /throw\s+new\s+TypeError/.test(src);

    if (hasAdd && hasMultiply && hasIsEven) {
      total += 1;
      details.push("src/math.js: all 3 functions present (+1)");
    } else {
      details.push(
        `src/math.js: missing functions (add=${hasAdd}, multiply=${hasMultiply}, isEven=${hasIsEven})`,
      );
    }

    if (hasThrow) {
      total += 1;
      details.push("src/math.js: input validation with TypeError (+1)");
    } else {
      details.push("src/math.js: no TypeError validation found");
    }
  } else {
    details.push("src/math.js: MISSING");
  }

  // --- test/math.test.js (max 2) ---
  if (existsSync(testPath)) {
    const test = readFileSync(testPath, "utf8");
    const assertMatches = test.match(/assert\./g);
    const assertCount = assertMatches ? assertMatches.length : 0;
    const hasThrowTest = /throw|TypeError/.test(test);

    if (assertCount >= 3) {
      total += 1;
      details.push(`test/math.test.js: ${assertCount} assert calls (+1)`);
    } else {
      details.push(`test/math.test.js: only ${assertCount} assert calls`);
    }

    if (hasThrowTest) {
      total += 1;
      details.push("test/math.test.js: tests validation/throw behavior (+1)");
    } else {
      details.push("test/math.test.js: no throw/TypeError test found");
    }
  } else {
    details.push("test/math.test.js: MISSING");
  }

  // --- README.md (max 1) ---
  if (existsSync(readmePath)) {
    const readme = readFileSync(readmePath, "utf8");
    const lower = readme.toLowerCase();
    const hasExamples = /```/.test(readme) || /example/.test(lower);
    const hasAllFuncs =
      /add/.test(lower) && /multiply/.test(lower) && /isEven|iseven/.test(lower);

    if (hasExamples && hasAllFuncs) {
      total += 1;
      details.push("README.md: examples + all 3 functions documented (+1)");
    } else {
      details.push(
        `README.md: incomplete (examples=${hasExamples}, allFuncs=${hasAllFuncs})`,
      );
    }
  } else {
    details.push("README.md: MISSING");
  }

  return { total, details };
}

interface TrialResult {
  variant: "control" | "treatment";
  trial: number;
  score: number;
  maxScore: number;
  turns: number;
  details: string[];
}

async function runTrial(
  variant: "control" | "treatment",
  trial: number,
): Promise<TrialResult> {
  const workDir = join(
    tmpdir(),
    `reasonix-ab-${variant}-${trial}-${Date.now()}`,
  );
  mkdirSync(workDir, { recursive: true });

  try {
    const fullPrompt = codeSystemPrompt(workDir, {
      modelId: "deepseek-v4-flash",
    });
    const systemPrompt =
      variant === "control" ? stripGuardrail(fullPrompt) : fullPrompt;

    const client = new DeepSeekClient();
    const tools = new ToolRegistry();
    registerFilesystemTools(tools, { rootDir: workDir, allowWriting: true });
    registerShellTools(tools, { rootDir: workDir, allowAll: true });

    const prefix = new ImmutablePrefix({
      system: systemPrompt,
      toolSpecs: tools.specs(),
    });

    const loop = new CacheFirstLoop({
      client,
      prefix,
      tools,
      model: "deepseek-v4-flash",
      stream: false,
    });

    injectFatigue(loop);

    let turns = 0;
    let lastError = "";

    while (turns < MAX_TURNS) {
      const prompt = turns === 0 ? TASK_PROMPT : CONTINUE_PROMPT;

      for await (const ev of loop.step(prompt)) {
        if (ev.role === "error") {
          lastError = ev.error ?? "";
        }
        if (ev.role === "done") break;
      }

      turns++;

      // If all 3 files exist and look complete, stop early.
      if (
        existsSync(join(workDir, "src", "math.js")) &&
        existsSync(join(workDir, "test", "math.test.js")) &&
        existsSync(join(workDir, "README.md"))
      ) {
        break;
      }
    }

    if (lastError) {
      console.warn(`  [${variant} #${trial}] loop error: ${lastError}`);
    }

    const { total, details } = score(workDir);
    return { variant, trial, score: total, maxScore: 5, turns, details };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

function avg(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function std(nums: number[]): number {
  const mean = avg(nums);
  const variance = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / nums.length;
  return Math.sqrt(variance);
}

async function main(): Promise<void> {
  console.log(
    `Running A/B test: ${TRIALS_PER_VARIANT} trials per variant\n`,
  );

  const results: TrialResult[] = [];

  for (let t = 1; t <= TRIALS_PER_VARIANT; t++) {
    console.log(`Trial ${t}/${TRIALS_PER_VARIANT} …`);
    const control = await runTrial("control", t);
    results.push(control);
    console.log(
      `  control   #${t}: ${control.score}/${control.maxScore} (${control.turns} turns)`,
    );

    const treatment = await runTrial("treatment", t);
    results.push(treatment);
    console.log(
      `  treatment #${t}: ${treatment.score}/${treatment.maxScore} (${treatment.turns} turns)`,
    );
  }

  const controlScores = results
    .filter((r) => r.variant === "control")
    .map((r) => r.score);
  const treatmentScores = results
    .filter((r) => r.variant === "treatment")
    .map((r) => r.score);

  console.log(`\n=== Results ===`);
  console.log(
    `Control   mean: ${avg(controlScores).toFixed(2)}/5  (std: ${std(controlScores).toFixed(2)})`,
  );
  console.log(
    `Treatment mean: ${avg(treatmentScores).toFixed(2)}/5  (std: ${std(treatmentScores).toFixed(2)})`,
  );
  console.log(
    `Delta: ${(avg(treatmentScores) - avg(controlScores)).toFixed(2)} points`,
  );

  if (avg(treatmentScores) > avg(controlScores)) {
    console.log(`\nConclusion: Task integrity guardrail improves completion rate.`);
  } else if (avg(treatmentScores) < avg(controlScores)) {
    console.log(`\nConclusion: Guardrail had no positive effect (unexpected).`);
  } else {
    console.log(`\nConclusion: No measurable difference between variants.`);
  }

  // Write raw results for inspection.
  const outPath = join(process.cwd(), "benchmarks", "behavior-stability", "ab-results.json");
  writeFileSync(
    outPath,
    JSON.stringify({
      meta: {
        date: new Date().toISOString(),
        model: "deepseek-v4-flash",
        trialsPerVariant: TRIALS_PER_VARIANT,
        fatigueTurns: FATIGUE_TURNS,
        maxTurns: MAX_TURNS,
      },
      summary: {
        controlMean: avg(controlScores),
        controlStd: std(controlScores),
        treatmentMean: avg(treatmentScores),
        treatmentStd: std(treatmentScores),
        delta: avg(treatmentScores) - avg(controlScores),
      },
      trials: results,
    }, null, 2),
  );
  console.log(`\nRaw results written to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
