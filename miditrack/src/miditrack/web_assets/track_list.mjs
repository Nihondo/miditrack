/** トラック一覧の並べ替え状態と見出し操作を所有するコントローラー。 */

/**
 * トラック一覧のソート操作を生成する。
 *
 * @param {{ locale: string, getTrackRole: (trackIndex: number) => string, isRoleSortActive: () => boolean, onSortChange: () => void, queryAll?: (selector: string) => Iterable<Element> }} options
 */
export function createTrackListController({
  locale,
  getTrackRole,
  isRoleSortActive,
  onSortChange,
  queryAll = (selector) => document.querySelectorAll(selector),
}) {
  let sort = { key: "index", direction: "asc" };

  function trackSortValue(track, key) {
    if (key === "index") return track.index;
    if (key === "channel") return track.channels[0] ?? null;
    if (key === "source") return track.source || "";
    if (key === "instrument" && isRoleSortActive()) return getTrackRole(track.index);
    if (key === "instrument") return track.assignedProgram ?? track.currentProgram ?? -1;
    if (key === "volume") return track.volumePercent;
    return track.index;
  }

  function compareTracks(left, right, key) {
    const leftValue = trackSortValue(left, key);
    const rightValue = trackSortValue(right, key);
    if (key === "channel" && (leftValue === null || rightValue === null)) {
      if (leftValue === rightValue) return 0;
      return leftValue === null ? 1 : -1;
    }
    if (typeof leftValue === "string") return leftValue.localeCompare(rightValue, locale);
    return leftValue - rightValue;
  }

  function sortTracks(tracks) {
    const direction = sort.direction === "asc" ? 1 : -1;
    return tracks.slice().sort((left, right) => {
      const comparison = compareTracks(left, right, sort.key);
      if (sort.key === "channel" && (
        trackSortValue(left, "channel") === null || trackSortValue(right, "channel") === null
      )) return comparison;
      return comparison * direction;
    });
  }

  function updateHeaders() {
    for (const header of queryAll(".track-table th[data-sort-key]")) {
      const isActive = header.dataset.sortKey === sort.key;
      if (isActive) header.setAttribute("aria-sort", sort.direction === "asc" ? "ascending" : "descending");
      else header.removeAttribute("aria-sort");
      const indicator = header.querySelector(".sort-indicator");
      if (indicator) indicator.textContent = isActive
        ? (sort.direction === "asc" ? "▲" : "▼")
        : "";
    }
  }

  function setSortKey(key) {
    sort = sort.key === key
      ? { key, direction: sort.direction === "asc" ? "desc" : "asc" }
      : { key, direction: "asc" };
    onSortChange();
  }

  function connect() {
    for (const button of queryAll(".sort-button")) {
      button.addEventListener("click", () => setSortKey(button.dataset.sortKey));
    }
  }

  return { connect, sortTracks, updateHeaders };
}
