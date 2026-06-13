// SPDX-License-Identifier: Apache-2.0
//
// WebLLM in-browser model runtime — issue #451 (WASM-4).
// Integrates @mlc-ai/web-llm 0.2.84 (WebGPU + IndexedDB model cache) for opt-in
// local inference. Provider glue (#452) calls this to serve llm:chat tasks from
// a browser node; the demo page (#449) uses it for the "no install required" path.
//
// Dep: @mlc-ai/web-llm 0.2.84 (Apache-2.0, TC-11 cleared 2026-06-12,
//      sha512=hrOWzK4/nGNmgoRKT8pgVmZZ2oEPpbblIWQOwpqNyvK2dysHw3KVB1gNJOuRcQfKOPhucEhX1NJzXzgMDnwSCQ==)
//
// Dynamic import pattern: @mlc-ai/web-llm is NOT statically imported here,
// which keeps it out of the initial Next.js bundle. The load() call triggers
// the code-split chunk only when the user opts in.

// Type-only import for compile-time safety (erased at runtime; actual module
// is loaded dynamically in load()).
import type { InitProgressReport } from "@mlc-ai/web-llm";

import type { ChatMessage } from "./iicpConsumer";

export type { ChatMessage };

// ── Public types ─────────────────────────────────────────────────────────────

export interface WebLLMProgress {
  /** Human-readable status description (e.g. "Loading model 23%"). */
  text: string;
  /** 0–1 fraction. 1 = fully loaded and ready. */
  progress: number;
}

export type ProgressCallback = (p: WebLLMProgress) => void;

/**
 * Supported model IDs for UI display. Lineup (maintainer 2026-06-12): the two
 * lightest variants run fine on ANY computer ("CPU" tier — integrated
 * graphics, no dedicated card needed), plus one quality model that wants a
 * dedicated GPU. tier drives the CPU/GPU badge on the picker.
 * (Technically WebLLM always executes via WebGPU; the tier expresses the
 * hardware a model needs to run WELL — tooltips carry that nuance.)
 */
export const WEBLLM_MODELS = {
  "Qwen2.5-0.5B-Instruct-q4f32_1-MLC": {
    label: "Qwen 2.5 0.5B",
    sizeMB: 350,
    tier: "cpu",
    description: "Lightest — runs on any computer, no graphics card needed",
  },
  "Llama-3.2-1B-Instruct-q4f32_1-MLC": {
    label: "Llama 3.2 1B",
    sizeMB: 500,
    tier: "cpu",
    description: "Light and capable — fine on laptops with integrated graphics",
  },
  "Llama-3.2-3B-Instruct-q4f32_1-MLC": {
    label: "Llama 3.2 3B",
    sizeMB: 1500,
    tier: "gpu",
    description: "Best quality — needs a dedicated graphics card (~4 GB VRAM)",
  },
} as const;

export type WebLLMModelId = keyof typeof WEBLLM_MODELS;
export const DEFAULT_MODEL: WebLLMModelId =
  "Qwen2.5-0.5B-Instruct-q4f32_1-MLC";

/**
 * Coarse device-capability assessment for steering the model picker (#517 D4).
 * Phones/tablets and low-memory machines frequently OOM loading even a 1B model,
 * so the UI should nudge toward the lightest model or the WebGPU-free mesh path
 * rather than letting a newcomer pick a model their device can't run.
 *
 * Signals: `navigator.deviceMemory` (GB, Chromium-only, coarse) + a UA mobile
 * check. Best-effort — absence of a signal is treated as "ok".
 */
export type DeviceClass = "mobile" | "low" | "ok";
export interface DeviceAssessment {
  deviceClass: DeviceClass;
  deviceMemoryGB: number | null;
  /** Whether the GPU-tier (largest) model is likely to fail on this device. */
  gpuModelRisky: boolean;
  /** Plain-language steer, empty when the device looks capable. */
  note: string;
}

export function assessDevice(): DeviceAssessment {
  if (typeof navigator === "undefined") {
    return { deviceClass: "ok", deviceMemoryGB: null, gpuModelRisky: false, note: "" };
  }
  const mem =
    typeof (navigator as Navigator & { deviceMemory?: number }).deviceMemory === "number"
      ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null
      : null;
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "");
  if (isMobile) {
    return {
      deviceClass: "mobile",
      deviceMemoryGB: mem,
      gpuModelRisky: true,
      note: "On phones and tablets, in-browser models often run out of memory. Start with the lightest model — or skip it and use “Ask the mesh” below, which runs on a remote node (no WebGPU needed).",
    };
  }
  if (mem !== null && mem <= 4) {
    return {
      deviceClass: "low",
      deviceMemoryGB: mem,
      gpuModelRisky: true,
      note: `Your device reports ~${mem} GB of memory — the lightest model is recommended; larger ones may fail to load.`,
    };
  }
  return { deviceClass: "ok", deviceMemoryGB: mem, gpuModelRisky: false, note: "" };
}

// ── Capability detection ──────────────────────────────────────────────────────

export interface WebGPUCheckResult {
  supported: boolean;
  /** Present when unsupported — human-readable reason. */
  reason?: string;
}

/**
 * Detect WebGPU availability. Safe to call server-side (returns unsupported).
 * Chrome 113+, Firefox nightly, Safari Technology Preview.
 */
export function detectWebGPU(): WebGPUCheckResult {
  if (typeof navigator === "undefined") {
    return { supported: false, reason: "server-side render" };
  }
  if (!("gpu" in navigator)) {
    return {
      supported: false,
      reason: "WebGPU not available — requires Chrome 113+, Firefox nightly, or Safari TP",
    };
  }
  return { supported: true };
}

/**
 * Async WebGPU probe — the REAL availability signal. `detectWebGPU()` only
 * checks that `navigator.gpu` exists, which some browsers expose while still
 * being unable to run a model (e.g. Firefox surfaces `navigator.gpu` but has no
 * usable adapter unless `dom.webgpu.enabled` is set, producing a false-positive
 * "WebGPU available" badge — #518). This calls `requestAdapter()` to confirm a
 * usable GPU, so UI that gates on it reflects reality, not just API presence.
 */
export async function probeWebGPU(): Promise<WebGPUCheckResult> {
  const presence = detectWebGPU();
  if (!presence.supported) return presence;
  try {
    const nav = navigator as Navigator & { gpu?: { requestAdapter(): Promise<object | null> } };
    const adapter = await nav.gpu?.requestAdapter();
    if (!adapter) {
      return {
        supported: false,
        reason:
          "your browser exposes WebGPU but no usable GPU adapter was found — it may be blocklisted, hardware acceleration may be off, or WebGPU isn't enabled on this device",
      };
    }
    return { supported: true };
  } catch (e) {
    return {
      supported: false,
      reason: `WebGPU adapter probe failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// ── Error ─────────────────────────────────────────────────────────────────────

/**
 * Classify a load-failure message as out-of-memory (#517 D4). OOM is the most
 * common real-device failure (phones / integrated GPUs); detecting it lets the
 * UI steer to a smaller model or the mesh instead of a generic error. Matches
 * the strings WebGPU/WebLLM/browsers surface for memory exhaustion.
 */
export function isOutOfMemoryError(message: string): boolean {
  return /out of memory|out-of-memory|\boom\b|device lost|devicelost|allocat|exceeds the limit|insufficient|RangeError/i.test(
    message,
  );
}

export class WebLLMError extends Error {
  constructor(
    message: string,
    readonly code:
      | "webgpu_unavailable"
      | "not_loaded"
      | "load_failed"
      | "out_of_memory"
      | "inference_failed"
      | "bad_response",
  ) {
    super(message);
    this.name = "WebLLMError";
  }
}

// ── Runtime ───────────────────────────────────────────────────────────────────

// Minimal engine interface matching @mlc-ai/web-llm 0.2.x public API.
// NOTE: `model` is intentionally absent from create() — WebLLM excludes it from
// ChatCompletionRequestBase; the model is bound at engine-creation time via
// CreateMLCEngine(modelId) and cannot be overridden per-request.
interface MLCEngineInstance {
  chat: {
    completions: {
      create(opts: {
        messages: ChatMessage[];
        stream: false;
        temperature?: number;
        max_tokens?: number;
      }): Promise<{
        choices: Array<{ message: { content: string | null } }>;
      }>;
    };
  };
  unload(): Promise<void>;
}

/**
 * In-browser LLM runtime wrapping @mlc-ai/web-llm.
 *
 * Lifecycle: construct → canRun() check → load() → chat() → unload()
 *
 * Model weights are downloaded once and cached in IndexedDB by the WebLLM
 * engine (automatic, per-origin). Subsequent loads skip the download.
 *
 * @example
 * ```ts
 * const rt = new WebLLMRuntime();
 * if (!rt.canRun()) return; // WebGPU unavailable
 * await rt.load('Llama-3.2-1B-Instruct-q4f32_1-MLC', p => setProgress(p));
 * const reply = await rt.chat([{ role: 'user', content: 'Hello' }]);
 * ```
 */
export class WebLLMRuntime {
  private _engine: MLCEngineInstance | null = null;
  private _modelId: WebLLMModelId | null = null;

  /** True if WebGPU is available in this browser/environment. */
  canRun(): boolean {
    return detectWebGPU().supported;
  }

  /** True if a model is currently loaded and ready for inference. */
  isLoaded(): boolean {
    return this._engine !== null;
  }

  /** Currently loaded model ID, or null if not loaded. */
  get modelId(): WebLLMModelId | null {
    return this._modelId;
  }

  /**
   * Load a model. First call downloads weights (~300–1500 MB) and caches them
   * in IndexedDB. Subsequent calls with the same model skip the download.
   *
   * @param model  Model ID from WEBLLM_MODELS (default: Llama 3.2 1B q4)
   * @param onProgress  Optional progress callback (text, 0–1 fraction)
   * @throws WebLLMError  If WebGPU is unavailable or model load fails
   */
  async load(
    model: WebLLMModelId = DEFAULT_MODEL,
    onProgress?: ProgressCallback,
  ): Promise<void> {
    const gpuCheck = detectWebGPU();
    if (!gpuCheck.supported) {
      throw new WebLLMError(
        `WebGPU unavailable: ${gpuCheck.reason}`,
        "webgpu_unavailable",
      );
    }

    // requestAdapter() is the real hardware test — navigator.gpu existing is not enough.
    // Returns null when GPU is on the blocklist, hardware-accel is disabled, or no adapter.
    const nav = navigator as Navigator & { gpu?: { requestAdapter(): Promise<object | null> } };
    const adapter = await nav.gpu?.requestAdapter();
    if (!adapter) {
      throw new WebLLMError(
        "WebGPU adapter unavailable — GPU may be blocklisted, hardware acceleration may be disabled, or WebGPU isn't supported on this device/OS",
        "webgpu_unavailable",
      );
    }

    try {
      // Dynamic import — creates a separate bundle chunk, loaded only on user opt-in.
      const webllm = await import("@mlc-ai/web-llm");

      const engine = (await webllm.CreateMLCEngine(model, {
        initProgressCallback: (report: InitProgressReport) => {
          onProgress?.({ text: report.text, progress: report.progress });
        },
      })) as MLCEngineInstance;

      this._engine = engine;
      this._modelId = model;
    } catch (err) {
      // Log full detail so users can copy from F12 console
      console.error("[WebLLMRuntime] load() failed:", err);
      const msg = err instanceof Error ? err.message : String(err);
      const cause = err instanceof Error
        ? (err as Error & { cause?: unknown }).cause
        : undefined;
      const causeMsg = cause instanceof Error
        ? `: ${cause.message}`
        : cause
        ? `: ${String(cause)}`
        : "";
      // Out-of-memory is the most common real-device load failure (esp. on
      // phones / integrated GPUs). Detect it so the UI can steer to a smaller
      // model or the mesh rather than showing a generic "load failed". #517 D4.
      const full = `${msg}${causeMsg}`;
      if (isOutOfMemoryError(full)) {
        throw new WebLLMError(
          `Ran out of memory loading this model: ${full}`,
          "out_of_memory",
        );
      }
      throw new WebLLMError(`Model load failed: ${full}`, "load_failed");
    }
  }

  /**
   * CIP-compatible chat inference. Returns the assistant reply text.
   * Provider glue (#452) calls this to satisfy llm:chat intent tasks.
   * The model is fixed at load() time — pass a different modelId to load() to switch.
   *
   * @param messages  Chat history (system/user/assistant turns)
   * @throws WebLLMError  If no model is loaded or inference fails
   */
  async chat(
    messages: ChatMessage[],
    opts?: { temperature?: number; max_tokens?: number },
  ): Promise<string> {
    if (!this._engine) {
      throw new WebLLMError(
        "No model loaded — call load() first",
        "not_loaded",
      );
    }

    let resp;
    try {
      resp = await this._engine.chat.completions.create({
        messages,
        stream: false,
        ...(opts?.temperature !== undefined && { temperature: opts.temperature }),
        ...(opts?.max_tokens !== undefined && { max_tokens: opts.max_tokens }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new WebLLMError(`Inference failed: ${msg}`, "inference_failed");
    }

    const content = resp.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new WebLLMError(
        "Unexpected response shape from WebLLM engine",
        "bad_response",
      );
    }
    return content;
  }

  /**
   * Unload the model and release GPU memory.
   * Safe to call when not loaded (no-op).
   */
  async unload(): Promise<void> {
    if (this._engine) {
      await this._engine.unload();
      this._engine = null;
      this._modelId = null;
    }
  }
}
