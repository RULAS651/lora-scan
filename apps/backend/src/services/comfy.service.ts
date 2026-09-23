import fs from "node:fs/promises";
import path from "node:path";
import axios from "axios";
import { decryptAndRead } from "./privacy.service";

/**
 * ComfyUI integration.
 *
 * Workflow resolution order:
 *   1. COMFYUI_WORKFLOW_TEMPLATE env → read JSON template from disk
 *   2. Fallback → generate a minimal Koyha/EveryDream style training workflow
 *
 * The returned workflow object is ready to POST to /prompt on the ComfyUI API.
 * The caller should replace image inputs + trigger word using patchWorkflowImages()
 * and patchWorkflowTrigger() respectively.
 */
const COMFYUI_URL = process.env.COMFYUI_URL ?? "http://127.0.0.1:8188";

export interface LoRATrainingParams {
  triggerWord: string;
  steps?: number;
  rank?: number;
  learningRate?: number;
  instanceCaption?: string;
  outputName?: string;
}

export async function loadBaseWorkflow(): Promise<any> {
  const tmpl = process.env.COMFYUI_WORKFLOW_TEMPLATE;
  if (tmpl) {
    const p = path.resolve(process.cwd(), tmpl);
    const raw = await fs.readFile(p, "utf-8");
    return JSON.parse(raw);
  }
  return buildFallbackTrainingWorkflow();
}

function buildFallbackTrainingWorkflow() {
  // Minimal placeholder — user should provide their own workflow via env.
  // This skeleton is intentionally small; real LoRA training workflows vary
  // wildly between Koyha_ss, EveryDream Trainer, ComfyUI's own nodes, etc.
  return {
    "1": { class_type: "LoraLoader", inputs: { lora_name: "<TO-BE-SET>", strength_model: 1, strength_clip: 1 } },
    "meta": { _note: "Replace with your ComfyUI API-format training workflow via COMFYUI_WORKFLOW_TEMPLATE env" },
  };
}

/**
 * Patch a workflow JSON so that each image input node uses the given buffers.
 * We first upload each buffer to ComfyUI's /upload/image endpoint so the
 * training nodes (Kohya/…) can resolve them by filename.
 */
export async function patchWorkflowImages(workflow: any, params: {
  images: { buffer: Buffer; filename: string }[];
}) {
  const uploaded: string[] = [];
  for (const img of params.images) {
    const form = new FormData();
    // @ts-ignore
    form.append("image", new Blob([img.buffer], { type: "image/jpeg" }), img.filename);
    form.append("overwrite", "true");
    const r = await axios.post(`${COMFYUI_URL}/upload/image`, form as any, {
      headers: { "Content-Type": "multipart/form-data" } as any,
      timeout: 60_000,
    });
    uploaded.push(r.data.name ?? r.data.filename ?? img.filename);
  }
  // User's workflow must have a node with id = "TRAINING_INPUTS" containing a
  // "filenames" list input; we don't try to guess arbitrary workflow shapes.
  if (workflow.TRAINING_INPUTS) {
    workflow.TRAINING_INPUTS.inputs = workflow.TRAINING_INPUTS.inputs ?? {};
    workflow.TRAINING_INPUTS.inputs.filenames = uploaded;
  }
  return { workflow, uploadedFilenames: uploaded };
}

export function patchWorkflowTrigger(workflow: any, p: LoRATrainingParams) {
  const trigger = p.triggerWord;
  // Replace placeholder tokens used by the fallback template.
  let str = JSON.stringify(workflow);
  str = str.replace(/<TRIGGER>/g, trigger);
  str = str.replace(/<STEPS>/g,   String(p.steps ?? 2000));
  str = str.replace(/<RANK>/g,    String(p.rank ?? 16));
  str = str.replace(/<LR>/g,      String(p.learningRate ?? 1e-4));
  str = str.replace(/<OUTPUT>/g,  p.outputName ?? `lora_${trigger}`);
  if (p.instanceCaption) str = str.replace(/<CAPTION>/g, p.instanceCaption);
  return JSON.parse(str);
}

/**
 * Convenience: decrypt a ScanImage's encrypted blob → plaintext buffer.
 * Runs entirely in memory; never writes a decrypted copy to disk.
 */
export async function decryptScanImage(params: {
  blobPath: string;
  ownerMemberId: string;
  callerId: string;
  callerIsAdmin: boolean;
}) {
  return decryptAndRead(params);
}

export function comfyUiUrl() { return COMFYUI_URL; }
