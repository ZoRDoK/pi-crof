/**
 * Persistent cache for CrofAI model discovery.
 *
 * Stores the /v1/models response at ~/.pi/agent/cache/pi-crof/models.json
 * with a configurable TTL.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// --- Types ---

export interface CrofCacheEntry {
	id: string;
	name: string;
	context_length: number;
	max_completion_tokens: number;
	pricing: {
		prompt: string;
		completion: string;
		cache_prompt?: string;
	};
	custom_reasoning?: boolean;
	reasoning_effort?: boolean;
}

export interface CrofCacheData {
	timestamp: number;
	models: CrofCacheEntry[];
}

// --- Paths ---

function getCacheDir(): string {
	return join(getAgentDir(), "cache", "pi-crof");
}

function getCacheFile(): string {
	return join(getCacheDir(), "models.json");
}

// --- I/O ---

/**
 * Read cached model data.
 * Returns null if the cache doesn't exist, is unreadable, or has expired.
 *
 * @param options.ignoreTTL - if true, returns expired cache as well (offline mode)
 */
export function readCache(options?: { ignoreTTL?: boolean }): CrofCacheData | null {
	try {
		const file = getCacheFile();
		if (!existsSync(file)) return null;
		const raw = readFileSync(file, "utf-8");
		const data = JSON.parse(raw) as CrofCacheData;
		if (!options?.ignoreTTL && Date.now() - data.timestamp > CACHE_TTL_MS) return null;
		return data;
	} catch {
		return null;
	}
}

/**
 * Write model data to the cache file.
 * Silently ignores errors (cache is non-critical).
 */
export function writeCache(data: CrofCacheData): void {
	try {
		const dir = getCacheDir();
		mkdirSync(dir, { recursive: true });
		writeFileSync(getCacheFile(), JSON.stringify(data, null, 2));
	} catch {
		// Cache writes are best-effort
	}
}

/**
 * Get human-readable info about the current cache state.
 */
export function getCacheInfo(): {
	exists: boolean;
	age: string | null;
	size: string | null;
	modelCount: number;
} {
	const file = getCacheFile();
	if (!existsSync(file)) {
		return { exists: false, age: null, size: null, modelCount: 0 };
	}
	try {
		const raw = readFileSync(file, "utf-8");
		const data = JSON.parse(raw) as CrofCacheData;
		const ageMs = Date.now() - data.timestamp;
		const minutes = Math.floor(ageMs / 60000);
		const hours = Math.floor(minutes / 60);
		const age = hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
		const sizeBytes = Buffer.byteLength(raw);
		const size = sizeBytes > 1024 ? `${(sizeBytes / 1024).toFixed(1)} KB` : `${sizeBytes} B`;

		return {
			exists: true,
			age,
			size,
			modelCount: data.models.length,
		};
	} catch {
		return { exists: false, age: null, size: null, modelCount: 0 };
	}
}
