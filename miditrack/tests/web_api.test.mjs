import assert from "node:assert/strict";
import test from "node:test";

import { createApiClient } from "../src/miditrack/web_assets/api.mjs";

test("APIクライアントは認証ヘッダーを付与して音声URLを作る", async () => {
  let request;
  const client = createApiClient({
    token: "session token",
    t: (message) => message,
    fetchImpl: async (path, options) => {
      request = { path, options };
      return { ok: true };
    },
  });

  await client.apiFetch("/api/session", { method: "GET" });
  assert.equal(request.path, "/api/session");
  assert.equal(request.options.headers.get("X-Miditrack-Token"), "session token");
  assert.equal(client.audioUrl(12), "/api/audio?v=12&token=session%20token");
});

test("APIクライアントはサーバーのエラー本文を優先する", async () => {
  const client = createApiClient({
    token: "token",
    t: (_message, values) => `HTTP ${values.status}`,
    fetchImpl: async () => ({
      ok: false,
      status: 422,
      json: async () => ({ error: "入力を確認してください" }),
    }),
  });

  await assert.rejects(client.apiFetch("/api/session"), /入力を確認してください/);
});
