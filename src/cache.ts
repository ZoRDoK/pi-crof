/**
 * Persistent cache for CrofAI model discovery.
 *
 * Stores the /v1/models response at ~/.pi/agent/cache/pi-crof/models.json
 * with a configurable TTL.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

/**
 * Get the cache directory path. Exported so tests can override via env var.
 */
export function getCacheDir(): string {
	if (process.env.PI_CROF_CACHE_DIR) return process.env.PI_CROF_CACHE_DIR;
	return join(getAgentDir(), "cache", "pi-crof");
}

function getCacheFile(): string {
	return join(getCacheDir(), "models.json");
}

// --- Validation ---

function isValidCacheData(data: unknown): data is CrofCacheData {
	if (typeof data !== "object" || data === null) return false;
	const d = data as Record<string, unknown>;
	if (typeof d.timestamp !== "number" || !isFinite(d.timestamp)) return false;
	if (!Array.isArray(d.models)) return false;
	return true;
}

function isValidCacheEntry(entry: unknown): entry is CrofCacheEntry {
	if (typeof entry !== "object" || entry === null) return false;
	const e = entry as Record<string, unknown>;
	if (typeof e.id !== "string") return false;
	if (typeof e.name !== "string") return false;
	return true;
}

/**
 * Validate and clean cached models — drop invalid entries silently.
 */
export function validateCacheData(data: unknown): CrofCacheData | null {
	if (!isValidCacheData(data)) return null;
	const validModels: CrofCacheEntry[] = [];
	for (const entry of data.models) {
		if (isValidCacheEntry(entry)) {
			validModels.push(entry);
		}
	}
	if (validModels.length === 0) return null;
	return { timestamp: data.timestamp, models: validModels };
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
		const parsed = JSON.parse(raw);
		const data = validateCacheData(parsed);
		if (!data) return null;
		if (!options?.ignoreTTL && Date.now() - data.timestamp > CACHE_TTL_MS) return null;
		return data;
	} catch {
		return null;
	}
}

/**
 * Write model data to the cache file atomically.
 * Writes to a temp file first, then renames to the final path.
 * Silently ignores errors (cache is non-critical).
 */
export function writeCache(data: CrofCacheData): void {
	try {
		const dir = getCacheDir();
		mkdirSync(dir, { recursive: true });
		const tmpFile = getCacheFile() + ".tmp";
		writeFileSync(tmpFile, JSON.stringify(data, null, 2));
		renameSync(tmpFile, getCacheFile());
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
	const fileExists = existsSync(file);
	if (!fileExists) {
		return { exists: false, age: null, size: null, modelCount: 0 };
	}
	let raw: string;
	try {
		raw = readFileSync(file, "utf-8");
	} catch {
		return { exists: true, age: null, size: null, modelCount: 0 };
	}

	const sizeBytes = Buffer.byteLength(raw);
	const size = sizeBytes > 1024 ? `${(sizeBytes / 1024).toFixed(1)} KB` : `${sizeBytes} B`;

	try {
		const parsed = JSON.parse(raw);
		const data = validateCacheData(parsed);

		const ageMs = data ? Math.max(0, Date.now() - data.timestamp) : 0;
		const minutes = Math.floor(ageMs / 60000);
		const hours = Math.floor(minutes / 60);
		const age = data ? (hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`) : null;

		return {
			exists: true,
			age,
			size,
			modelCount: data ? data.models.length : 0,
		};
	} catch {
		return { exists: true, age: null, size, modelCount: 0 };
	}
}
