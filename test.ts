/**
 * CrofAI Provider Tests
 *
 * Run: npx tsx test.ts
 * API key lookup order:
 *   1) CROF_API_KEY env var
 *   2) ~/.pi/agent/auth.json -> crof.key
 */

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const BASE_URL = "https://crof.ai/v1";

type ModelInfo = {
  id: string;
  context_length: number;
  max_completion_tokens: number;
  pricing: { prompt: string; completion: string; cache_prompt?: string };
};

type DeltaPayload = {
  choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>;
  error?: { message?: string };
};

async function resolveApiKey(): Promise<string> {
  if (process.env.CROF_API_KEY) return process.env.CROF_API_KEY;

  const authPath = path.join(os.homedir(), ".pi/agent/auth.json");
  try {
    const raw = await readFile(authPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, { key?: string }>;
    const key = parsed.crof?.key;
    if (typeof key === "string" && key.length > 0) return key;
  } catch {
    // fall through
  }

  return "";
}

function pickModel(models: ModelInfo[], preferred: string[]): string {
  for (const id of preferred) {
    if (models.some((m) => m.id === id)) return id;
  }
  if (models.length === 0) throw new Error("No models available");
  return models[0].id;
}

async function* readSseDataLines(response: Response): AsyncGenerator<string> {
  if (!response.body) throw new Error("Streaming response has no body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });

    // Normalize CRLF so we can split reliably on SSE block delimiters.
    buffer = buffer.replace(/\r\n/g, "\n");

    let separatorIndex = buffer.indexOf("\n\n");
    while (separatorIndex !== -1) {
      const block = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);

      const dataLines = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart());

      if (dataLines.length > 0) {
        yield dataLines.join("\n");
      }

      separatorIndex = buffer.indexOf("\n\n");
    }

    if (done) break;
  }

  const tail = buffer.trim();
  if (tail.length > 0) {
    const dataLines = tail
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length > 0) {
      yield dataLines.join("\n");
    }
  }
}

async function fetchModels(apiKey: string): Promise<ModelInfo[]> {
  const res = await fetch(`${BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);

  const data = (await res.json()) as { data: ModelInfo[] };
  return data.data;
}

async function testListModels(apiKey: string): Promise<ModelInfo[]> {
  console.log("\n--- Test 1: GET /v1/models ---");
  const models = await fetchModels(apiKey);

  console.log(`  Got ${models.length} models`);
  if (models.length === 0) throw new Error("Empty model list");

  for (const m of models) {
    if (!m.id) throw new Error("Model missing id");
    if (!m.context_length || m.context_length < 1024) throw new Error(`Model ${m.id}: bad context_length`);
    if (!m.max_completion_tokens || m.max_completion_tokens < 1)
      throw new Error(`Model ${m.id}: bad max_completion_tokens`);
    if (m.pricing?.prompt == null) throw new Error(`Model ${m.id}: missing pricing.prompt`);
    if (m.pricing?.completion == null) throw new Error(`Model ${m.id}: missing pricing.completion`);
  }

  console.log("  PASS");
  return models;
}

async function testNonStreaming(apiKey: string, models: ModelInfo[]): Promise<void> {
  console.log("\n--- Test 2: POST /chat/completions (non-streaming) ---");

  const candidates = [...new Set([
    ...["minimax-m2.5", "deepseek-v3.2", "glm-5"].filter((id) => models.some((m) => m.id === id)),
    models[0]?.id,
  ])].filter((id): id is string => Boolean(id));

  let lastError: Error | null = null;

  for (const modelId of candidates) {
    console.log(`  Trying model: ${modelId}`);

    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "Say hello in one short sentence." }],
        max_tokens: 64,
        temperature: 0,
      }),
    });

    if (!res.ok) {
      lastError = new Error(`${res.status}: ${await res.text()}`);
      continue;
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
      usage?: { total_tokens?: number };
    };

    const message = data.choices?.[0]?.message;
    const text = (message?.content ?? message?.reasoning_content ?? "").trim();

    if (!text) {
      lastError = new Error(`Empty response text for ${modelId}`);
      continue;
    }

    if (!data.usage?.total_tokens || data.usage.total_tokens < 1) {
      lastError = new Error(`Missing usage.total_tokens for ${modelId}`);
      continue;
    }

    console.log(`  Model: ${modelId}`);
    console.log(`  Response: "${text.slice(0, 80)}"`);
    console.log("  PASS");
    return;
  }

  throw lastError ?? new Error("All non-streaming candidate models failed");
}

async function testStreaming(apiKey: string, models: ModelInfo[]): Promise<void> {
  console.log("\n--- Test 3: POST /chat/completions (streaming) ---");

  const modelId = pickModel(models, ["deepseek-v4-flash", "minimax-m2.5", "kimi-k2.5"]);
  console.log(`  Model: ${modelId}`);

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: "user", content: "Count from 1 to 3." }],
      max_tokens: 64,
      temperature: 0,
      stream: true,
    }),
  });

  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);

  let fullText = "";
  let chunks = 0;

  for await (const payload of readSseDataLines(res)) {
    if (payload === "[DONE]") continue;

    const parsed = JSON.parse(payload) as DeltaPayload;
    if (parsed.error) throw new Error(`Stream error: ${parsed.error.message ?? "unknown"}`);

    const delta = parsed.choices?.[0]?.delta;
    const text = delta?.content ?? delta?.reasoning_content;
    if (text) {
      fullText += text;
      chunks++;
    }
  }

  console.log(`  Chunks: ${chunks}, Text: "${fullText.trim().slice(0, 80)}"`);
  if (chunks < 1) throw new Error("No streaming chunks received");
  if (!fullText.trim()) throw new Error("Streaming output empty");

  console.log("  PASS");
}

async function testReasoning(apiKey: string, models: ModelInfo[]): Promise<void> {
  console.log("\n--- Test 4: Reasoning model (reasoning_effort=low) ---");

  const modelId = pickModel(models, ["deepseek-v4-flash", "kimi-k2.6", "qwen3.6-27b"]);
  console.log(`  Model: ${modelId}`);

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: "user", content: "What is 2+2? Answer with just the number." }],
      max_tokens: 128,
      temperature: 0,
      reasoning_effort: "low",
      stream: true,
    }),
  });

  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);

  let hasReasoning = false;
  let hasContent = false;

  for await (const payload of readSseDataLines(res)) {
    if (payload === "[DONE]") continue;

    const parsed = JSON.parse(payload) as DeltaPayload;
    if (parsed.error) throw new Error(`Stream error: ${parsed.error.message ?? "unknown"}`);

    const delta = parsed.choices?.[0]?.delta;
    if (delta?.reasoning_content) hasReasoning = true;
    if (delta?.content) hasContent = true;
  }

  console.log(`  Reasoning: ${hasReasoning}, Content: ${hasContent}`);
  if (!hasReasoning && !hasContent) throw new Error("Neither reasoning nor content received");

  console.log("  PASS");
}

async function testUsageApi(apiKey: string): Promise<void> {
  console.log("\n--- Test 5: GET /usage_api/ ---");

  const res = await fetch("https://crof.ai/usage_api/", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    console.log(`  SKIP (${res.status})`);
    return;
  }

  const data = (await res.json()) as { usable_requests?: unknown; credits?: number };
  console.log(`  Credits: ${data.credits}, Requests left: ${data.usable_requests}`);

  if (typeof data.credits !== "number") throw new Error("Missing numeric credits");
  console.log("  PASS");
}

async function main(): Promise<void> {
  const apiKey = await resolveApiKey();
  if (!apiKey) {
    console.error("Missing API key: set CROF_API_KEY or add crof.key to ~/.pi/agent/auth.json");
    process.exit(1);
  }

  console.log(`CrofAI Tests — ${BASE_URL}`);

  const models = await testListModels(apiKey);

  const tests: Array<{ name: string; fn: () => Promise<void> }> = [
    { name: "non-streaming", fn: () => testNonStreaming(apiKey, models) },
    { name: "streaming", fn: () => testStreaming(apiKey, models) },
    { name: "reasoning", fn: () => testReasoning(apiKey, models) },
    { name: "usage", fn: () => testUsageApi(apiKey) },
  ];

  let passed = 0;
  let failed = 0;

  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
    } catch (error) {
      console.error(`  FAIL [${name}]:`, error);
      failed++;
    }
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
