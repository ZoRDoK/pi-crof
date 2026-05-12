/**
 * CrofAI Provider for pi
 *
 * OpenAI-compatible provider at https://crof.ai/v1.
 * No custom streaming needed — delegates to built-in openai-completions.
 *
 * Usage:
 *   # Place in .pi/extensions/crof-provider/ (auto-discovered)
 *   # Set CROF_API_KEY env var, or add key to ~/.pi/agent/auth.json as "crof"
 *   # Then /model crof/<model-id>
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// =============================================================================
// Models — synced from GET https://crof.ai/v1/models on 2026-05-12
// =============================================================================

interface CrofModel {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
}

const MODELS: CrofModel[] = [
	// DeepSeek V4 family
	{
		id: "deepseek-v4-pro",
		name: "DeepSeek V4 Pro",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.4, output: 0.85, cacheRead: 0.003, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 131_072,
	},
	{
		id: "deepseek-v4-pro-precision",
		name: "DeepSeek V4 Pro (Precision)",
		reasoning: true,
		input: ["text"],
		cost: { input: 1.25, output: 2.5, cacheRead: 0.1, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 131_072,
	},
	{
		id: "deepseek-v4-flash",
		name: "DeepSeek V4 Flash",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.12, output: 0.21, cacheRead: 0.02, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 131_072,
	},
	{
		id: "deepseek-v3.2",
		name: "DeepSeek V3.2",
		reasoning: false,
		input: ["text"],
		cost: { input: 0.28, output: 0.38, cacheRead: 0.06, cacheWrite: 0 },
		contextWindow: 163_840,
		maxTokens: 163_840,
	},

	// MiMo family
	{
		id: "mimo-v2.5-pro",
		name: "MiMo V2.5 Pro",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.5, output: 1.5, cacheRead: 0.1, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 131_072,
	},
	{
		id: "mimo-v2.5-pro-precision",
		name: "MiMo V2.5 Pro (Precision)",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.8, output: 2.5, cacheRead: 0.16, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 131_072,
	},

	// GLM family
	{
		id: "glm-5.1",
		name: "GLM 5.1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.45, output: 2.1, cacheRead: 0.09, cacheWrite: 0 },
		contextWindow: 202_752,
		maxTokens: 202_752,
	},
	{
		id: "glm-5.1-precision",
		name: "GLM 5.1 (Precision)",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.75, output: 2.9, cacheRead: 0.15, cacheWrite: 0 },
		contextWindow: 202_752,
		maxTokens: 202_752,
	},
	{
		id: "glm-5",
		name: "GLM 5",
		reasoning: false,
		input: ["text"],
		cost: { input: 0.48, output: 1.9, cacheRead: 0.1, cacheWrite: 0 },
		contextWindow: 202_752,
		maxTokens: 202_752,
	},
	{
		id: "glm-4.7",
		name: "GLM 4.7",
		reasoning: false,
		input: ["text"],
		cost: { input: 0.25, output: 1.1, cacheRead: 0.05, cacheWrite: 0 },
		contextWindow: 202_752,
		maxTokens: 202_752,
	},
	{
		id: "glm-4.7-flash",
		name: "GLM 4.7 Flash",
		reasoning: false,
		input: ["text"],
		cost: { input: 0.04, output: 0.3, cacheRead: 0.008, cacheWrite: 0 },
		contextWindow: 202_752,
		maxTokens: 131_072,
	},

	// Kimi family
	{
		id: "kimi-k2.6",
		name: "Kimi K2.6",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.5, output: 1.99, cacheRead: 0.1, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 262_144,
	},
	{
		id: "kimi-k2.6-precision",
		name: "Kimi K2.6 (Precision)",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.55, output: 2.7, cacheRead: 0.11, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 262_144,
	},
	{
		id: "kimi-k2.5",
		name: "Kimi K2.5",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.35, output: 1.7, cacheRead: 0.07, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 262_144,
	},
	{
		id: "kimi-k2.5-lightning",
		name: "Kimi K2.5 Lightning",
		reasoning: true,
		input: ["text"],
		cost: { input: 1.0, output: 3.0, cacheRead: 0.2, cacheWrite: 0 },
		contextWindow: 131_072,
		maxTokens: 32_768,
	},

	// Qwen family
	{
		id: "qwen3.6-27b",
		name: "Qwen 3.6 27B",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.2, output: 1.5, cacheRead: 0.04, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 262_144,
	},
	{
		id: "qwen3.5-397b-a17b",
		name: "Qwen 3.5 397B-A17B",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.35, output: 1.75, cacheRead: 0.07, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 262_144,
	},
	{
		id: "qwen3.5-9b",
		name: "Qwen 3.5 9B",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.04, output: 0.15, cacheRead: 0.008, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 262_144,
	},
	{
		id: "qwen3.5-9b-chat",
		name: "Qwen 3.5 9B Chat",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.04, output: 0.15, cacheRead: 0.008, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 262_144,
	},

	// Others
	{
		id: "gemma-4-31b-it",
		name: "Gemma 4 31B",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.1, output: 0.3, cacheRead: 0.02, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 262_144,
	},
	{
		id: "minimax-m2.5",
		name: "MiniMax M2.5",
		reasoning: false,
		input: ["text"],
		cost: { input: 0.11, output: 0.95, cacheRead: 0.02, cacheWrite: 0 },
		contextWindow: 204_800,
		maxTokens: 131_072,
	},
	{
		id: "greg",
		name: "Greg (Experimental)",
		reasoning: false,
		input: ["text"],
		cost: { input: 0.3, output: 0.3, cacheRead: 0.06, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 200_000,
	},
];

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
	pi.registerProvider("crof", {
		baseUrl: "https://crof.ai/v1",
		apiKey: "CROF_API_KEY",
		api: "openai-completions",
		models: MODELS.map(({ id, name, reasoning, input, cost, contextWindow, maxTokens }) => ({
			id,
			name: `CrofAI: ${name}`,
			reasoning,
			input,
			cost,
			contextWindow,
			maxTokens,
		})),
	});
}
