/** GMプログラムのピン留め・使用頻度を管理するDOM非依存コントローラー。
 * サーバー側設定（/api/preferences）との読み書きと、「よく使う」欄のDOM構築は
 * 呼び出し元が担い、このコントローラーはピン留めSetと使用回数、その並び順だけを持つ。
 */

/** 「よく使う」欄の最大件数を受け取り、お気に入りプログラムコントローラーを作る。 */
export function createFavoriteProgramsController({ maxFavorites }) {
  let pinnedPrograms = new Set();
  let usageCounts = {};

  return {
    /** サーバーから読み込んだ保存値でコントローラーの状態を置き換える。 */
    load({ pinnedPrograms: pinned = [], usageCounts: usage = {} } = {}) {
      pinnedPrograms = new Set(pinned);
      usageCounts = { ...usage };
    },
    /** 指定したプログラムがピン留めされているかを返す。 */
    isPinned(program) {
      return program !== null && pinnedPrograms.has(program);
    },
    /** ピン留め状態を反転させ、反転後の状態を返す。 */
    togglePinned(program) {
      if (pinnedPrograms.has(program)) {
        pinnedPrograms.delete(program);
      } else {
        pinnedPrograms.add(program);
      }
      return pinnedPrograms.has(program);
    },
    /** プログラムの選択を1回分記録する。 */
    recordUsage(program) {
      usageCounts[program] = (usageCounts[program] || 0) + 1;
    },
    /** 保存用に、現在ピン留めされているプログラム番号の配列を返す。 */
    getPinnedPrograms() {
      return [...pinnedPrograms];
    },
    /** 保存用に、現在の使用回数マップの複製を返す。 */
    getUsageCounts() {
      return { ...usageCounts };
    },
    /**
     * ピン留め済み（優先、ピン留め順）とよく使う順（頻度降順）を合わせた、
     * 最大maxFavorites件の並び順を返す。各要素は { program, isPinned }。
     */
    rankFavorites() {
      const usageRanked = Object.keys(usageCounts)
        .map(Number)
        .filter((program) => !pinnedPrograms.has(program))
        .sort((a, b) => usageCounts[b] - usageCounts[a]);
      return [...pinnedPrograms, ...usageRanked]
        .slice(0, maxFavorites)
        .map((program) => ({ program, isPinned: pinnedPrograms.has(program) }));
    },
  };
}
