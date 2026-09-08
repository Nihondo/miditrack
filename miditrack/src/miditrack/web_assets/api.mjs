/** HTTP認証と共通エラー処理をまとめるWeb APIクライアント。 */

/**
 * セッション固有のAPIクライアントを作成する。
 *
 * @param {{ token: string, t: (message: string, values?: object) => string, fetchImpl?: typeof fetch }} options
 * @returns {{ apiFetch: (path: string, options?: RequestInit) => Promise<Response>, audioUrl: (renderId: number) => string }}
 */
export function createApiClient({ token, t, fetchImpl = fetch }) {
  async function apiFetch(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set("X-Miditrack-Token", token);
    const response = await fetchImpl(path, { ...options, headers });
    if (!response.ok) {
      let message = t("処理に失敗しました（HTTP {status}）", { status: response.status });
      try {
        const payload = await response.json();
        if (payload.error) message = payload.error;
      } catch (_error) {
        // JSONでないエラー応答は既定メッセージを使う。
      }
      throw new Error(message);
    }
    return response;
  }

  function audioUrl(renderId) {
    return `/api/audio?v=${renderId}&token=${encodeURIComponent(token)}`;
  }

  return { apiFetch, audioUrl };
}
