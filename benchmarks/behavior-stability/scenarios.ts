/** Behavior-stability scenarios — local + e2e tests for PRs #1372, #1462, #1495. */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AppendOnlyLog,
  CacheFirstLoop,
  DeepSeekClient,
  ImmutablePrefix,
  SessionStats,
  ToolRegistry,
  codeSystemPrompt,
  registerFilesystemTools,
  registerShellTools,
} from "../../src/index.js";
import { ContextManager } from "../../src/context-manager.js";
import type { ChatMessage, ChatRequestOptions, ChatResponse } from "../../src/types.js";
import type { EvalResult, EvalScenario } from "./types.js";

const VERSION = "0.48.0-eval";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function withTiming(fn: () => Promise<EvalResult>): Promise<EvalResult> {
  const t0 = Date.now();
  return fn().then((r) => ({ ...r, durationMs: Date.now() - t0 }));
}

function pass(id: string, details: string): EvalResult {
  return { scenarioId: id, pass: true, durationMs: 0, details };
}

function fail(id: string, details: string): EvalResult {
  return { scenarioId: id, pass: false, durationMs: 0, details };
}

/* ------------------------------------------------------------------ */
/*  #1372 — Shell tool preference (local)                              */
/* ------------------------------------------------------------------ */

const shellDescGuardrail: EvalScenario = {
  id: "shell-desc-guardrail",
  name: "run_command description discourages shell-based file edits",
  category: "shell",
  requiresApi: false,
  run: () =>
    withTiming(async () => {
      const src = readFileSync("src/tools/shell.ts", "utf8");
      const marker = "DO NOT use run_command for file operations";
      const alt1 =
        "use write_file, edit_file, multi_edit, copy_file, move_file, or delete_file instead";
      const alt2 = "Shell utilities (echo, cp, sed, cat, tee, perl, python -c";
      const hasMarker = src.includes(marker);
      const hasAlt1 = src.includes(alt1);
      const hasAlt2 = src.includes(alt2);
      if (hasMarker && hasAlt1 && hasAlt2) {
        return pass(
          "shell-desc-guardrail",
          "run_command description contains the negative guardrail against shell-based file edits.",
        );
      }
      return fail(
        "shell-desc-guardrail",
        `Missing guardrail text. marker=${hasMarker}, alt1=${hasAlt1}, alt2=${hasAlt2}`,
      );
    }),
};

/* ------------------------------------------------------------------ */
/*  #1462 — Constraint persistence across folds (local)                */
/* ------------------------------------------------------------------ */

class MockDeepSeekClient extends DeepSeekClient {
  private _replyContent: string;
  constructor(replyContent: string) {
    super({ apiKey: "sk-mock", retry: { maxAttempts: 1 } });
    this._replyContent = replyContent;
  }
  override async chat(_opts: ChatRequestOptions): Promise<ChatResponse> {
    return {
      content: this._replyContent,
      reasoningContent: "",
      toolCalls: [],
      usage: {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        promptCacheHitTokens: 0,
        promptCacheMissTokens: 100,
      },
      raw: {},
    } as ChatResponse;
  }
}

const constraintPersistence: EvalScenario = {
  id: "constraint-persistence",
  name: "Context fold preserves pinned constraints from system prompt",
  category: "context",
  requiresApi: false,
  run: () =>
    withTiming(async () => {
      const systemPrompt = `You are a coding assistant.

# HIGH PRIORITY constraints

- DO NOT use npm install without asking.
- Never delete files without confirmation.

# User memory

The user prefers TypeScript over JavaScript.

# Project memory

This project uses pnpm instead of npm.`;

      const log = new AppendOnlyLog();
      // Fill log with synthetic long history to trigger a fold boundary > 0.
      for (let i = 0; i < 40; i++) {
        log.append({
          role: "user",
          content: `Turn ${i}: Please review the codebase and tell me what you found.`,
        });
        log.append({
          role: "assistant",
          content: `Turn ${i} summary: I reviewed the codebase and found several issues including unused imports, missing type annotations, and inconsistent formatting.`,
        });
      }

      const client = new MockDeepSeekClient("Summary of all prior turns.");
      const stats = new SessionStats();
      const ctx = new ContextManager({
        client,
        log,
        stats,
        sessionName: null,
        getAbortSignal: () => new AbortController().signal,
        getCurrentTurn: () => 1,
        getSystemPrompt: () => systemPrompt,
      });

      // Use a tiny tail budget so almost everything becomes head and gets summarized.
      const result = await ctx.fold("deepseek-v4-flash", { keepRecentTokens: 200 });

      if (!result.folded) {
        return fail(
          "constraint-persistence",
          `Fold did not happen (before=${result.beforeMessages}, after=${result.afterMessages}).`,
        );
      }

      const foldedSystem = log.toMessages()[0];
      if (foldedSystem?.role !== "assistant") {
        return fail(
          "constraint-persistence",
          `Expected first folded message to be assistant summary, got ${foldedSystem?.role}.`,
        );
      }

      const content = foldedSystem.content as string;
      const checks = [
        { text: "DO NOT use npm install without asking", label: "HIGH PRIORITY constraint" },
        { text: "Never delete files without confirmation", label: "HIGH PRIORITY constraint 2" },
        { text: "TypeScript over JavaScript", label: "User memory" },
        { text: "pnpm instead of npm", label: "Project memory" },
      ];

      const missing = checks.filter((c) => !content.includes(c.text));
      if (missing.length > 0) {
        return fail(
          "constraint-persistence",
          `Folded summary missing ${missing.length} constraint(s): ${missing.map((m) => m.label).join(", ")}.`,
        );
      }

      return pass(
        "constraint-persistence",
        `Fold reduced ${result.beforeMessages} → ${result.afterMessages} messages and preserved all ${checks.length} pinned constraints.`,
      );
    }),
};

/* ------------------------------------------------------------------ */
/*  #1495 — Task integrity paragraph in system prompt (local)          */
/* ------------------------------------------------------------------ */

const systemPromptIntegrity: EvalScenario = {
  id: "system-prompt-integrity",
  name: "Code system prompt contains Task integrity guardrail",
  category: "integrity",
  requiresApi: false,
  run: () =>
    withTiming(async () => {
      const prompt = codeSystemPrompt(process.cwd(), { modelId: "deepseek-v4-flash" });
      const marker = "# Task integrity — non-negotiable";
      const rule1 = "The user's original objective and ALL constraints";
      const rule2 = "You may NOT unilaterally simplify, narrow, or change the objective";

      const hasMarker = prompt.includes(marker);
      const hasRule1 = prompt.includes(rule1);
      const hasRule2 = prompt.includes(rule2);

      if (hasMarker && hasRule1 && hasRule2) {
        return pass(
          "system-prompt-integrity",
          "Task integrity guardrail is present in the generated code system prompt.",
        );
      }
      return fail(
        "system-prompt-integrity",
        `Missing integrity text. marker=${hasMarker}, rule1=${hasRule1}, rule2=${hasRule2}`,
      );
    }),
};

/* ------------------------------------------------------------------ */
/*  #1372 — Shell tool choice E2E (needs API)                          */
/* ------------------------------------------------------------------ */

const shellToolChoiceE2E: EvalScenario = {
  id: "shell-tool-choice-e2e",
  name: "Agent prefers file tools over shell commands for edits",
  category: "shell",
  requiresApi: true,
  run: () =>
    withTiming(async () => {
      const workDir = join(tmpdir(), `reasonix-eval-shell-${Date.now()}`);
      mkdirSync(workDir, { recursive: true });
      writeFileSync(
        join(workDir, "README.md"),
        "# Hello world\n\nThis is a test project.\n",
        "utf8",
      );

      try {
        const client = new DeepSeekClient();
        const tools = new ToolRegistry();
        registerFilesystemTools(tools, { rootDir: workDir, allowWriting: true });
        registerShellTools(tools, { rootDir: workDir, allowAll: true });

        const prefix = new ImmutablePrefix({
          system: codeSystemPrompt(workDir, { modelId: "deepseek-v4-flash" }),
          toolSpecs: tools.specs(),
        });

        const loop = new CacheFirstLoop({
          client,
          prefix,
          tools,
          model: "deepseek-v4-flash",
          stream: false,
        });

        const toolCalls: { name: string; args: string }[] = [];
        const evs: any[] = [];
        for await (const ev of loop.step("把README.md里的 'world' 改成 'agent'")) {
          evs.push(ev);
          if (ev.role === "tool") {
            toolCalls.push({ name: ev.toolName ?? "?", args: ev.content ?? "" });
          }
          if (ev.role === "done") break;
        }

        const shellCalls = toolCalls.filter((t) => t.name === "run_command");
        const fileCalls = toolCalls.filter((t) =>
          ["edit_file", "write_file", "multi_edit"].includes(t.name),
        );

        if (fileCalls.length > 0 && shellCalls.length === 0) {
          return pass(
            "shell-tool-choice-e2e",
            `Agent used ${fileCalls.map((c) => c.name).join(", ")} and avoided shell commands.`,
          );
        }
        if (shellCalls.length > 0) {
          return fail(
            "shell-tool-choice-e2e",
            `Agent used run_command (${shellCalls.map((c) => c.args.slice(0, 80)).join("; ")}) instead of file tools.`,
          );
        }
        return fail("shell-tool-choice-e2e", "Agent made no tool calls in the first turn.");
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    }),
};

/* ------------------------------------------------------------------ */
/*  #1495 — Task integrity E2E (needs API)                             */
/* ------------------------------------------------------------------ */

const taskIntegrityE2E: EvalScenario = {
  id: "task-integrity-e2e",
  name: "Agent completes all steps of a multi-step task after fatigue history",
  category: "integrity",
  requiresApi: true,
  run: () =>
    withTiming(async () => {
      const workDir = join(tmpdir(), `reasonix-eval-integrity-${Date.now()}`);
      mkdirSync(workDir, { recursive: true });

      try {
        const client = new DeepSeekClient();
        const tools = new ToolRegistry();
        registerFilesystemTools(tools, { rootDir: workDir, allowWriting: true });
        registerShellTools(tools, { rootDir: workDir, allowAll: true });

        const prefix = new ImmutablePrefix({
          system: codeSystemPrompt(workDir, { modelId: "deepseek-v4-flash" }),
          toolSpecs: tools.specs(),
        });

        const loop = new CacheFirstLoop({
          client,
          prefix,
          tools,
          model: "deepseek-v4-flash",
          stream: false,
        });

        // Inject fatigue history — 30 prior turns so the model feels context pressure.
        for (let i = 0; i < 30; i++) {
          loop.log.append({
            role: "user",
            content: `Task ${i + 1}: Review file src/utils/${i}.ts and tell me if it has any issues.`,
          } as ChatMessage);
          loop.log.append({
            role: "assistant",
            content: `I reviewed src/utils/${i}.ts. No issues found — code is clean and well-typed.`,
          } as ChatMessage);
        }

        writeFileSync(join(workDir, "data.json"), '{"name":"Alice","age":30}\n', "utf8");

        const prompt =
          "Create a Node.js script called app.js that does ALL of the following:\n" +
          "1. Reads data.json using the fs module\n" +
          "2. Validates the parsed object has BOTH 'name' and 'age' properties (throw an error if either is missing)\n" +
          "3. Prints a greeting: console.log(`Hello, ${name}! You are ${age} years old.`)\n" +
          "Do NOT skip any step. Do NOT ask me if you can simplify. Implement ALL three requirements in one file.";

        const maxTurns = 10;
        let turns = 0;
        let lastAssistantText = "";

        while (turns < maxTurns) {
          const userMsg =
            turns === 0
              ? prompt
              : "Continue and implement ALL three requirements. Do not skip any step.";

          for await (const ev of loop.step(userMsg)) {
            if (ev.role === "assistant_final") {
              lastAssistantText = ev.content ?? "";
            }
            if (ev.role === "done") {
              lastAssistantText = ev.content ?? lastAssistantText;
            }
            if (ev.role === "error") {
              return fail("task-integrity-e2e", `Loop error on turn ${turns + 1}: ${ev.error}`);
            }
          }
          turns++;

          // Check if app.js exists and is complete.
          const appPath = join(workDir, "app.js");
          if (existsSync(appPath)) {
            const content = readFileSync(appPath, "utf8");
            const hasRead =
              content.includes("readFile") ||
              content.includes("readFileSync") ||
              content.includes("require('fs')") ||
              content.includes('require("fs")');
            const hasValidate =
              content.includes("throw") && content.includes("name") && content.includes("age");
            const hasGreeting = content.includes("Hello") && content.includes("console.log");
            if (hasRead && hasValidate && hasGreeting) {
              return pass(
                "task-integrity-e2e",
                `Agent completed all 3 requirements in app.js after ${turns} turn(s) with ${loop.log.length} messages in context.`,
              );
            }
          }
        }

        // Final verdict.
        const appPath = join(workDir, "app.js");
        if (!existsSync(appPath)) {
          return fail(
            "task-integrity-e2e",
            `Agent did not create app.js after ${turns} turns. Last response: "${lastAssistantText.slice(0, 200)}"`,
          );
        }

        const content = readFileSync(appPath, "utf8");
        const checks = [
          {
            name: "read JSON (fs.readFile)",
            found:
              content.includes("readFile") ||
              content.includes("readFileSync") ||
              content.includes("require('fs')") ||
              content.includes('require("fs")'),
          },
          {
            name: "validate fields (throw + name + age)",
            found: content.includes("throw") && content.includes("name") && content.includes("age"),
          },
          {
            name: "print greeting (Hello + console.log)",
            found: content.includes("Hello") && content.includes("console.log"),
          },
        ];
        const missing = checks.filter((c) => !c.found);

        // Also check for narrowing language in the final assistant text.
        const lower = lastAssistantText.toLowerCase();
        const narrowingPhrases = [
          "to save tokens",
          "to save time",
          "for efficiency",
          "i'll just do",
          "i will only",
          "to keep it simple",
          "simplified version",
          "i'll skip",
          "not necessary",
        ];
        const foundNarrowing = narrowingPhrases.filter((p) => lower.includes(p));

        if (missing.length > 0) {
          return fail(
            "task-integrity-e2e",
            `Agent created app.js but missing ${missing.length} requirement(s) after ${turns} turns: ${missing.map((m) => m.name).join(", ")}. ` +
              (foundNarrowing.length > 0
                ? `Also used narrowing language: "${foundNarrowing.join(", ")}".`
                : ""),
          );
        }

        return pass(
          "task-integrity-e2e",
          `Agent created app.js with all requirements after ${turns} turn(s).`,
        );
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    }),
};

/* ------------------------------------------------------------------ */
/*  Exports                                                            */
/* ------------------------------------------------------------------ */

export const LOCAL_SCENARIOS: EvalScenario[] = [
  shellDescGuardrail,
  constraintPersistence,
  systemPromptIntegrity,
];

export const API_SCENARIOS: EvalScenario[] = [shellToolChoiceE2E, taskIntegrityE2E];

export const ALL_SCENARIOS: EvalScenario[] = [...LOCAL_SCENARIOS, ...API_SCENARIOS];
