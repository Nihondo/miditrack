/** miditrack.app（WKWebView）とのネイティブ連携で必要な直列化・待ち合わせだけを持つ
 * コントローラー。実際のDOM操作・APIコール・ダイアログ表示は呼び出し元のコールバックに
 * 委ね、ここではローカルファイル読み込み要求の直列実行と、初期描画完了通知のタイミング
 * 制御だけを扱う。
 */

function waitForNextPaint(requestFrame) {
  return new Promise((resolve) => {
    requestFrame(() => requestFrame(resolve));
  });
}

/** ネイティブ判定フラグとrequestAnimationFrame実装を受け取り、ブリッジを作る。 */
export function createNativeBridgeController({ isNativeApp, requestFrame = requestAnimationFrame }) {
  let pendingOpen = Promise.resolve();

  return {
    /**
     * ネイティブ側からのローカルファイル読み込み要求を直列化する。同時に複数回
     * 呼ばれても、先行する処理が終わるまで次の呼び出しは待ってから実行される。
     */
    queueLocalOpen(paths, handleOpen) {
      pendingOpen = pendingOpen.then(() => handleOpen(paths));
      return pendingOpen;
    },
    /**
     * ネイティブアプリのスプラッシュオーバーレイへ、最新UIが少なくとも1フレーム
     * 描画された後で準備完了を通知する。ネイティブアプリでない、またはメッセージ
     * ハンドラが無い場合は何もしない。
     */
    async notifyReady(messageHandler) {
      if (!isNativeApp || !messageHandler) return;
      await waitForNextPaint(requestFrame);
      messageHandler.postMessage({});
    },
  };
}
