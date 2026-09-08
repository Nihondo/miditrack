/** ピアノロールのポインター操作中だけ必要な状態を管理するコントローラー。 */

/** ドラッグ開始判定の距離を受け取り、ポインター操作コントローラーを作る。 */
export function createPianorollPointerController({ dragThresholdPixels }) {
  let interaction = null;

  function isMatchingPointer(pointerId) {
    return interaction?.pointerId === pointerId;
  }

  return {
    /** ポインター操作を開始し、ドラッグ判定に必要な開始位置を保存する。 */
    beginPointer(pointerId, clientX, anchorSeconds) {
      interaction = {
        pointerId,
        startClientX: clientX,
        anchorSeconds,
        isDragging: false,
      };
    },
    /** 現在位置がループ選択ドラッグとして有効なら、その座標ペアを返す。 */
    updatePointer(pointerId, clientX, currentSeconds) {
      if (!isMatchingPointer(pointerId) || interaction.anchorSeconds === null || currentSeconds === null) {
        return null;
      }
      const distance = Math.abs(clientX - interaction.startClientX);
      if (!interaction.isDragging && distance < dragThresholdPixels) return null;
      interaction.isDragging = true;
      return {
        anchorSeconds: interaction.anchorSeconds,
        currentSeconds,
      };
    },
    /** ポインター操作を終了し、終了直前の操作種別を返す。 */
    finishPointer(pointerId) {
      if (!isMatchingPointer(pointerId)) return null;
      const completedInteraction = interaction;
      interaction = null;
      return completedInteraction;
    },
  };
}
