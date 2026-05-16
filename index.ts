/**
 * CrofAI Provider for pi
 *
 * OpenAI-compatible provider at https://crof.ai/v1.
 * No custom streaming needed — delegates to built-in openai-completions.
 *
 * Features:
 * - Dynamic model discovery from https://crof.ai/v1/models
 * - Persistent disk cache (~/.pi/agent/cache/pi-crof/models.json, TTL 1h)
 * - Graceful degradation: cache → static fallback on API failure
 * - Fetch timeouts (10s for models, 30s for chat)
 *
 * Usage:
 *   # pi install git:git@github.com:ZoRDoK/pi-crof.git
 *   # Set CROF_API_KEY env var, or add key to ~/.pi/agent/auth.json as "crof"
 *   # Then /model crof/<model-id>
 */

import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { readCache, writeCache, type CrofCacheEntry } from "./src/cache.ts";

// =============================================================================
// Constants
// =============================================================================

const BASE_URL = "https://crof.ai/v1";
const FETCH_TIMEOUT_MS = 10_000;

// =============================================================================
// Vision-supporting models — sourced from crof.ai/pricing
// =============================================================================

const VISION_MODELS = new Set([
	"kimi-k2.6",
	"kimi-k2.6-precision",
	"kimi-k2.5",
	"kimi-k2.5-lightning",
	"qwen3.6-27b",
	"qwen3.5-397b-a17b",
	"gemma-4-31b-it",
	"qwen3.5-9b",
	"qwen3.5-9b-chat",
]);

// =============================================================================
// Fallback seed models — used when the API is unreachable and no cache exists
// =============================================================================

const FALLBACK_MODELS: ProviderModelConfig[] = [
	{ id: "deepseek-v4-pro-precision",       name: "CrofAI: DeepSeek V4 Pro (Precision)",  reasoning: true,  input: ["text"], cost: { input: 1.25, output: 2.5,  cacheRead: 0.1,   cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 131_072 },
	{ id: "deepseek-v4-flash",               name: "CrofAI: DeepSeek V4 Flash",            reasoning: true,  input: ["text"], cost: { input: 0.12, output: 0.21, cacheRead: 0.02,  cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 131_072 },
	{ id: "deepseek-v3.2",                   name: "CrofAI: DeepSeek V3.2",                reasoning: false, input: ["text"], cost: { input: 0.28, output: 0.38, cacheRead: 0.06,  cacheWrite: 0 }, contextWindow: 163_840,   maxTokens: 163_840 },
	{ id: "glm-5.1-precision",               name: "CrofAI: GLM 5.1 (Precision)",          reasoning: true,  input: ["text"], cost: { input: 0.75, output: 2.9,  cacheRead: 0.15,  cacheWrite: 0 }, contextWindow: 202_752,   maxTokens: 202_752 },
	{ id: "glm-5.1",                         name: "CrofAI: GLM 5.1",                      reasoning: true,  input: ["text"], cost: { input: 0.45, output: 2.1,  cacheRead: 0.09,  cacheWrite: 0 }, contextWindow: 202_752,   maxTokens: 202_752 },
	{ id: "kimi-k2.6-precision",             name: "CrofAI: Kimi K2.6 (Precision)",        reasoning: true,  input: ["text", "image"], cost: { input: 0.55, output: 2.7,  cacheRead: 0.11,  cacheWrite: 0 }, contextWindow: 262_144,   maxTokens: 262_144 },
	{ id: "kimi-k2.6",                       name: "CrofAI: Kimi K2.6",                    reasoning: true,  input: ["text", "image"], cost: { input: 0.5,  output: 1.99, cacheRead: 0.1,   cacheWrite: 0 }, contextWindow: 262_144,   maxTokens: 262_144 },
	{ id: "kimi-k2.5",                       name: "CrofAI: Kimi K2.5",                    reasoning: true,  input: ["text", "image"], cost: { input: 0.35, output: 1.7,  cacheRead: 0.07,  cacheWrite: 0 }, contextWindow: 262_144,   maxTokens: 262_144 },
	{ id: "mimo-v2.5-pro-precision",         name: "CrofAI: MiMo V2.5 Pro (Precision)",    reasoning: true,  input: ["text"], cost: { input: 0.8,  output: 2.5,  cacheRead: 0.16,  cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 131_072 },
	{ id: "mimo-v2.5-pro",                   name: "CrofAI: MiMo V2.5 Pro",                reasoning: true,  input: ["text"], cost: { input: 0.5,  output: 1.5,  cacheRead: 0.1,   cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 131_072 },
	{ id: "minimax-m2.5",                    name: "CrofAI: MiniMax M2.5",                 reasoning: false, input: ["text"], cost: { input: 0.11, output: 0.95, cacheRead: 0.02,  cacheWrite: 0 }, contextWindow: 204_800,   maxTokens: 131_072 },
	{ id: "qwen3.6-27b",                     name: "CrofAI: Qwen 3.6 27B",                 reasoning: true,  input: ["text", "image"], cost: { input: 0.2,  output: 1.5,  cacheRead: 0.04,  cacheWrite: 0 }, contextWindow: 262_144,   maxTokens: 262_144 },
	{ id: "qwen3.5-397b-a17b",               name: "CrofAI: Qwen 3.5 397B-A17B",           reasoning: true,  input: ["text", "image"], cost: { input: 0.35, output: 1.75, cacheRead: 0.07,  cacheWrite: 0 }, contextWindow: 262_144,   maxTokens: 262_144 },
	{ id: "gemma-4-31b-it",                  name: "CrofAI: Gemma 4 31B",                  reasoning: true,  input: ["text", "image"], cost: { input: 0.1,  output: 0.3,  cacheRead: 0.02,  cacheWrite: 0 }, contextWindow: 262_144,   maxTokens: 262_144 },
	{ id: "deepseek-v4-pro",                 name: "CrofAI: DeepSeek V4 Pro",              reasoning: true,  input: ["text"], cost: { input: 0.4,  output: 0.85, cacheRead: 0.003, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 131_072 },
	{ id: "kimi-k2.5-lightning",             name: "CrofAI: Kimi K2.5 Lightning",          reasoning: true,  input: ["text", "image"], cost: { input: 1.0,  output: 3.0,  cacheRead: 0.2,   cacheWrite: 0 }, contextWindow: 131_072,   maxTokens: 32_768 },
	{ id: "qwen3.5-9b",                      name: "CrofAI: Qwen 3.5 9B",                  reasoning: true,  input: ["text", "image"], cost: { input: 0.04, output: 0.15, cacheRead: 0.008, cacheWrite: 0 }, contextWindow: 262_144,   maxTokens: 262_144 },
	{ id: "qwen3.5-9b-chat",                 name: "CrofAI: Qwen 3.5 9B Chat",             reasoning: true,  input: ["text", "image"], cost: { input: 0.04, output: 0.15, cacheRead: 0.008, cacheWrite: 0 }, contextWindow: 262_144,   maxTokens: 262_144 },
];

// =============================================================================
// Dynamic model fetching with timeout
// =============================================================================

function modelInput(id: string): ("text" | "image")[] {
	return VISION_MODELS.has(id) ? ["text", "image"] : ["text"];
}

function mapApiModel(m: CrofCacheEntry): ProviderModelConfig {
	const reasoning = !!(m.custom_reasoning || m.reasoning_effort);
	return {
		id: m.id,
		name: `CrofAI: ${m.name.replace(/^[^:]+:\s*/, "")}`,
		reasoning,
		input: modelInput(m.id),
		cost: {
			input: parseFloat(m.pricing.prompt) || 0,
			output: parseFloat(m.pricing.completion) || 0,
			cacheRead: m.pricing.cache_prompt ? parseFloat(m.pricing.cache_prompt) : 0,
			cacheWrite: 0,
		},
		contextWindow: m.context_length,
		maxTokens: m.max_completion_tokens,
	};
}

/**
 * Fetch raw model data from the API with timeout.
 * Returns the raw cache entries (suitable for caching) and the mapped provider models.
 */
async function fetchRawModels(): Promise<{
	raw: CrofCacheEntry[];
	models: ProviderModelConfig[];
}> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(`${BASE_URL}/models`, { signal: controller.signal });
		if (!res.ok) throw new Error(`API returned ${res.status}`);

		const body = (await res.json()) as { data?: CrofCacheEntry[] };
		if (!body.data || !Array.isArray(body.data) || body.data.length === 0) {
			throw new Error("API returned empty model list");
		}

		return {
			raw: body.data,
			models: body.data.map(mapApiModel),
		};
	} finally {
		clearTimeout(timeout);
	}
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default async function (pi: ExtensionAPI) {
	let models: ProviderModelConfig[];
	let source: "api" | "cache" | "fallback" = "fallback";

	try {
		// 1. Try cache first
		const cached = readCache();
		if (cached) {
			models = cached.models.map(mapApiModel);
			source = "cache";
			console.log(`[pi-crof] Loaded ${models.length} models from cache`);
		} else {
			// 2. No cache or expired — fetch from API and persist
			const { raw, models: freshModels } = await fetchRawModels();
			models = freshModels;
			writeCache({ timestamp: Date.now(), models: raw });
			source = "api";
			console.log(`[pi-crof] Fetched ${models.length} models from API`);
		}
	} catch (error) {
		// 3. API failed — try stale cache
		const stale = readCache({ ignoreTTL: true });
		if (stale) {
			models = stale.models.map(mapApiModel);
			source = "cache";
			console.warn(`[pi-crof] API failed, using stale cache (${models.length} models):`, error instanceof Error ? error.message : String(error));
		} else {
			// 4. Nothing works — use static fallback
			models = FALLBACK_MODELS;
			source = "fallback";
			console.error(`[pi-crof] API failed and no cache available, using static fallback (${models.length} models):`, error instanceof Error ? error.message : String(error));
		}
	}

	pi.registerProvider("crof", {
		baseUrl: BASE_URL,
		apiKey: "CROF_API_KEY",
		api: "openai-completions",
		models,
	});

	console.log(`[pi-crof] Registered provider "crof" with ${models.length} models (source: ${source})`);
}
