/** ピアノロールの再生追従（自動スクロール）状態を管理するDOM非依存コントローラー。 */

/** 再生追従コントローラーを作る。 */
export function createPianorollFollowController() {
  let isFollowing = false;
  let pendingScrollTarget = null;

  function setFollowing(shouldFollow) {
    isFollowing = shouldFollow;
    if (!shouldFollow) pendingScrollTarget = null;
  }

  return {
    /** 追従の有効/無効を切り替える。無効化時は保留中のスクロール目標も捨てる。 */
    setFollowing,
    /** 現在追従中かどうかを返す。 */
    isFollowing() {
      return isFollowing;
    },
    /** 先頭へスクロールする計画を立て、その目標値（常に0）を返す。 */
    planScrollToStart() {
      pendingScrollTarget = 0;
      return 0;
    },
    /**
     * 再生位置に合わせて追従スクロールすべきか判定し、必要ならその目標scrollLeftを返す。
     * 追従が無効、時間軸情報が無い、または既に再生位置がビューポート中央より手前
     * （追いつく必要が無い）なら null を返す。
     */
    planFollowScroll({ durationSeconds, timelineWidth, viewportWidth, scrollLeft, globalSeconds }) {
      if (!isFollowing || !durationSeconds || !timelineWidth) return null;
      const viewportHalf = viewportWidth / 2;
      const progress = Math.min(1, globalSeconds / durationSeconds);
      const playheadX = progress * timelineWidth;
      if (playheadX <= viewportHalf) return null;
      const maximumScroll = Math.max(0, timelineWidth - viewportWidth);
      const target = Math.min(maximumScroll, Math.max(0, playheadX - viewportHalf));
      if (Math.abs(scrollLeft - target) < 0.5) return null;
      pendingScrollTarget = target;
      return target;
    },
    /**
     * 実際のscrollLeftを、直前に計画した目標と突き合わせる。追従由来のスクロール
     * （目標に到達済み）ならtrueを返して追従を維持し、そうでなければ手動スクロール
     * とみなして追従を解除しfalseを返す。
     */
    reconcileScroll(scrollLeft) {
      if (pendingScrollTarget !== null && Math.abs(scrollLeft - pendingScrollTarget) < 1) {
        pendingScrollTarget = null;
        return true;
      }
      setFollowing(false);
      return false;
    },
  };
}
