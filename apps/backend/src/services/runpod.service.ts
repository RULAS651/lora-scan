import axios from "axios";
import crypto from "crypto";

const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY ?? "";
const RUNPOD_ENDPOINT_ID = process.env.RUNPOD_ENDPOINT_ID ?? "";
const WEBHOOK_BASE = process.env.RUNPOD_WEBHOOK_BASE_URL ?? "";

const api = axios.create({
  baseURL: "https://api.runpod.ai/v2",
  headers: RUNPOD_API_KEY ? { Authorization: `Bearer ${RUNPOD_API_KEY}` } : {},
  timeout: 60_000,
});

export interface RunPodSubmitInput {
  workflow: any;               // ComfyUI workflow JSON
  triggerWord: string;
  memberId: string;
  scanSessionId: string;
}

export async function submitTrainingJob(input: RunPodSubmitInput) {
  if (!RUNPOD_ENDPOINT_ID) {
    // Developer mode: no RunPod creds — return a mock job ID so the pipeline
    // can be exercised end-to-end via the manual mock-webhook endpoint.
    const mockId = "mock-" + crypto.randomBytes(8).toString("hex");
    return {
      id: mockId,
      status: "IN_QUEUE",
      mock: true,
      note: "Set RUNPOD_API_KEY + RUNPOD_ENDPOINT_ID for real RunPod dispatch",
    };
  }
  const endpoint = `/${RUNPOD_ENDPOINT_ID}/run`;
  const webhookUrl = WEBHOOK_BASE
    ? `${WEBHOOK_BASE}/api/webhooks/runpod?session=${encodeURIComponent(input.scanSessionId)}`
    : undefined;
  const body = {
    input: {
      workflow: input.workflow,
      trigger_word: input.triggerWord,
      member_id: input.memberId,
      scan_session_id: input.scanSessionId,
    },
    ...(webhookUrl ? { webhook: webhookUrl } : {}),
  };
  const res = await api.post(endpoint, body);
  return res.data; // { id, status }
}

export async function getJobStatus(runpodJobId: string) {
  if (runpodJobId.startsWith("mock-")) {
    return { id: runpodJobId, status: "COMPLETED", mock: true };
  }
  if (!RUNPOD_ENDPOINT_ID) {
    return { id: runpodJobId, status: "COMPLETED", mock: true };
  }
  const res = await api.get(`/${RUNPOD_ENDPOINT_ID}/status/${runpodJobId}`);
  return res.data;
}

export async function cancelJob(runpodJobId: string) {
  if (runpodJobId.startsWith("mock-")) return { ok: true, mock: true };
  if (!RUNPOD_ENDPOINT_ID) return { ok: true, mock: true };
  const res = await api.post(`/${RUNPOD_ENDPOINT_ID}/cancel/${runpodJobId}`);
  return res.data;
}

/**
 * After a RunPod job finishes successfully, the output typically contains
 * a download URL for the LoRA safetensors file (or the user's serverless
 * handler can post it back).  Fetch to a buffer for encryption + storage.
 */
export async function fetchLoRAArtifact(url: string) {
  const res = await axios.get(url, { responseType: "arraybuffer", timeout: 5 * 60_000 });
  return Buffer.from(res.data as ArrayBuffer);
}
