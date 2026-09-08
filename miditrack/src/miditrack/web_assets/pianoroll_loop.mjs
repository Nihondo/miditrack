/** ピアノロールの反復範囲と有効状態を管理する状態非依存コントローラー。 */

/** 指定した最小長でループ範囲コントローラーを作る。 */
export function createPianorollLoopController({ minimumSeconds }) {
  let selectedRange = null;
  let isEnabled = false;

  function normalizeRange(startSeconds, endSeconds, durationSeconds) {
    if (
      !Number.isFinite(startSeconds)
      || !Number.isFinite(endSeconds)
      || !Number.isFinite(durationSeconds)
      || durationSeconds <= 0
    ) {
      return null;
    }
    const start = Math.min(durationSeconds, Math.max(0, startSeconds));
    const end = Math.min(durationSeconds, Math.max(0, endSeconds));
    return end - start >= minimumSeconds ? { start, end } : null;
  }

  function getSelectedRange(durationSeconds) {
    if (!selectedRange) return null;
    return normalizeRange(selectedRange.start, selectedRange.end, durationSeconds);
  }

  return {
    /** 有効状態にかかわらず、現在選択されている範囲を返す。 */
    getSelectedRange,
    /** 有効な場合だけ、現在選択されている範囲を返す。 */
    getActiveRange(durationSeconds) {
      return isEnabled ? getSelectedRange(durationSeconds) : null;
    },
    /** 範囲を検証して保存し、必要に応じてループを有効化する。 */
    setRange(startSeconds, endSeconds, durationSeconds, { enable = isEnabled } = {}) {
      const range = normalizeRange(startSeconds, endSeconds, durationSeconds);
      if (!range) return false;
      selectedRange = range;
      isEnabled = enable;
      return true;
    },
    /** 選択範囲と有効状態を初期状態へ戻す。 */
    clearRange() {
      selectedRange = null;
      isEnabled = false;
    },
    /** ループの有効状態を返す。 */
    isEnabled() {
      return isEnabled;
    },
  };
}
