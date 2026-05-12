/**
 * CrofAI Provider Tests
 *
 * Two kinds of tests:
 *   A) Extension unit test — verifies the extension factory registers a provider.
 *   B) API integration tests — hit the live CrofAI endpoint.
 *
 * Run: npx tsx test.ts
 * API key lookup order:
 *   1) CROF_API_KEY env var
 *   2) ~/.pi/agent/auth.json -> crof.key
 */

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// A) Extension factory test (no live API calls)
// ---------------------------------------------------------------------------

async function testExtensionFactory() {
	console.log("\n--- [A] Extension factory registers provider ---");

	// Mock ExtensionAPI that captures registerProvider calls.
	let capturedProviderName: string | undefined;
	let capturedConfig: unknown = null;

	const mockPi = {
		registerProvider(name: string, config: unknown) {
			capturedProviderName = name;
			capturedConfig = config;
		},
	} as Parameters<typeof import("./index.ts").default>[0];

	// Dynamic import with mocked fetch so we don't hit the live API.
	const origFetch = globalThis.fetch;
	globalThis.fetch = async (url: RequestInfo | URL) => {
		const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
		if (urlStr.includes("/v1/models")) {
			return new Response(JSON.stringify({
				data: [
					{
						id: "captured-test-model",
						name: "Test: Captured Model",
						context_length: 4096,
						max_completion_tokens: 1024,
						pricing: { prompt: "0.01", completion: "0.02", cache_prompt: "0.001" },
						custom_reasoning: false,
						reasoning_effort: false,
					},
				],
			}), { status: 200, headers: { "content-type": "application/json" } });
		}
		throw new Error(`Unexpected fetch: ${urlStr}`);
	};

	let loadError: unknown;
	try {
		const mod = await import("./index.ts");
		const factory = mod.default as (pi: typeof mockPi) => Promise<void> | void;
		await factory(mockPi);
	} catch (err) {
		loadError = err;
	} finally {
		globalThis.fetch = origFetch;
	}

	if (loadError) throw new Error(`Extension factory threw: ${loadError}`);

	if (capturedProviderName !== "crof") throw new Error(`Expected provider "crof", got ${capturedProviderName}`);
	if (!capturedConfig) throw new Error("registerProvider was not called");

	const config = capturedConfig as Record<string, unknown>;
	if (!Array.isArray(config.models)) throw new Error("Expected config.models to be an array");
	if (config.models.length < 1) throw new Error("Expected at least one model");

	const model = config.models[0] as Record<string, unknown>;
	if (model.id !== "captured-test-model") throw new Error(`Expected captured-test-model, got ${model.id}`);
	if (!model.cost) throw new Error("Model missing cost");
	if (!model.contextWindow) throw new Error("Model missing contextWindow");

	console.log(`  Provider: ${capturedProviderName}`);
	console.log(`  Models: ${config.models.length}`);
	console.log(`  API: ${config.api}`);
	console.log(`  First model: ${model.id}`);
	console.log("  PASS");
}

// ---------------------------------------------------------------------------
// B) API integration tests
// ---------------------------------------------------------------------------

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

function isPrecision(id: string): boolean {
	return id.endsWith("-precision");
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
		signal: AbortSignal.timeout(30_000),
		headers: { Authorization: `Bearer ${apiKey}` },
	});
	if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);

	const data = (await res.json()) as { data: ModelInfo[] };
	return data.data;
}

async function testListModels(apiKey: string): Promise<ModelInfo[]> {
	console.log("\n--- [B1] GET /v1/models ---");
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
	console.log("\n--- [B2] POST /chat/completions (non-streaming) ---");

	const candidates = [...new Set([
		...["minimax-m2.5", "deepseek-v3.2", "glm-5"].filter((id) => models.some((m) => m.id === id)),
		...models.filter(m => !isPrecision(m.id)).map(m => m.id).slice(0, 3),
	])].filter((id): id is string => Boolean(id));

	let lastError: Error | null = null;

	for (const modelId of candidates) {
		console.log(`  Trying model: ${modelId}`);

		const res = await fetch(`${BASE_URL}/chat/completions`, {
			signal: AbortSignal.timeout(30_000),
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
	console.log("\n--- [B3] POST /chat/completions (streaming) ---");

	const modelId = pickModel(models, ["deepseek-v4-flash", "minimax-m2.5", "kimi-k2.5"]);
	console.log(`  Model: ${modelId}`);

	const res = await fetch(`${BASE_URL}/chat/completions`, {
		signal: AbortSignal.timeout(60_000),
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
	console.log("\n--- [B4] Reasoning model (reasoning_effort=low) ---");

	const modelId = pickModel(models, ["deepseek-v4-flash", "kimi-k2.6", "qwen3.6-27b"]);
	console.log(`  Model: ${modelId}`);

	const res = await fetch(`${BASE_URL}/chat/completions`, {
		signal: AbortSignal.timeout(60_000),
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
	console.log("\n--- [B5] GET /usage_api/ ---");

	const res = await fetch("https://crof.ai/usage_api/", {
		signal: AbortSignal.timeout(15_000),
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

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const apiKey = await resolveApiKey();
	if (!apiKey) {
		console.error("Missing API key: set CROF_API_KEY or add crof.key to ~/.pi/agent/auth.json");
		process.exit(1);
	}

	console.log(`CrofAI Tests — ${BASE_URL}`);

	type TestEntry = { name: string; fn: () => Promise<void> };

	// Group A — unit test (no live API needed)
	const groupA: TestEntry[] = [
		{ name: "extension-factory", fn: testExtensionFactory },
	];

	// Group B — live API integration
	const models = await testListModels(apiKey);
	const groupB: TestEntry[] = [
		{ name: "non-streaming", fn: () => testNonStreaming(apiKey, models) },
		{ name: "streaming", fn: () => testStreaming(apiKey, models) },
		{ name: "reasoning", fn: () => testReasoning(apiKey, models) },
		{ name: "usage", fn: () => testUsageApi(apiKey) },
	];

	const allTests = [...groupA, ...groupB];
	let passed = 0;
	let failed = 0;

	for (const { name, fn } of allTests) {
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
