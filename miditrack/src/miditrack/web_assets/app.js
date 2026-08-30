"use strict";

const $ = (selector) => document.querySelector(selector);

const query = new URLSearchParams(window.location.search);
const queryToken = query.get("token") || "";
if (queryToken) {
  window.sessionStorage.setItem("miditrackToken", queryToken);
}
const token = queryToken || window.sessionStorage.getItem("miditrackToken") || "";
if (queryToken) {
  history.replaceState(null, "", window.location.pathname);
}

const KEEP_ORIGINAL = "__keep__";
const DEFAULT_GM_PROGRAM = "80";
const MIDI_EXTENSION_RE = /\.(mid|midi)$/i;
const MAX_FAVORITE_PROGRAMS = 8;
const PIANOROLL_ZOOM_LEVELS = [1, 1.5, 2, 3, 4, 6, 8];
const PLAYBACK_SEEK_SECONDS = 1;
const PREWARM_DELAY_MS = 500;

const state = {
  session: null,          // 直近の /api/session (POST/PATCH/GET) レスポンス
  optionsFragment: null,  // /api/instruments から一度だけ構築したドロップダウンの雛形
  programNames: {},       // GMプログラム番号(number) -> 表示テキスト（「よく使う」欄の再構築に使う）
  // pinnedPrograms/usageCountsはinit()のloadPreferences()で読み込むまで空のまま。
  // サーバー側ファイル（/api/preferences）で永続化する ― 起動のたびにポートが
  // 変わりlocalStorageのオリジンも変わってしまうため、ブラウザ側には保存しない。
  pinnedPrograms: new Set(), // 手動ピン留めされたGMプログラム番号のSet
  usageCounts: {},           // GMプログラム番号 -> 選択回数（「よく使う」の自動集計用）
  instrumentRows: [],     // 現在描画中の楽器行 { select, pinButton } の一覧。ピン留め変更時に全行を再描画する。
  // 現在描画中の全トラック行のコントロール参照
  // { sourceSelect, programSelect, volumeSlider, muteButton }（無いものはnull）。
  // Cmd/Ctrlキーを押しながらの操作で「全トラックに同じ設定を適用」する際に使う。
  trackRows: [],
  pendingAssignments: {}, // トラック番号(number) -> GMプログラム番号 | null（未送信分）
  pendingVolumes: {},     // トラック番号(number) -> 音量パーセント（未送信分）
  pendingSources: {},     // トラック番号(number) -> soundfont | game（未送信分）
  patchTimer: null,
  patchPromise: null,     // 送信中の設定PATCH。試聴開始時の競合を防ぐ。
  transformPatchTimer: null, // 全体の速度・ピッチ（PATCH /api/session/transform）用のデバウンス。
  downloadFilenamePatchTimer: null, // ダウンロードファイル名（PATCH /api/session/filename）用のデバウンス。
  statusTimer: null,
  convertFields: [], // 変換パネルに描画中のオプションフィールド { name, type, input, conflicts }
  soundfontPayload: null, // 直近の /api/soundfonts レスポンス（hasGameSoundfont変化時の再描画用）
  soloTrackIndex: null,     // ソロ試聴中のトラック番号（無ければnull）
  soloVolumeSnapshot: null, // ソロ開始直前の全トラック音量 { トラック番号: パーセント }。解除時に戻す。
  trackSort: { key: "index", direction: "asc" },
  hideEmptyTracks: true, // ノート数0のトラックを一覧から隠すか（#hide-empty-tracksチェックボックスの状態）
  trackRenderId: 0,
  pianoroll: null,
  pianorollBase: document.createElement("canvas"),
  pianorollLoadId: 0,
  pianorollSize: null,
  isPianorollSeeking: false,
  pianorollPointerId: null,
  pianorollZoom: 1,
  isPianorollAutoFollowing: false,
  pianorollAutoScrollTarget: null,
  playbackTimeFrameId: null,
  renderMode: "fast",
  prewarmTimer: null,
  prewarmGeneration: 0,
};

// サーバー側の設定ファイル（/api/preferences）からピン留め・使用回数を読み込み、
// stateへ反映する。起動時に一度だけinit()から呼ぶ。失敗時は「お気に入り機能が
// 空の状態から始まるだけ」として、既にセットされている空のstateのまま継続する。
async function loadPreferences() {
  try {
    const response = await apiFetch("/api/preferences");
    const payload = await response.json();
    state.pinnedPrograms = new Set(payload.pinnedPrograms || []);
    state.usageCounts = payload.usageCounts || {};
  } catch (_error) {
    // 読み込めなくても機能自体は空の状態で継続する。
  }
}

// ピン留め・使用回数の変更をサーバー側の設定ファイルへ書き戻す。UIの見た目自体は
// 呼び出し元が既にstateを更新して同期的に反映しているため、ここは書き込み失敗を
// 静かに無視してよい（次回の変更で再送されれば整合する）。
async function savePinnedPrograms() {
  try {
    await apiFetch("/api/preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinnedPrograms: [...state.pinnedPrograms] }),
    });
  } catch (_error) {
    // 保存できなくてもピン留めのUI表示自体は継続する。
  }
}

async function saveUsageCounts() {
  try {
    await apiFetch("/api/preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usageCounts: state.usageCounts }),
    });
  } catch (_error) {
    // 保存できなくても今回のセッション内での集計自体は継続する。
  }
}

// GMプログラムが選択されるたびに使用回数を加算し、「よく使う」欄へ反映する。
function recordProgramUsage(program) {
  state.usageCounts[program] = (state.usageCounts[program] || 0) + 1;
  saveUsageCounts();
  refreshFavoritePrograms();
}

function isProgramPinned(program) {
  return program !== null && state.pinnedPrograms.has(program);
}

function toggleProgramPinned(program) {
  if (state.pinnedPrograms.has(program)) {
    state.pinnedPrograms.delete(program);
  } else {
    state.pinnedPrograms.add(program);
  }
  savePinnedPrograms();
  refreshFavoritePrograms();
}

// ピン留め済み（優先）とよく使う順（頻度）を合わせて、最大MAX_FAVORITE_PROGRAMS件の
// <optgroup>を構築する。候補が無ければnullを返す（空のoptgroupは作らない）。
function buildFavoriteProgramsOptgroup() {
  const usageRanked = Object.keys(state.usageCounts)
    .map(Number)
    .filter((program) => !state.pinnedPrograms.has(program))
    .sort((a, b) => state.usageCounts[b] - state.usageCounts[a]);
  const ordered = [...state.pinnedPrograms, ...usageRanked].slice(0, MAX_FAVORITE_PROGRAMS);
  if (ordered.length === 0) return null;

  const optgroup = document.createElement("optgroup");
  optgroup.label = "よく使う";
  optgroup.dataset.favorites = "true";
  for (const program of ordered) {
    const option = document.createElement("option");
    option.value = String(program);
    const label = state.programNames[program] || String(program + 1);
    option.textContent = state.pinnedPrograms.has(program) ? `★ ${label}` : label;
    optgroup.appendChild(option);
  }
  return optgroup;
}

// ピン留め/使用回数が変わるたびに、描画中の全楽器セレクトの「よく使う」欄と
// ピン留めボタンの見た目を最新化する。
function refreshFavoritePrograms() {
  for (const row of state.instrumentRows) {
    const previousValue = row.select.value;
    const existing = row.select.querySelector('optgroup[data-favorites="true"]');
    if (existing) existing.remove();
    const favoritesGroup = buildFavoriteProgramsOptgroup();
    if (favoritesGroup) {
      row.select.insertBefore(favoritesGroup, row.select.firstChild.nextSibling);
    }
    row.select.value = previousValue;
    row.updatePinButton();
  }
}

function isMidiFilename(name) {
  return MIDI_EXTENSION_RE.test(name);
}

function showStatus(message, type = "") {
  const element = $("#global-status");
  element.textContent = message;
  element.className = `status-toast ${type}`.trim();
  element.hidden = false;
  clearTimeout(state.statusTimer);
  state.statusTimer = setTimeout(() => { element.hidden = true; }, 6000);
}

function setBusy(isBusy, message = "") {
  document.body.classList.toggle("busy", isBusy);
  if (message) showStatus(message);
  updatePlaybackControls();
}

async function apiFetch(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("X-Miditrack-Token", token);
  const response = await fetch(path, { ...options, headers });
  if (!response.ok) {
    let message = `処理に失敗しました（HTTP ${response.status}）`;
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

function selectedRenderMode() {
  return document.querySelector('input[name="render-mode"]:checked')?.value || "fast";
}

function cancelPrewarm() {
  clearTimeout(state.prewarmTimer);
  state.prewarmTimer = null;
  state.prewarmGeneration += 1;
}

function schedulePrewarm() {
  cancelPrewarm();
  if (!state.session || state.session.tracks.length === 0) return;
  const generation = state.prewarmGeneration;
  const renderMode = selectedRenderMode();
  state.prewarmTimer = setTimeout(async () => {
    state.prewarmTimer = null;
    try {
      await apiFetch("/api/render/prewarm", {
        method: "POST",
        priority: "low",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ renderMode }),
      });
    } catch (_error) {
      // 事前生成は投機的処理。失敗しても明示クリック時に通常レンダーを試みる。
    }
    if (generation !== state.prewarmGeneration) return;
  }, PREWARM_DELAY_MS);
}

function handleRenderModeChange(event) {
  if (!event.target.checked) return;
  state.renderMode = event.target.value;
  resetPlayer();
  if (state.session) state.session.hasRender = false;
  updateSectionsReadiness();
  schedulePrewarm();
  const label = state.renderMode === "quality" ? "品質" : "高速";
  showStatus(`試聴モードを${label}へ切り替えました。`);
}

// GM音色カタログを一度だけ取得し、16 <optgroup> のDocumentFragmentを構築する。
// JS側にGM名をハードコードせず、常にサーバー側 gm.py を単一のソースとする。
async function loadInstrumentOptions() {
  if (state.optionsFragment) return state.optionsFragment;
  const response = await apiFetch("/api/instruments");
  const payload = await response.json();
  const fragment = document.createDocumentFragment();
  for (const family of payload.families) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = family.name;
    for (const item of family.programs) {
      const option = document.createElement("option");
      option.value = String(item.program);
      // GM番号は表示上1始まり、送信値（value）は0始まり。
      option.textContent = `${item.program + 1}. ${item.name}`;
      state.programNames[item.program] = option.textContent;
      optgroup.appendChild(option);
    }
    fragment.appendChild(optgroup);
  }
  state.optionsFragment = fragment;
  return fragment;
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

function renderSoundfontOptions(payload) {
  state.soundfontPayload = payload;
  const select = $("#soundfont-select");
  select.innerHTML = "";

  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = "既定（自動選択）";
  select.appendChild(defaultOption);

  for (const item of payload.items) {
    const option = document.createElement("option");
    option.value = item.path;
    option.textContent = `${item.name} (${formatBytes(item.sizeBytes)}) — ${item.dir}`;
    select.appendChild(option);
  }
  select.value = payload.selected || "";

  const help = $("#soundfont-help");
  if (payload.items.length === 0) {
    help.textContent =
      "SoundFontが見つかりません。MIDI2WAV_SOUNDFONT環境変数か起動時の --soundfont で指定してください。";
  } else if (payload.isOverride) {
    help.textContent = "選択したSoundFontを使用します。";
  } else {
    help.textContent =
      "既定の解決順（起動時の --soundfont / MIDI2WAV_SOUNDFONT環境変数 / 検索ディレクトリ）で選ばれます。";
  }
  if (state.session && state.session.hasGameSoundfont) {
    help.textContent += " ここで選んだSoundFontは、音源をSoundFontにしたトラックに適用されます。";
  }
}

async function loadSoundfonts() {
  try {
    const response = await apiFetch("/api/soundfonts");
    renderSoundfontOptions(await response.json());
  } catch (error) {
    showStatus(error.message, "error");
  }
}

async function handleSoundfontChange() {
  const select = $("#soundfont-select");
  const path = select.value || null;
  try {
    const response = await apiFetch("/api/soundfont", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    renderSoundfontOptions(await response.json());
    resetPlayer();
    if (state.session) {
      state.session.hasRender = false;
    }
    updateSectionsReadiness();
    schedulePrewarm();
    showStatus("SoundFontを変更しました。もう一度「適用して試聴」を押してください。");
  } catch (error) {
    showStatus(error.message, "error");
  }
}

function formatCurrentProgram(track) {
  if (track.currentProgram === null || track.currentProgram === undefined) {
    return "未設定";
  }
  return `${track.currentProgram + 1}番`;
}

// "game"（原曲の音源）が実機チップレンダリング（libvgm/nsf2midi）を意味する
// フォーマットかどうか。SPCの"game"はBRRサンプル由来SoundFontのバンク切替
// なので含めない（音量スライダーは引き続き有効にする）。
// miditrack/src/miditrack/web.py の CHIP_HARDWARE_SOURCE_FORMATS と対応させる。
const CHIP_HARDWARE_SOURCE_FORMATS = ["vgm", "nsf"];

function isChipHardwareFormat() {
  return !!(
    state.session &&
    state.session.source &&
    CHIP_HARDWARE_SOURCE_FORMATS.includes(state.session.source.format)
  );
}

function reasonLabel(reason) {
  switch (reason) {
    case "percussion":
      return "パーカッション（ch10）のため変更できません";
    case "multi-channel":
      return "複数チャンネルを含むため変更できません";
    case "no-notes":
      return "ノートがないため変更できません";
    default:
      return "変更できません";
  }
}

function showTrackWarningTooltip(button, tooltip) {
  if (!tooltip.matches(":popover-open")) tooltip.showPopover();
  const buttonRect = button.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const left = Math.max(
    12,
    Math.min(window.innerWidth - tooltipRect.width - 12, buttonRect.left + buttonRect.width / 2 - tooltipRect.width / 2),
  );
  const spaceAbove = buttonRect.top - tooltipRect.height - 8;
  const top = spaceAbove >= 12 ? spaceAbove : buttonRect.bottom + 8;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function hideTrackWarningTooltip(tooltip) {
  if (tooltip.matches(":popover-open")) tooltip.hidePopover();
}

function createTrackWarningControl(track, warningText) {
  const button = document.createElement("button");
  const tooltip = document.createElement("span");
  tooltip.id = `track-warning-${track.index}`;
  tooltip.className = "track-warning-tooltip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.setAttribute("popover", "manual");
  tooltip.textContent = warningText;
  button.type = "button";
  button.className = "track-warning-button";
  button.textContent = "⚠";
  button.setAttribute("aria-label", `${track.name}の警告`);
  button.setAttribute("aria-describedby", tooltip.id);
  button.addEventListener("mouseenter", () => showTrackWarningTooltip(button, tooltip));
  button.addEventListener("mouseleave", () => {
    if (document.activeElement !== button) hideTrackWarningTooltip(tooltip);
  });
  button.addEventListener("focus", () => showTrackWarningTooltip(button, tooltip));
  button.addEventListener("blur", () => hideTrackWarningTooltip(tooltip));
  return { button, tooltip };
}

// ネイティブ<select>のポップアップが開いている間はOSネイティブUIがキー入力を
// 奪うため、「ドロップダウンを開いた後でCmd/Ctrlを押す」操作をJS側で検知する
// 確実な方法が無い。またchangeイベント自体も、選んだ値が変更前と同じ場合は
// 発火しない。そのため<select>ではmousedown時点でこの判定を行い、真なら
// event.preventDefault()でポップアップ自体を開かせず、その場で現在の値を
// 全トラックへ適用する（つまりCmd/Ctrl+クリックは「値を変える」操作ではなく
// 「今の値を揃える」操作になる。値を変えてから揃えたい場合は、まず普通に
// クリックして値を変え、その後もう一度Cmd/Ctrl+クリックする）。
// ボタン（ミュートボタン）はポップアップを持たないため、通常のclickイベントで
// そのままこの判定を使える。
function isBulkApplyEvent(event) {
  return event.metaKey || event.ctrlKey;
}

// Cmd/Ctrlを押しながらの音源選択で、他の全トラックの音源セレクトも同じ値に
// 揃える。選択肢が無い（その値を持たない）行や、既に同じ値の行はスキップする。
function applySourceToAllTracks(value, originIndex) {
  let appliedCount = 0;
  for (const row of state.trackRows) {
    if (!row.sourceSelect || row.index === originIndex) continue;
    if (row.sourceSelect.value === value) continue;
    if (!Array.from(row.sourceSelect.options).some((option) => option.value === value)) continue;
    row.sourceSelect.value = value;
    row.sourceSelect.dispatchEvent(new Event("change", { bubbles: true }));
    appliedCount += 1;
  }
  if (appliedCount > 0) showStatus(`他${appliedCount}トラックの音源も揃えました。`);
}

// Cmd/Ctrlを押しながらの楽器選択で、編集可能な他の全トラックの楽器も同じ
// GMプログラムに揃える。
function applyProgramToAllTracks(value, originIndex) {
  let appliedCount = 0;
  for (const row of state.trackRows) {
    if (!row.programSelect || row.programSelect.disabled || row.index === originIndex) continue;
    if (row.programSelect.value === value) continue;
    row.programSelect.value = value;
    row.programSelect.dispatchEvent(new Event("change", { bubbles: true }));
    appliedCount += 1;
  }
  if (appliedCount > 0) showStatus(`他${appliedCount}トラックの楽器も揃えました。`);
}

// Cmd/Ctrlを押しながらのミュート切り替えで、他の全トラックも同じミュート
// 状態（ミュート／解除）に揃える。解除時は各トラックが個別に覚えている
// 直前の音量へそれぞれ戻る（一律の音量に揃えるわけではない）。
function applyMuteToAllTracks(shouldMute, originIndex) {
  let appliedCount = 0;
  for (const row of state.trackRows) {
    if (!row.muteButton || !row.volumeSlider || row.index === originIndex) continue;
    const isMuted = Number(row.volumeSlider.value) === 0;
    if (isMuted === shouldMute) continue;
    row.muteButton.click();
    appliedCount += 1;
  }
  if (appliedCount > 0) {
    showStatus(`他${appliedCount}トラックも${shouldMute ? "ミュート" : "ミュート解除"}しました。`);
  }
}

async function buildTrackRow(track, rowState = state) {
  const row = document.createElement("tr");
  row.className = "track-row";
  if (!track.editable) row.classList.add("is-locked");

  // Cmd/Ctrl+操作での「全トラックに同じ設定を適用」用に、この行のコントロール
  // 参照をstate.trackRowsへ集める（renderTrackList()が描画のたびにリセットする）。
  const trackRowRef = {
    index: track.index,
    sourceVolumePercent: track.sourceVolumePercent ?? 100,
    sourceSelect: null,
    programSelect: null,
    volumeSlider: null,
    muteButton: null,
    soloButton: null,
  };
  rowState.trackRows.push(trackRowRef);

  const nameCell = document.createElement("td");
  nameCell.className = "track-name-cell";
  const nameLabel = document.createElement("div");
  nameLabel.className = "track-name";
  const colorBar = document.createElement("span");
  colorBar.className = "track-color-bar";
  colorBar.setAttribute("aria-hidden", "true");
  colorBar.style.setProperty("--track-color", getTrackColor(track.index, state.session?.tracks.length || 1));
  const nameText = document.createElement("span");
  nameText.className = "track-name-text";
  nameText.textContent = track.name;
  nameLabel.append(colorBar, nameText);
  nameCell.appendChild(nameLabel);
  row.appendChild(nameCell);

  const channelCell = document.createElement("td");
  channelCell.className = "track-channel";
  channelCell.textContent = track.channels.length
    ? track.channels.map((c) => c + 1).join(", ")
    : "—";
  row.appendChild(channelCell);

  const sourceCell = document.createElement("td");
  if (track.availableSources.length > 1) {
    const sourceSelect = document.createElement("select");
    sourceSelect.className = "source-select";
    sourceSelect.setAttribute("aria-label", `${track.name}の音源`);
    for (const source of track.availableSources) {
      const option = document.createElement("option");
      option.value = source;
      if (source === "game") {
        option.textContent = track.sourceSuggested ? "原曲の音源（推奨）" : "原曲の音源";
      } else option.textContent = "SoundFont";
      sourceSelect.appendChild(option);
    }
    sourceSelect.value = track.source;
    if (track.sourceGroupSize > 1) {
      sourceSelect.title = `同じ物理チャンネルを共有する${track.sourceGroupSize}トラックを同時に切り替えます`;
    }
    sourceSelect.addEventListener("change", () => {
      const isHardware = sourceSelect.value === "game" && isChipHardwareFormat();
      row.classList.toggle("is-hardware", isHardware);
      const programSelect = row.querySelector(".program-select");
      if (programSelect) {
        programSelect.disabled = sourceSelect.value !== "soundfont";
        if (
          sourceSelect.value === "soundfont" &&
          track.availableSources.includes("game") &&
          programSelect.value === KEEP_ORIGINAL
        ) {
          programSelect.value = DEFAULT_GM_PROGRAM;
          onProgramChange(track.index, programSelect.value);
        }
      }
      onSourceChange(track.index, sourceSelect.value);
    });
    // Cmd/Ctrlを押しながらのクリックはドロップダウンを開かせず、その場で
    // 現在の値を全トラックへ適用する（isBulkApplyEvent()参照: ポップアップが
    // 開いている間はOSネイティブUIがキー操作を奪うため、開いた後のキー入力を
    // 確実に検知する手段が無い。値を変えてから揃えたい場合は、まず普通に
    // クリックして値を変え、その後もう一度Cmd/Ctrl+クリックする）。
    sourceSelect.addEventListener("mousedown", (event) => {
      if (isBulkApplyEvent(event)) {
        event.preventDefault();
        applySourceToAllTracks(sourceSelect.value, track.index);
      }
    });
    trackRowRef.sourceSelect = sourceSelect;
    sourceCell.appendChild(sourceSelect);
  } else {
    sourceCell.textContent = track.source === "game" ? "原曲の音源" : "SoundFont";
  }
  row.classList.toggle("is-hardware", track.source === "game" && isChipHardwareFormat());
  row.appendChild(sourceCell);

  const instrumentCell = document.createElement("td");
  instrumentCell.className = "track-instrument-cell";
  if (track.editable) {
    const fragment = await loadInstrumentOptions();
    const select = document.createElement("select");
    select.className = "program-select instrument-select";
    select.dataset.trackIndex = String(track.index);

    const keepOption = document.createElement("option");
    keepOption.value = KEEP_ORIGINAL;
    const hasGameSource = track.availableSources.includes("game");
    keepOption.textContent = hasGameSource
      ? "GM音色を選択してください"
      : `変更しない（現在: ${formatCurrentProgram(track)}）`;
    keepOption.disabled = hasGameSource;
    select.appendChild(keepOption);
    const favoritesGroup = buildFavoriteProgramsOptgroup();
    if (favoritesGroup) select.appendChild(favoritesGroup);
    select.appendChild(fragment.cloneNode(true));

    select.value =
      track.assignedProgram !== null && track.assignedProgram !== undefined
        ? String(track.assignedProgram)
        : KEEP_ORIGINAL;
    select.disabled = track.source !== "soundfont";

    const pinButton = document.createElement("button");
    pinButton.type = "button";
    pinButton.className = "pin-button";
    pinButton.setAttribute("aria-label", "よく使う楽器としてピン留め");
    const updatePinButton = () => {
      const program = select.value === KEEP_ORIGINAL ? null : Number(select.value);
      const pinned = isProgramPinned(program);
      pinButton.textContent = pinned ? "★" : "☆";
      pinButton.title = pinned ? "ピン留めを解除" : "よく使う楽器としてピン留め";
      pinButton.classList.toggle("is-pinned", pinned);
      pinButton.disabled = program === null;
    };
    updatePinButton();

    select.addEventListener("change", () => {
      onProgramChange(track.index, select.value);
      updatePinButton();
    });
    // sourceSelectと同じ理由でmousedown+preventDefault方式にする
    // （isBulkApplyEvent()参照）。KEEP_ORIGINALのまま揃えても意味が無いので
    // スキップする。
    select.addEventListener("mousedown", (event) => {
      if (isBulkApplyEvent(event) && select.value !== KEEP_ORIGINAL) {
        event.preventDefault();
        applyProgramToAllTracks(select.value, track.index);
      }
    });
    pinButton.addEventListener("click", () => {
      if (select.value === KEEP_ORIGINAL) return;
      toggleProgramPinned(Number(select.value));
    });
    rowState.instrumentRows.push({ select, updatePinButton });
    trackRowRef.programSelect = select;

    const selectRow = document.createElement("div");
    selectRow.className = "instrument-select-row";
    selectRow.appendChild(select);
    selectRow.appendChild(pinButton);
    if (track.programChangeCount > 1) {
      const warningText = "曲中で楽器が変わります。適用するとすべて上書きされます";
      const warningControl = createTrackWarningControl(track, warningText);
      selectRow.appendChild(warningControl.button);
      instrumentCell.appendChild(warningControl.tooltip);
    }
    instrumentCell.appendChild(selectRow);
  } else {
    const reason = document.createElement("span");
    reason.className = "lock-reason";
    reason.textContent = reasonLabel(track.reason);
    instrumentCell.appendChild(reason);
  }
  row.appendChild(instrumentCell);

  const volumeCell = document.createElement("td");
  if (track.volumeEditable) {
    const control = document.createElement("div");
    control.className = "track-volume-control";

    const inputId = `track-volume-${track.index}`;
    const label = document.createElement("label");
    label.className = "visually-hidden";
    label.htmlFor = inputId;
    label.textContent = `${track.name}の音量`;

    const slider = document.createElement("input");
    slider.id = inputId;
    slider.type = "range";
    slider.min = "0";
    slider.max = "200";
    slider.step = "5";
    slider.value = String(track.volumePercent ?? track.sourceVolumePercent ?? 100);
    // 「原曲の音源」（実機/エミュレーションのチップレンダリング）でも音量は
    // 有効: 音量を変更したチャンネルだけサーバー側で個別に再レンダリングして
    // ゲインを適用する（web.pyの_render_chip_hardware()参照）。
    slider.dataset.trackIndex = String(track.index);
    slider.setAttribute("aria-valuetext", `${slider.value}%`);

    const value = document.createElement("output");
    value.className = "track-volume-value";
    value.setAttribute("for", inputId);
    value.value = `${slider.value}%`;
    value.textContent = value.value;

    // ミュート解除時に戻す音量。0%でない値でミュートボタンを押したときだけ更新する
    // （ミュート中にスライダーを直接動かした場合は、そちらを新しい基準にする）。
    // フォールバックはtrack.sourceVolumePercent（変換元CC7由来の初期値、通常100）。
    let volumeBeforeMute = Number(slider.value) || track.sourceVolumePercent || 100;

    const muteButton = document.createElement("button");
    muteButton.type = "button";
    muteButton.className = "mute-button";
    const updateMuteButton = () => {
      const isMuted = Number(slider.value) === 0;
      muteButton.textContent = isMuted ? "🔇" : "🔊";
      muteButton.title = isMuted ? "ミュートを解除" : "ミュート";
      muteButton.setAttribute("aria-label", `${track.name}を${isMuted ? "ミュート解除" : "ミュート"}`);
      muteButton.classList.toggle("is-muted", isMuted);
    };
    updateMuteButton();

    // inputはドラッグ中に連続発火するので表示更新のみ行い、サーバーへの反映
    // （onVolumeChange、ひいてはPATCH成功後のrenderTrackList()）はchange
    // （ドラッグ確定＝mouseup、またはキーボード操作の確定）にのみ委ねる。
    // input発火のたびにonVolumeChangeを呼ぶと、ドラッグ中に200msデバウンスが
    // 満了してflushPendingTrackSettings()が走り、renderTrackList()がtbody
    // 全体を作り直してしまう ― ドラッグ対象のslider要素自体がDOMから消え、
    // ブラウザのポインタキャプチャが失われてドラッグが強制終了してしまうため。
    slider.addEventListener("input", () => {
      value.value = `${slider.value}%`;
      value.textContent = value.value;
      slider.setAttribute("aria-valuetext", value.value);
      if (Number(slider.value) > 0) volumeBeforeMute = Number(slider.value);
      updateMuteButton();
    });
    slider.addEventListener("change", () => {
      onVolumeChange(track.index, Number(slider.value));
    });
    muteButton.addEventListener("click", (event) => {
      const willMute = Number(slider.value) !== 0;
      slider.value = willMute ? "0" : String(volumeBeforeMute);
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      onVolumeChange(track.index, Number(slider.value));
      if (isBulkApplyEvent(event)) {
        applyMuteToAllTracks(willMute, track.index);
      }
    });

    // 他の全トラックを一時的に音量0へ落として即レンダリング・再生する
    // 「ソロ試聴」ボタン。他のトラックをミュートしてから「適用して試聴」を
    // 押す操作をワンクリックにまとめたもので、サーバー側の状態やAPIは
    // 既存のPATCH /api/session/tracks・POST /api/renderをそのまま使う
    // （新しいエンドポイントは追加しない）。
    const soloButton = document.createElement("button");
    soloButton.type = "button";
    soloButton.className = "solo-button";
    const updateSoloButton = () => {
      const isSolo = state.soloTrackIndex === track.index;
      soloButton.textContent = "🎧";
      soloButton.title = isSolo ? "ソロ試聴を解除" : "このトラックだけを試聴";
      soloButton.setAttribute("aria-label", `${track.name}を${isSolo ? "ソロ試聴解除" : "ソロ試聴"}`);
      soloButton.classList.toggle("is-solo", isSolo);
    };
    updateSoloButton();
    soloButton.addEventListener("click", () => {
      toggleTrackSolo(track.index);
    });

    trackRowRef.volumeSlider = slider;
    trackRowRef.muteButton = muteButton;
    trackRowRef.soloButton = soloButton;
    trackRowRef.updateSoloButton = updateSoloButton;

    control.appendChild(label);
    control.appendChild(muteButton);
    control.appendChild(soloButton);
    control.appendChild(slider);
    control.appendChild(value);
    volumeCell.appendChild(control);
  } else {
    volumeCell.textContent = "—";
  }
  row.appendChild(volumeCell);
  return row;
}

// ソロ試聴中に音色・音量・音源のいずれかを直接操作した場合、ソロを解除する。
// スナップショットを捨てるだけだと、ソロ中にミュート（音量0）されていた
// 他トラックがそのまま音量0でサーバー側に残ってしまい、次に同じ🎧を押した
// ときに「今の（既にミュート済みの）音量」を新しい戻し先として上書き保存
// してしまい、元の音量が永久に失われる。そこで、他トラックの音量を
// pendingVolumesへスナップショットの値で積んでおき、今回の操作（PATCH）に
// 相乗りする形で元に戻す。今操作しているトラック自身の値は呼び出し元が
// この直後に上書きするので、既にpendingVolumesにある値は上書きしない。
function clearSoloStateIfActive() {
  const snapshot = state.soloVolumeSnapshot;
  state.soloTrackIndex = null;
  state.soloVolumeSnapshot = null;
  for (const row of state.trackRows) {
    row.updateSoloButton?.();
  }
  if (!snapshot) return;
  for (const [trackIndexKey, volumePercent] of Object.entries(snapshot)) {
    const trackIndex = Number(trackIndexKey);
    if (!(trackIndex in state.pendingVolumes)) state.pendingVolumes[trackIndex] = volumePercent;
  }
}

function onProgramChange(trackIndex, value) {
  clearSoloStateIfActive();
  state.pendingAssignments[trackIndex] = value === KEEP_ORIGINAL ? null : Number(value);
  if (value !== KEEP_ORIGINAL) recordProgramUsage(Number(value));
  clearTimeout(state.patchTimer);
  state.patchTimer = setTimeout(flushPendingTrackSettings, 200);
}

function onVolumeChange(trackIndex, volumePercent) {
  clearSoloStateIfActive();
  state.pendingVolumes[trackIndex] = volumePercent;
  clearTimeout(state.patchTimer);
  state.patchTimer = setTimeout(flushPendingTrackSettings, 200);
}

function onSourceChange(trackIndex, source) {
  clearSoloStateIfActive();
  state.pendingSources[trackIndex] = source;
  clearTimeout(state.patchTimer);
  state.patchTimer = setTimeout(flushPendingTrackSettings, 200);
}

// 指定トラック以外を音量0にしてレンダリング・再生する「ソロ試聴」を
// 開始／解除する。もう一度同じボタンを押すと解除に切り替わる。
async function toggleTrackSolo(trackIndex) {
  if (state.soloTrackIndex === trackIndex) {
    await exitSolo();
  } else {
    await enterSolo(trackIndex);
  }
}

function collectCurrentVolumes() {
  const volumes = {};
  for (const row of state.trackRows) {
    if (!row.volumeSlider) continue;
    volumes[row.index] = Number(row.volumeSlider.value);
  }
  return volumes;
}

async function enterSolo(trackIndex) {
  clearTimeout(state.patchTimer);
  if (!(await flushPendingTrackSettings())) return;

  // 既にソロ中の別トラックへ切り替える場合は、最初にソロへ入る前の
  // スナップショットを保持し続ける（切り替えるたびに上書きしない）。
  if (state.soloVolumeSnapshot === null) {
    state.soloVolumeSnapshot = collectCurrentVolumes();
  }

  const volumes = {};
  for (const row of state.trackRows) {
    if (!row.volumeSlider) continue;
    if (row.index === trackIndex) {
      const baseline = row.sourceVolumePercent ?? 100;
      const original = state.soloVolumeSnapshot[row.index] ?? baseline;
      volumes[row.index] = original === 0 ? baseline : original;
    } else {
      volumes[row.index] = 0;
    }
  }

  setBusy(true, "ソロ試聴の準備中…");
  try {
    const response = await apiFetch("/api/session/tracks", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ volumes }),
    });
    state.session = await response.json();
    state.soloTrackIndex = trackIndex;
    await renderTrackList();
    updateSectionsReadiness();
    const player = await renderAndLoadPlayer();
    player.play().catch(() => {});
    showStatus("ソロ試聴中です。もう一度🎧を押すと解除します。", "success");
  } catch (error) {
    state.soloTrackIndex = null;
    showStatus(error.message, "error");
  } finally {
    setBusy(false);
  }
}

async function exitSolo() {
  const snapshot = state.soloVolumeSnapshot;
  state.soloTrackIndex = null;
  state.soloVolumeSnapshot = null;
  if (!snapshot) return;

  setBusy(true, "音量を元に戻しています…");
  try {
    const response = await apiFetch("/api/session/tracks", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ volumes: snapshot }),
    });
    state.session = await response.json();
    await renderTrackList();
    updateSectionsReadiness();
    resetPlayer();
    showStatus("ソロ試聴を解除しました。もう一度「適用して試聴」を押してください。");
  } catch (error) {
    showStatus(error.message, "error");
  } finally {
    setBusy(false);
  }
}

async function flushPendingTrackSettings() {
  if (state.patchPromise) {
    const activePatchSucceeded = await state.patchPromise;
    if (!activePatchSucceeded) return false;
    return flushPendingTrackSettings();
  }

  const assignments = state.pendingAssignments;
  const volumes = state.pendingVolumes;
  const sources = state.pendingSources;
  state.pendingAssignments = {};
  state.pendingVolumes = {};
  state.pendingSources = {};
  if (Object.keys(assignments).length === 0 && Object.keys(volumes).length === 0 && Object.keys(sources).length === 0) return true;

  const patchPromise = (async () => {
    try {
      const response = await apiFetch("/api/session/tracks", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignments, volumes, sources }),
      });
      state.session = await response.json();
      await renderTrackList();
      redrawPianorollStatic();
      resetPlayer();
      schedulePrewarm();
      showStatus("設定を変更しました。もう一度「適用して試聴」を押してください。");
      return true;
    } catch (error) {
      showStatus(error.message, "error");
      return false;
    }
  })();
  state.patchPromise = patchPromise;
  const didSucceed = await patchPromise;
  if (state.patchPromise === patchPromise) state.patchPromise = null;
  if (!didSucceed) return false;
  return flushPendingTrackSettings();
}

function trackSortValue(track, key) {
  if (key === "index") return track.index;
  if (key === "channel") return track.channels[0] ?? null;
  if (key === "source") return track.source || "";
  if (key === "instrument") return track.assignedProgram ?? track.currentProgram ?? -1;
  if (key === "volume") return track.volumePercent;
  return track.index;
}

function compareTrackValues(left, right, key) {
  const leftValue = trackSortValue(left, key);
  const rightValue = trackSortValue(right, key);
  if (key === "channel" && (leftValue === null || rightValue === null)) {
    if (leftValue === rightValue) return 0;
    return leftValue === null ? 1 : -1;
  }
  if (typeof leftValue === "string") return leftValue.localeCompare(rightValue, "ja");
  return leftValue - rightValue;
}

function sortedTracks(tracks) {
  const direction = state.trackSort.direction === "asc" ? 1 : -1;
  return tracks.slice().sort((left, right) => {
    const comparison = compareTrackValues(left, right, state.trackSort.key);
    if (state.trackSort.key === "channel" && (
      trackSortValue(left, "channel") === null || trackSortValue(right, "channel") === null
    )) return comparison;
    return comparison * direction;
  });
}

function updateSortHeaders() {
  document.querySelectorAll(".track-table th[data-sort-key]").forEach((header) => {
    const isActive = header.dataset.sortKey === state.trackSort.key;
    if (isActive) header.setAttribute("aria-sort", state.trackSort.direction === "asc" ? "ascending" : "descending");
    else header.removeAttribute("aria-sort");
    const indicator = header.querySelector(".sort-indicator");
    if (indicator) indicator.textContent = isActive
      ? (state.trackSort.direction === "asc" ? "▲" : "▼")
      : "";
  });
}

async function renderTrackList() {
  const renderId = ++state.trackRenderId;
  const visibleTracks = state.session
    ? state.session.tracks.filter((track) => !state.hideEmptyTracks || track.noteCount > 0)
    : [];
  const tracks = sortedTracks(visibleTracks);
  const fragment = document.createDocumentFragment();
  const rowState = { instrumentRows: [], trackRows: [] };
  for (const track of tracks) fragment.appendChild(await buildTrackRow(track, rowState));
  if (renderId !== state.trackRenderId) return;
  state.instrumentRows = rowState.instrumentRows;
  state.trackRows = rowState.trackRows;
  $("#track-list").replaceChildren(fragment);
  $("#tracks-empty").hidden = tracks.length > 0;
  updateSortHeaders();
}

function setupTrackSorting() {
  document.querySelectorAll(".sort-button").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.sortKey;
      if (state.trackSort.key === key) {
        state.trackSort.direction = state.trackSort.direction === "asc" ? "desc" : "asc";
      } else {
        state.trackSort = { key, direction: "asc" };
      }
      renderTrackList();
    });
  });
}

function cssColor(name, fallback) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function getTrackColor(trackIndex, trackCount, opacity = 1) {
  const hue = (trackIndex / Math.max(1, trackCount)) * 360;
  return `hsl(${hue} 68% 48% / ${opacity})`;
}

function formatPianorollTime(seconds) {
  const safeSeconds = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = Math.floor(safeSeconds % 60);
  return minutes > 0 ? `${minutes}分${remainder}秒` : `${remainder}秒`;
}

function formatPlaybackClock(seconds) {
  const totalTenths = Math.max(0, Math.floor((Number(seconds) || 0) * 10));
  const minutes = Math.floor(totalTenths / 600);
  const remainder = totalTenths % 600;
  const wholeSeconds = Math.floor(remainder / 10);
  const tenths = remainder % 10;
  return {
    whole: `${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}`,
    decimal: String(tenths),
  };
}

function setPianorollMessage(message, status = "") {
  $("#pianoroll-empty").textContent = message;
  $("#pianoroll-empty").hidden = !message;
  $("#pianoroll-status").textContent = status;
}

function clearPianoroll(message = "MIDIを読み込むとここに表示されます。") {
  state.pianoroll = null;
  state.pianorollBase.width = 0;
  state.pianorollBase.height = 0;
  resetPianorollZoom();
  setPianorollMessage(message);
  updatePianorollInteraction();
  drawPianoroll();
}

async function loadPianoroll() {
  const loadId = ++state.pianorollLoadId;
  if (!state.session || state.session.tracks.length === 0) {
    clearPianoroll();
    return;
  }
  setPianorollMessage("ピアノロールを読み込み中…");
  try {
    const response = await apiFetch("/api/pianoroll");
    const payload = await response.json();
    if (loadId !== state.pianorollLoadId) return;
    state.pianoroll = payload;
    updatePlaybackTime();
    const status = payload.truncated
      ? "ノート数が表示上限を超えたため、先頭部分のみ表示しています。"
      : "";
    setPianorollMessage(payload.noteCount > 0 ? "" : "表示できるノートがありません。", status);
    redrawPianorollStatic();
    updatePianorollInteraction();
    updatePianorollZoomControls();
  } catch (error) {
    if (loadId !== state.pianorollLoadId) return;
    clearPianoroll("ピアノロールを読み込めませんでした。");
    $("#pianoroll-status").textContent = error.message;
  }
}

function pianorollFieldOffsets(payload) {
  return Object.fromEntries(payload.fields.map((field, index) => [field, index]));
}

function drawPianorollGrid(context, width, height) {
  context.fillStyle = cssColor("--neutral-10", "#fafbfc");
  context.fillRect(0, 0, width, height);
  context.strokeStyle = cssColor("--neutral-30", "#ebecf0");
  context.lineWidth = 1;
  context.beginPath();
  for (let index = 1; index < 8; index += 1) {
    const x = Math.round(width * index / 8) + 0.5;
    context.moveTo(x, 0);
    context.lineTo(x, height);
  }
  for (let index = 1; index < 6; index += 1) {
    const y = Math.round(height * index / 6) + 0.5;
    context.moveTo(0, y);
    context.lineTo(width, y);
  }
  context.stroke();
}

function drawPianorollTrack(context, track, layout, mutedIndices) {
  const { payload, offsets, width, height, minNote, noteSpan, trackCount } = layout;
  context.fillStyle = getTrackColor(
    track.index,
    trackCount,
    mutedIndices.has(track.index) ? 0.18 : 0.72,
  );
  for (let offset = 0; offset < track.notes.length; offset += payload.stride) {
    const start = track.notes[offset + offsets.start];
    const duration = track.notes[offset + offsets.duration];
    const note = track.notes[offset + offsets.note];
    const x = start / payload.durationSeconds * width;
    const noteWidth = Math.max(1, duration / payload.durationSeconds * width);
    const y = height - ((note - minNote + 1) / noteSpan * height);
    context.fillRect(x, y, noteWidth, Math.max(1.5, height / noteSpan * 0.72));
  }
}

function redrawPianorollStatic() {
  const payload = state.pianoroll;
  const size = state.pianorollSize;
  if (!payload || !size || size.width <= 0 || size.height <= 0) return;
  const base = state.pianorollBase;
  base.width = size.pixelWidth;
  base.height = size.pixelHeight;
  const context = base.getContext("2d");
  context.setTransform(size.scaleX, 0, 0, size.scaleY, 0, 0);
  drawPianorollGrid(context, size.width, size.height);
  if (payload.noteCount > 0 && payload.durationSeconds > 0) {
    const mutedIndices = new Set((state.session?.tracks || [])
      .filter((track) => track.volumePercent === 0).map((track) => track.index));
    const layout = {
      payload, offsets: pianorollFieldOffsets(payload), width: size.width, height: size.height,
      minNote: payload.minNote, noteSpan: payload.maxNote - payload.minNote + 3,
      trackCount: payload.tracks.length,
    };
    for (const track of payload.tracks) drawPianorollTrack(context, track, layout, mutedIndices);
  }
  drawPianoroll();
}

function drawPianoroll() {
  const canvas = $("#pianoroll-canvas");
  const context = canvas.getContext("2d");
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (state.pianorollBase.width > 0) context.drawImage(state.pianorollBase, 0, 0);
  const payload = state.pianoroll;
  const size = state.pianorollSize;
  if (!payload || !size || payload.durationSeconds <= 0) return;
  const seconds = Math.min(payload.durationSeconds, $("#player").currentTime || 0);
  context.setTransform(size.scaleX, 0, 0, size.scaleY, 0, 0);
  context.strokeStyle = cssColor("--brand-dark", "#5674b9");
  context.lineWidth = 2;
  context.beginPath();
  const x = seconds / payload.durationSeconds * size.width;
  context.moveTo(x, 0);
  context.lineTo(x, size.height);
  context.stroke();
  updatePianorollAria(seconds);
}

function updatePianorollAria(seconds = 0) {
  const canvas = $("#pianoroll-canvas");
  const maximum = state.pianoroll?.durationSeconds || 0;
  const current = Math.min(maximum, Math.max(0, seconds));
  canvas.setAttribute("aria-valuemax", String(maximum));
  canvas.setAttribute("aria-valuenow", String(Number(current.toFixed(3))));
  canvas.setAttribute("aria-valuetext", formatPianorollTime(current));
}

function updatePianorollInteraction() {
  const canvas = $("#pianoroll-canvas");
  const canSeek = !!(state.session?.hasRender && state.pianoroll?.durationSeconds > 0);
  canvas.classList.toggle("is-seekable", canSeek);
  canvas.setAttribute("aria-disabled", String(!canSeek));
  updatePianorollAria($("#player").currentTime || 0);
}

function updatePianorollZoomControls() {
  const zoomIndex = PIANOROLL_ZOOM_LEVELS.indexOf(state.pianorollZoom);
  const canZoom = !!state.pianoroll?.durationSeconds;
  $("#pianoroll-zoom-out").disabled = !canZoom || zoomIndex <= 0;
  $("#pianoroll-zoom-in").disabled = !canZoom || zoomIndex >= PIANOROLL_ZOOM_LEVELS.length - 1;
  $("#pianoroll-zoom-value").textContent = `${state.pianorollZoom}×`;
}

function setPianorollAutoFollow(isFollowing) {
  state.isPianorollAutoFollowing = isFollowing;
  if (!isFollowing) state.pianorollAutoScrollTarget = null;
}

function scrollPianorollToStart() {
  const scrollArea = $("#pianoroll-scroll");
  state.pianorollAutoScrollTarget = 0;
  scrollArea.scrollLeft = 0;
}

function followPianorollPlayback() {
  if (!state.isPianorollAutoFollowing || !state.pianoroll?.durationSeconds) return;
  const scrollArea = $("#pianoroll-scroll");
  const canvas = $("#pianoroll-canvas");
  const canvasWidth = canvas.getBoundingClientRect().width;
  const viewportHalf = scrollArea.clientWidth / 2;
  const progress = Math.min(1, $("#player").currentTime / state.pianoroll.durationSeconds);
  const playheadX = progress * canvasWidth;
  if (playheadX <= viewportHalf) return;
  const maximumScroll = Math.max(0, canvasWidth - scrollArea.clientWidth);
  const target = Math.min(maximumScroll, Math.max(0, playheadX - viewportHalf));
  if (Math.abs(scrollArea.scrollLeft - target) < 0.5) return;
  state.pianorollAutoScrollTarget = target;
  scrollArea.scrollLeft = target;
}

function handlePianorollScroll() {
  const target = state.pianorollAutoScrollTarget;
  if (target !== null && Math.abs($("#pianoroll-scroll").scrollLeft - target) < 1) {
    state.pianorollAutoScrollTarget = null;
    return;
  }
  setPianorollAutoFollow(false);
}

function setPianorollZoom(zoom, shouldPreserveCenter = true) {
  const canvas = $("#pianoroll-canvas");
  const scrollArea = $("#pianoroll-scroll");
  const previousWidth = canvas.getBoundingClientRect().width;
  const centerRatio = previousWidth > 0
    ? (scrollArea.scrollLeft + scrollArea.clientWidth / 2) / previousWidth
    : 0;
  state.pianorollZoom = zoom;
  canvas.style.inlineSize = `${zoom * 100}%`;
  updatePianorollZoomControls();
  requestAnimationFrame(() => {
    const nextWidth = canvas.getBoundingClientRect().width;
    scrollArea.scrollLeft = shouldPreserveCenter
      ? centerRatio * nextWidth - scrollArea.clientWidth / 2
      : 0;
  });
}

function changePianorollZoom(direction) {
  const currentIndex = PIANOROLL_ZOOM_LEVELS.indexOf(state.pianorollZoom);
  const nextIndex = Math.min(
    PIANOROLL_ZOOM_LEVELS.length - 1,
    Math.max(0, currentIndex + direction),
  );
  if (nextIndex !== currentIndex) {
    setPianorollAutoFollow(false);
    setPianorollZoom(PIANOROLL_ZOOM_LEVELS[nextIndex]);
  }
}

function resetPianorollZoom() {
  setPianorollAutoFollow(false);
  setPianorollZoom(PIANOROLL_ZOOM_LEVELS[0], false);
}

function resizePianoroll(entry) {
  const canvas = $("#pianoroll-canvas");
  const rect = canvas.getBoundingClientRect();
  const deviceBox = entry?.devicePixelContentBoxSize?.[0];
  const pixelWidth = deviceBox?.inlineSize || Math.round(rect.width * window.devicePixelRatio);
  const pixelHeight = deviceBox?.blockSize || Math.round(rect.height * window.devicePixelRatio);
  if (pixelWidth <= 0 || pixelHeight <= 0) return;
  canvas.width = pixelWidth;
  canvas.height = pixelHeight;
  state.pianorollSize = {
    width: rect.width, height: rect.height, pixelWidth, pixelHeight,
    scaleX: pixelWidth / rect.width, scaleY: pixelHeight / rect.height,
  };
  redrawPianorollStatic();
}

function seekPianorollAt(clientX) {
  if (!state.session?.hasRender || !state.pianoroll) return;
  const canvas = $("#pianoroll-canvas");
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  seekPlaybackTo(ratio * state.pianoroll.durationSeconds);
}

// 再生位置のシーク（←→・Home/End・PageUp/PageDown）。以前はピアノロールの
// canvasにフォーカスがある時だけ効いていたが、毎回canvasをクリックしてからでないと
// 使えないのは不便なため、documentレベルで拾う。canvasにフォーカスがある場合も
// このイベントへバブリングしてくるので、role="slider"のキーボード操作は変わらず動く。
// isPlaybackShortcutBlocked()と同じ判定で、テキスト入力欄等にフォーカスがある間は
// 素通しし、通常のカーソル移動（キャレット移動）を妨げない。
// Cmd+←は通常の1秒戻しではなく、先頭（0秒）へ即座に戻す。
function handleSeekKeydown(event) {
  if (!state.session?.hasRender || !state.pianoroll || !$("#player").getAttribute("src")) return;
  if (isPlaybackShortcutBlocked(event.target)) return;
  let target = null;
  if (event.metaKey && event.key === "ArrowLeft") {
    target = 0;
  } else {
    const keySteps = {
      ArrowLeft: -PLAYBACK_SEEK_SECONDS,
      ArrowRight: PLAYBACK_SEEK_SECONDS,
      PageDown: -10,
      PageUp: 10,
    };
    if (keySteps[event.key] !== undefined) {
      target = $("#player").currentTime + keySteps[event.key];
    }
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = getPlaybackDuration();
  }
  if (target === null) return;
  event.preventDefault();
  seekPlaybackTo(target);
}

function setupPianoroll() {
  const canvas = $("#pianoroll-canvas");
  const scrollArea = $("#pianoroll-scroll");
  const resizeObserver = new ResizeObserver(([entry]) => resizePianoroll(entry));
  const supportsDevicePixels = typeof ResizeObserverEntry !== "undefined"
    && "devicePixelContentBoxSize" in ResizeObserverEntry.prototype;
  resizeObserver.observe(canvas, supportsDevicePixels ? { box: "device-pixel-content-box" } : {});
  canvas.addEventListener("pointerdown", (event) => {
    if (!state.session?.hasRender || event.pointerType === "touch") return;
    state.isPianorollSeeking = true;
    state.pianorollPointerId = event.pointerId;
    canvas.setPointerCapture(event.pointerId);
    seekPianorollAt(event.clientX);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (state.isPianorollSeeking && event.pointerId === state.pianorollPointerId) {
      seekPianorollAt(event.clientX);
    }
  });
  const finishSeek = (event) => {
    if (event.pointerId !== state.pianorollPointerId) return;
    state.isPianorollSeeking = false;
    state.pianorollPointerId = null;
  };
  canvas.addEventListener("pointerup", finishSeek);
  canvas.addEventListener("pointercancel", finishSeek);
  document.addEventListener("keydown", handleSeekKeydown);
  $("#pianoroll-zoom-out").addEventListener("click", () => changePianorollZoom(-1));
  $("#pianoroll-zoom-in").addEventListener("click", () => changePianorollZoom(1));
  for (const eventName of ["wheel", "pointerdown", "touchstart"]) {
    scrollArea.addEventListener(eventName, () => setPianorollAutoFollow(false), { passive: true });
  }
  scrollArea.addEventListener("scroll", handlePianorollScroll, { passive: true });
  $("#player").addEventListener("loadedmetadata", updatePianorollInteraction);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", redrawPianorollStatic);
  updatePianorollZoomControls();
}

function updateSectionsReadiness() {
  const ready = !!(state.session && state.session.tracks.length > 0);
  $("#tracks-card").classList.toggle("ready", ready);
  $("#audition-card").classList.toggle("ready", ready);
  $("#render-button").disabled = !ready;
  document.querySelectorAll('input[name="render-mode"]')
    .forEach((control) => { control.disabled = !ready; });
  $("#download-button").disabled = !(state.session && state.session.hasDownload);
  $("#download-wav-button").disabled = !(state.session && state.session.hasDownload);
  $("#download-filename").disabled = !(state.session && state.session.hasDownload);
  document.querySelectorAll(".transform-controls button, .transform-controls input")
    .forEach((control) => { control.disabled = !ready; });
  // バリエーション一括生成はensure_render()を経由しないため事前の試聴レンダリングは
  // 不要（hasRenderではなくhasDownload = MIDIアップロード済みかどうかで活性化する）。
  $("#variation-button").disabled = !(state.session && state.session.hasDownload);
  $("#upload-filename").textContent = state.session && state.session.filename
    ? state.session.filename
    : "";
  updatePlaybackControls();
}

function resetPlayer() {
  const player = $("#player");
  setPianorollAutoFollow(false);
  stopPlaybackTimeAnimation();
  player.removeAttribute("src");
  player.load();
  updatePlaybackTime();
  updatePlaybackControls();
  updatePianorollInteraction();
  drawPianoroll();
}

// セッションのspeed/transposeを速度・ピッチ入力欄へ反映する。未指定（handleReset()の
// 手組みpayload等）は既定値1.0/0として扱う。
function renderTransformFields(payload) {
  const speed = payload && typeof payload.speed === "number" ? payload.speed : 1.0;
  const transpose = payload && typeof payload.transpose === "number" ? payload.transpose : 0;
  // 速度は0.1刻みのUIに合わせ、整数でも"1"ではなく"1.0"と常に小数第1位まで表示する。
  $("#transform-speed").value = speed.toFixed(1);
  $("#transform-transpose").value = String(transpose);
}

// セッションのダウンロードファイル名（downloadStem）をテキスト欄へ反映する。
// 明示指定（downloadStem）が無ければ、アップロード時のファイル名（filename）を
// 初期値として表示する。
function renderDownloadFilenameField(payload) {
  const stem = (payload && payload.downloadStem) || (payload && payload.filename) || "";
  $("#download-filename").value = stem;
}

async function refreshFromSession(payload) {
  cancelPrewarm();
  // 新しいMIDI/音源の読み込みでトラック構成自体が変わりうるため、
  // 古いセッションのトラック番号を指したソロ試聴状態は持ち越さない。
  state.soloTrackIndex = null;
  state.soloVolumeSnapshot = null;
  state.session = payload;
  if (["fast", "quality"].includes(payload.renderMode)) {
    state.renderMode = payload.renderMode;
    const modeInput = $(`#render-mode-${state.renderMode}`);
    if (modeInput) modeInput.checked = true;
  }
  resetPianorollZoom();
  await renderTrackList();
  updateSectionsReadiness();
  renderConvertPanel(payload.source || null);
  renderTransformFields(payload);
  renderDownloadFilenameField(payload);
  // hasGameSoundfontの変化を#soundfont-helpへ即座に反映する（新規fetchはしない）。
  if (state.soundfontPayload) {
    renderSoundfontOptions(state.soundfontPayload);
  }
  await loadPianoroll();
}

function onTransformChange() {
  clearTimeout(state.transformPatchTimer);
  state.transformPatchTimer = setTimeout(flushTransform, 250);
}

// 数値入力のstepUp()/stepDown()を使い、HTMLのmin/max/stepを単一の定義元にする。
// stepUp()/stepDown()自体はinputイベントを発火しないため、既存のデバウンスPATCHへ
// 接続する目的で明示的にinputイベントを送る。
function stepTransformInput(inputId, direction) {
  const input = $(inputId);
  if (direction < 0) input.stepDown();
  else input.stepUp();
  // stepUp()/stepDown()は末尾の".0"を落とした値（例:"1"）を入力欄へセットするため、
  // 速度欄だけは常に小数第1位まで表示する規約に合わせて上書きする。
  if (inputId === "#transform-speed") input.value = Number(input.value).toFixed(1);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

// #transform-speed/#transform-transposeの現在値をPATCH /api/session/transformへ送る。
// トラック設定（flushPendingTrackSettings）と違い値は2つだけなので、保留マージは
// せず入力欄の現在値をそのまま毎回送る。
async function flushTransform() {
  const speedInput = $("#transform-speed");
  const transposeInput = $("#transform-transpose");
  const speed = Number(speedInput.value);
  const transpose = Number(transposeInput.value);
  if (Number.isNaN(speed) || Number.isNaN(transpose)) {
    showStatus("速度・ピッチには数値を入力してください", "error");
    return;
  }
  try {
    const response = await apiFetch("/api/session/transform", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ speed, transpose }),
    });
    state.session = await response.json();
    resetPlayer();
    updateSectionsReadiness();
    await loadPianoroll();
    schedulePrewarm();
    showStatus("速度・ピッチを変更しました。もう一度「適用して試聴」を押してください。");
  } catch (error) {
    showStatus(error.message, "error");
  }
}

function onDownloadFilenameChange() {
  clearTimeout(state.downloadFilenamePatchTimer);
  state.downloadFilenamePatchTimer = setTimeout(flushDownloadFilename, 250);
}

// #download-filenameの現在値をPATCH /api/session/filenameへ送る。送信結果を
// state.sessionへ反映するだけでrenderDownloadFilenameField()は呼び直さない
// （flushTransform()と同じ配慮 — 入力中のテキストを自分自身の送信結果で
// 打ち消さないため）。
async function flushDownloadFilename() {
  const input = $("#download-filename");
  try {
    const response = await apiFetch("/api/session/filename", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: input.value }),
    });
    state.session = await response.json();
  } catch (error) {
    showStatus(error.message, "error");
  }
}

// files: FileList | File[]。.mid/.midi単体のみ既存のMIDIアップロードへ、
// それ以外（音源単体、音源+m3u同梱、ZIPなど）はすべて音源アップロードへ回す。
async function handleUpload(files) {
  const list = Array.from(files || []);
  if (list.length === 0) return;
  if (list.length === 1 && isMidiFilename(list[0].name)) {
    await uploadMidi(list[0]);
  } else {
    await uploadSource(list);
  }
}

async function uploadMidi(file) {
  setBusy(true, "読み込み中…");
  const formData = new FormData();
  formData.append("midi", file);
  try {
    const response = await apiFetch("/api/session", { method: "POST", body: formData });
    resetPlayer();
    await refreshFromSession(await response.json());
    $("#upload-card").open = true;
    showStatus("MIDIを読み込みました。", "success");
  } catch (error) {
    showStatus(error.message, "error");
  } finally {
    setBusy(false);
  }
}

async function uploadSource(files) {
  setBusy(true, "音源を解析中…");
  const formData = new FormData();
  for (const file of files) formData.append("source", file);
  try {
    const response = await apiFetch("/api/source", { method: "POST", body: formData });
    resetPlayer();
    await refreshFromSession(await response.json());
    $("#upload-card").open = true;
    showStatus("音源を読み込みました。曲とオプションを選んで変換してください。", "success");
  } catch (error) {
    showStatus(error.message, "error");
  } finally {
    setBusy(false);
  }
}

// --- 音源→MIDI変換パネル ---

function formatSongLabel(song) {
  const parts = [`${song.index}: ${song.label}`];
  if (song.durationSeconds !== null && song.durationSeconds !== undefined) {
    parts.push(`(${song.durationSeconds.toFixed(1)}秒)`);
  }
  if (song.detail) parts.push(`— ${song.detail}`);
  return parts.join(" ");
}

// previousValue: 直前の描画でこのフィールド(field.name)にユーザーが設定していた値。
// 未指定(undefined)なら前回描画にこのフィールド自体が存在しなかった（初回描画や
// フォーマット切り替え）ことを意味し、field.defaultへフォールバックする。
function buildConvertField(field, previousValue) {
  const wrapper = document.createElement("div");
  wrapper.className = `convert-field ${field.type === "bool" ? "is-checkbox" : ""}`.trim();
  if (field.layoutGroup) wrapper.dataset.layoutGroup = field.layoutGroup;

  const label = document.createElement("label");
  label.textContent = field.label;
  label.htmlFor = `convert-field-${field.name}`;

  // unavailableなフィールドはpreviousValueを見ない ―― 別フォーマットの
  // 同名フィールド（例: VGMのloopsに入力した値）をたまたま引き継いでしまうと、
  // disabledな数値欄に紛らわしい値が表示され、placeholderの「指定不可」も
  // 値があるせいで隠れてしまう。常にfield.defaultだけを使う。
  const restoredValue = field.unavailable ? undefined : previousValue;

  let input;
  if (field.type === "bool") {
    input = document.createElement("input");
    input.type = "checkbox";
    input.checked = restoredValue !== undefined ? !!restoredValue : !!field.default;
    wrapper.appendChild(input);
    wrapper.appendChild(label);
  } else {
    input = document.createElement("input");
    input.type = "number";
    input.step = "any";
    if (field.min !== undefined && field.min !== null) input.min = String(field.min);
    if (field.placeholder) input.placeholder = field.placeholder;
    const initialValue = restoredValue !== undefined ? restoredValue : field.default;
    if (initialValue !== undefined && initialValue !== null) {
      input.value = String(initialValue);
    }
    wrapper.appendChild(label);
    wrapper.appendChild(input);
  }
  input.id = `convert-field-${field.name}`;

  if (field.help) {
    const help = document.createElement("p");
    help.className = "field-help";
    help.id = `convert-field-${field.name}-help`;
    help.textContent = field.help;
    wrapper.appendChild(help);
    input.setAttribute("aria-describedby", help.id);
  }

  if (field.unavailable) {
    // このフォーマットでは指定できない項目。state.convertFieldsへは積まない
    // ―― 積むと updateConvertFieldConflicts() が entry.input.disabled を
    // 無条件に false へ戻してしまい、gatherConvertOptions() が送信対象に
    // 加えてしまう。理由は上のfield.helpとして常時表示されるpタグに書かれる。
    input.disabled = true;
    wrapper.classList.add("is-unavailable");
    return wrapper;
  }

  input.addEventListener("input", updateConvertFieldConflicts);
  input.addEventListener("change", updateConvertFieldConflicts);

  state.convertFields.push({
    name: field.name,
    type: field.type,
    label: field.label,
    input,
    wrapper,
    conflicts: field.conflicts || [],
  });

  return wrapper;
}

function readConvertFieldValue(entry) {
  if (entry.type === "bool") return entry.input.checked;
  if (entry.input.value === "") return null;
  return Number(entry.input.value);
}

function updateConvertFieldConflicts() {
  const values = {};
  const labelsByName = {};
  for (const entry of state.convertFields) {
    values[entry.name] = readConvertFieldValue(entry);
    labelsByName[entry.name] = entry.label;
  }
  for (const entry of state.convertFields) {
    const blockingNames = entry.conflicts.filter(
      (other) => values[other] !== null && values[other] !== undefined && values[other] !== false
    );
    const blocked = blockingNames.length > 0;
    entry.input.disabled = blocked;
    entry.wrapper.classList.toggle("is-disabled", blocked);
    entry.wrapper.title = blocked
      ? `${blockingNames.map((name) => labelsByName[name] || name).join("・")}と同時に指定できません`
      : "";
  }
}

function renderConvertPanel(source) {
  const panel = $("#convert-panel");
  const fileGroup = $("#convert-file-group");
  const fileSelect = $("#convert-file-select");
  const songGroup = $("#convert-song-group");
  const songSelect = $("#convert-song-select");
  const playlistNote = $("#convert-playlist-note");
  const optionsContainer = $("#convert-options");

  // 変換や曲一覧の再取得（同じsource.songsでのrefreshFromSession）のたびに
  // ここが呼び直されるため、再描画前の選択を覚えておいて後で復元する。
  // fileSelectはsource.activeFileから毎回復元されるが、songSelectには
  // 対応するサーバー側の状態がない（「最後に変換した曲番号」はセッションに
  // 保持されない）ため、これをしないと変換のたびに曲が黙って先頭（0番）に
  // 戻り、次に「MIDIに変換」を押すと意図しない曲が変換されてしまう。
  const previousSongIndex = songSelect.value;

  // 同じ理由で、秒数・PALタイミング・chipNoise等の各オプションの値も
  // 再構築前に読み取って保持しておく（フィールド名 -> 値）。これが無いと
  // 変換のたびにチェックボックスが field.default（常に false）へ戻ってしまい、
  // 「PALタイミングを使用」「原曲の音源（実機）を初期選択」のチェックが
  // 変換後に外れて見える。
  const previousFieldValues = {};
  for (const entry of state.convertFields) {
    previousFieldValues[entry.name] = readConvertFieldValue(entry);
  }

  state.convertFields = [];
  optionsContainer.innerHTML = "";
  optionsContainer.classList.remove("has-timing-group");
  songSelect.innerHTML = "";
  fileSelect.innerHTML = "";

  if (!source) {
    panel.hidden = true;
    fileGroup.hidden = true;
    return;
  }

  panel.hidden = false;
  optionsContainer.classList.toggle(
    "has-timing-group",
    source.options.some((field) => field.layoutGroup === "timing"),
  );
  $("#convert-panel-title").textContent = `${source.formatLabel} として検出しました（${source.name}）`;

  if (source.files && source.files.length > 1) {
    fileGroup.hidden = false;
    for (const file of source.files) {
      const option = document.createElement("option");
      option.value = file.path;
      option.textContent = file.name;
      fileSelect.appendChild(option);
    }
    fileSelect.value = source.activeFile || "";
  } else {
    fileGroup.hidden = true;
  }

  if (source.songs && source.songs.length > 0) {
    songGroup.hidden = false;
    for (const song of source.songs) {
      const option = document.createElement("option");
      option.value = String(song.index);
      option.textContent = formatSongLabel(song);
      songSelect.appendChild(option);
    }
    // 直前の選択が新しい曲一覧にも存在するなら復元する。存在しない場合
    // （新規アップロード直後や、曲数の異なる別ファイルへの切り替え）は
    // 先頭曲が選ばれたままの既存の挙動を保つ。
    if (source.songs.some((song) => String(song.index) === previousSongIndex)) {
      songSelect.value = previousSongIndex;
    }
    playlistNote.hidden = !source.hasPlaylist;
  } else {
    songGroup.hidden = true;
  }

  for (const field of source.options) {
    if (field.type === "song") continue;
    optionsContainer.appendChild(buildConvertField(field, previousFieldValues[field.name]));
  }
  updateConvertFieldConflicts();
}

async function handleSelectFile() {
  const path = $("#convert-file-select").value;
  if (!path) return;
  setBusy(true, "ファイルを切り替え中…");
  try {
    const response = await apiFetch("/api/source/select-file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    resetPlayer();
    await refreshFromSession(await response.json());
  } catch (error) {
    showStatus(error.message, "error");
  } finally {
    setBusy(false);
  }
}

function gatherConvertOptions() {
  const options = {};
  if (!$("#convert-song-group").hidden) {
    options.songIndex = Number($("#convert-song-select").value);
  }
  for (const entry of state.convertFields) {
    options[entry.name] = readConvertFieldValue(entry);
  }
  return options;
}

async function handleConvert() {
  setBusy(true, "変換中…");
  try {
    const options = gatherConvertOptions();
    const response = await apiFetch("/api/source/convert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options),
    });
    resetPlayer();
    const payload = await response.json();
    await refreshFromSession(payload);
    if (options.gameSoundfont && !payload.hasGameSoundfont) {
      showStatus(
        "MIDIに変換しました。ただしこの曲には音色データが無いため、ゲーム音源は使えません。"
      );
    } else {
      showStatus("MIDIに変換しました。", "success");
    }
    $("#upload-card").open = false;
  } catch (error) {
    showStatus(error.message, "error");
  } finally {
    setBusy(false);
  }
}

// POST /api/renderを呼び、結果を<audio>プレイヤーへセットする。
// 「適用して試聴」ボタンとトラック行のソロ試聴ボタンの両方が使う共通処理。
// 呼び出し元がsetBusy()/エラー表示を担うため、ここでは行わない。
async function renderAndLoadPlayer() {
  cancelPrewarm();
  const response = await apiFetch("/api/render", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ renderMode: selectedRenderMode() }),
  });
  const payload = await response.json();
  const player = $("#player");
  player.src = audioUrl(payload.renderId);
  player.load();
  if (state.session) {
    state.session.hasRender = true;
    state.session.renderId = payload.renderId;
    state.session.renderMode = payload.renderMode;
    state.session.hasDownload = true;
  }
  updateSectionsReadiness();
  updatePianorollInteraction();
  drawPianoroll();
  return player;
}

async function handleRender() {
  clearTimeout(state.patchTimer);
  if (!(await flushPendingTrackSettings())) return;
  const isQuality = selectedRenderMode() === "quality";
  setBusy(true, isQuality ? "試聴音声を準備中…（品質）" : "試聴音声を準備中…（高速）");
  try {
    const player = await renderAndLoadPlayer();
    player.play().catch(() => {});
    const modeLabel = isQuality ? "品質" : "高速";
    showStatus(`${modeLabel}モードの試聴準備ができました。`, "success");
  } catch (error) {
    showStatus(error.message, "error");
  } finally {
    setBusy(false);
  }
}

// スペースキーでの再生・一時停止トグルを素通しすべき要素か判定する。
// フォーム部品・ボタン・リンクはスペースキーに独自の既定動作（クリック・チェック
// 切り替え等）を持つため、そちらを優先してグローバルショートカットは発火させない。
// <audio>自体も除外する（ネイティブの再生ボタンにフォーカスがある間はブラウザ標準の
// トグルに任せ、二重トグルを防ぐ）。
function isPlaybackShortcutBlocked(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A", "AUDIO"].includes(target.tagName);
}

// スペースキー1回分の再生・一時停止トグル。未レンダリング（またはトラック設定変更後で
// 再レンダリングが必要）な状態で再生しようとした場合は、「適用して試聴」ボタンと同じ
// handleRender()を呼んでレンダリングしてから再生する。
async function togglePlayback() {
  if ($("#render-button").disabled || document.body.classList.contains("busy")) return;
  const player = $("#player");
  if (!player.paused) {
    player.pause();
    return;
  }
  if (!state.session.hasRender || !player.getAttribute("src")) {
    await handleRender();
    return;
  }
  player.play().catch(() => {});
}

// 再生ボタンと既存のカーソルキー操作で同じシーク処理を共有する。
// audio.durationはメタデータ読込前にNaNとなるため、常に利用できる
// ピアノロールの曲長をフォールバックとして使う。
function getPlaybackDuration() {
  const playerDuration = $("#player").duration;
  if (Number.isFinite(playerDuration)) return playerDuration;
  return state.pianoroll?.durationSeconds || 0;
}

// 秒以下の桁を「.」と数字それぞれ別spanにして視覚的な間隔を空けるため、
// 一つのtextContentへ丸ごと書き込まず、内訳ごとに差分更新する。「.」自体は
// 常に固定文字なのでHTML側の静的テキストのまま更新しない。
function applyPlaybackClock(container, seconds) {
  const { whole, decimal } = formatPlaybackClock(seconds);
  const wholeEl = container.querySelector(".playback-time-whole");
  const decimalEl = container.querySelector(".playback-time-decimal");
  if (wholeEl.textContent !== whole) wholeEl.textContent = whole;
  if (decimalEl.textContent !== decimal) decimalEl.textContent = decimal;
}

function updatePlaybackTime() {
  const player = $("#player");
  const current = Math.min(getPlaybackDuration(), Math.max(0, player.currentTime || 0));
  applyPlaybackClock($("#playback-current-time"), current);
  applyPlaybackClock($("#playback-duration"), getPlaybackDuration());
}

// <audio>のtimeupdateはブラウザ依存の粗い間隔（数Hz程度）でしか発火せず、
// これだけを頼りにピアノロールの再生位置バーを描画するとカクついて見える。
// カウンタの0.1秒表示と同じ滑らかさにするため、再生中はrAFで毎フレーム
// updatePlaybackProgress()（描画＋カウンタ＋追従スクロール）を呼ぶ。
// timeupdateリスナー自体は一時停止中のシーク等の同期用に残す。
function startPlaybackTimeAnimation() {
  if (state.playbackTimeFrameId !== null) return;
  const updateTime = () => {
    state.playbackTimeFrameId = null;
    updatePlaybackProgress();
    const player = $("#player");
    if (!player.paused && !player.ended) {
      state.playbackTimeFrameId = requestAnimationFrame(updateTime);
    }
  };
  state.playbackTimeFrameId = requestAnimationFrame(updateTime);
}

function stopPlaybackTimeAnimation() {
  if (state.playbackTimeFrameId === null) return;
  cancelAnimationFrame(state.playbackTimeFrameId);
  state.playbackTimeFrameId = null;
  updatePlaybackProgress();
}

function updatePlayerVolume() {
  const player = $("#player");
  const volumePercent = Math.round(player.volume * 100);
  const volumeSlider = $("#player-volume");
  const muteButton = $("#player-mute");
  volumeSlider.value = String(volumePercent);
  volumeSlider.setAttribute("aria-valuetext", `${volumePercent}%`);
  $("#player-volume-value").textContent = `${volumePercent}%`;
  muteButton.setAttribute("aria-pressed", String(player.muted));
  muteButton.setAttribute("aria-label", player.muted ? "ミュートを解除" : "ミュート");
}

function updatePlaybackProgress() {
  drawPianoroll();
  updatePlaybackTime();
  followPianorollPlayback();
}

function seekPlaybackTo(seconds) {
  const player = $("#player");
  if (!state.session?.hasRender || !player.getAttribute("src")) return;
  const target = Math.min(getPlaybackDuration(), Math.max(0, seconds));
  player.currentTime = target;
  if (target <= 0.05) {
    if (!player.paused) setPianorollAutoFollow(true);
    scrollPianorollToStart();
  }
  updatePlaybackProgress();
}

function seekPlaybackBy(seconds) {
  seekPlaybackTo($("#player").currentTime + seconds);
}

function updatePlaybackControls() {
  const player = $("#player");
  const isReady = !!(state.session && state.session.tracks.length > 0);
  const isBusy = document.body.classList.contains("busy");
  const canSeek = isReady && !!state.session.hasRender && !!player.getAttribute("src") && !isBusy;
  $("#playback-backward").disabled = !canSeek;
  $("#playback-forward").disabled = !canSeek;
  $("#playback-start").disabled = !canSeek;
  $("#playback-toggle").disabled = !isReady || isBusy;
  $("#player-mute").disabled = !canSeek;
  $("#player-volume").disabled = !canSeek;
  $("#playback-toggle").setAttribute(
    "aria-pressed",
    String(canSeek && !player.paused && !player.ended),
  );
  updatePlaybackTime();
  updatePlayerVolume();
}

function setupPlaybackControls() {
  const player = $("#player");
  let volumeBeforeMute = player.volume || 1;
  $("#playback-backward").addEventListener(
    "click",
    () => seekPlaybackBy(-PLAYBACK_SEEK_SECONDS),
  );
  $("#playback-forward").addEventListener(
    "click",
    () => seekPlaybackBy(PLAYBACK_SEEK_SECONDS),
  );
  $("#playback-start").addEventListener("click", () => seekPlaybackTo(0));
  $("#playback-toggle").addEventListener("click", togglePlayback);
  $("#player-volume").addEventListener("input", (event) => {
    player.volume = Number(event.target.value) / 100;
    if (player.volume > 0) {
      volumeBeforeMute = player.volume;
      player.muted = false;
    }
  });
  // マウス/タッチでスライダーを操作した直後もフォーカスが残り続け、以降のスペース/矢印
  // キーがスライダー自身の既定動作に奪われグローバルの再生・シークショートカットへ届か
  // なくなるため、ポインター操作の完了時のみblur()する。キーボードでの値変更（Tab移動
  // 後の矢印キー操作）はpointerupを伴わないため、そちらの操作性は損なわない。
  $("#player-volume").addEventListener("pointerup", (event) => {
    event.target.blur();
  });
  $("#player-mute").addEventListener("click", () => {
    if (player.muted) {
      if (player.volume === 0) player.volume = volumeBeforeMute;
      player.muted = false;
    } else {
      if (player.volume > 0) volumeBeforeMute = player.volume;
      player.muted = true;
    }
  });
  player.addEventListener("play", () => {
    if (player.currentTime <= 0.05) {
      setPianorollAutoFollow(true);
      scrollPianorollToStart();
    }
    startPlaybackTimeAnimation();
    updatePlaybackControls();
  });
  player.addEventListener("pause", () => {
    stopPlaybackTimeAnimation();
    updatePlaybackControls();
  });
  player.addEventListener("ended", () => {
    setPianorollAutoFollow(false);
    stopPlaybackTimeAnimation();
    updatePlaybackControls();
  });
  player.addEventListener("emptied", () => {
    setPianorollAutoFollow(false);
    stopPlaybackTimeAnimation();
    updatePlaybackControls();
  });
  for (const eventName of ["loadedmetadata", "durationchange"]) {
    player.addEventListener(eventName, updatePlaybackControls);
  }
  player.addEventListener("timeupdate", updatePlaybackProgress);
  player.addEventListener("volumechange", updatePlayerVolume);
  updatePlaybackControls();
}

// マウスでボタンをクリックすると、クリック後もそのボタンにフォーカスが残り続け、
// 以降のスペースキー入力がブラウザの既定動作（ボタンの再クリック）に奪われて
// グローバルの再生トグルへ届かなくなる。event.detailが0の場合はEnter/Spaceキーに
// よる合成クリックなので対象外とし（Tabキーでのフォーカス移動＋キーボード操作は
// 損なわない）、実際にマウスでクリックされたボタンだけクリック直後にblur()する。
function blurMouseActivatedButton(event) {
  if (event.detail === 0) return;
  const target = event.target.closest("button");
  if (target) target.blur();
}

function setupPlaybackShortcut() {
  document.addEventListener("click", blurMouseActivatedButton);
  document.addEventListener("keydown", (event) => {
    if (event.code !== "Space" || event.repeat) return;
    if (isPlaybackShortcutBlocked(event.target)) return;
    event.preventDefault();
    togglePlayback();
  });
}

async function downloadFrom(path, fallbackName, busyMessage) {
  if (busyMessage) setBusy(true, busyMessage);
  try {
    const response = await apiFetch(path);
    const blob = await response.blob();
    const disposition = response.headers.get("Content-Disposition") || "";
    const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
    const filename = match ? decodeURIComponent(match[1]) : fallbackName;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    showStatus(error.message, "error");
  } finally {
    if (busyMessage) setBusy(false);
  }
}

function handleDownload() {
  return downloadFrom("/api/download", "miditrack_edited.mid");
}

function handleDownloadWav() {
  return downloadFrom(
    "/api/download/wav",
    "miditrack_edited.wav",
    "最終WAVを生成中…",
  );
}

// "1.2, 0.8" のようなカンマ区切りテキストを数値配列にパースする。
// 空白のみの要素は無視し、数値化できない要素があれば null を返す（エラー扱い）。
function parseNumberList(text) {
  const values = text
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map(Number);
  if (values.some((value) => Number.isNaN(value))) return null;
  return values;
}

// 速度・ピッチのバリエーションをまとめて生成する（POST /api/variations）。
// ツールバーの速度・ピッチと同じMIDI書き換え+再レンダリングを組み合わせの
// 数だけ実行するサーバー側処理を待つだけなので、クライアント側で整数チェック等は
// 行わない（サーバーのvalidate_variation_options()のエラーメッセージに委ねる）。
async function handleVariations() {
  const speeds = parseNumberList($("#variation-speeds").value);
  const transposes = parseNumberList($("#variation-transposes").value);
  if (speeds === null || transposes === null) {
    showStatus("速度・ピッチには数値をカンマ区切りで入力してください", "error");
    return;
  }
  const includeMidi = $("#variation-include-midi").checked;
  const comboCount = (speeds.length || 3) * (transposes.length || 5);
  setBusy(true, `バリエーションを生成中…（${comboCount}回レンダリングします）`);
  try {
    const response = await apiFetch("/api/variations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        speeds: speeds.length > 0 ? speeds : undefined,
        transposes: transposes.length > 0 ? transposes : undefined,
        includeMidi,
      }),
    });
    const payload = await response.json();
    const contentsLabel = includeMidi ? "（WAV+MIDI）" : "（WAV）";
    showStatus(`${payload.items.length}件のバリエーション${contentsLabel}を生成しました。ダウンロードします…`);
    const stem = (state.session && (state.session.downloadStem || state.session.filename)) || "miditrack";
    const filename = `${stem}_variations.zip`;
    await downloadFrom("/api/download/variations", filename);
  } catch (error) {
    showStatus(error.message, "error");
  } finally {
    setBusy(false);
  }
}

async function handleReset() {
  setBusy(true);
  try {
    await apiFetch("/api/session", { method: "DELETE" });
    resetPlayer();
    await refreshFromSession({
      filename: null,
      ticksPerBeat: null,
      trackCount: 0,
      tracks: [],
      speed: 1.0,
      transpose: 0,
      hasRender: false,
      renderId: 0,
      hasDownload: false,
      source: null,
    });
    $("#midi-input").value = "";
    $("#upload-card").open = true;
    showStatus("リセットしました。");
  } catch (error) {
    showStatus(error.message, "error");
  } finally {
    setBusy(false);
  }
}

function setupDropZone() {
  const dropZone = $("#drop-zone");
  const input = $("#midi-input");
  input.addEventListener("change", () => handleUpload(input.files));
  dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropZone.classList.add("dragging");
  });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragging"));
  dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropZone.classList.remove("dragging");
    if (event.dataTransfer.files && event.dataTransfer.files.length > 0) {
      handleUpload(event.dataTransfer.files);
    }
  });
}

async function init() {
  if (!token) {
    showStatus("起動トークンがありません。ターミナルに表示されたURLから開いてください。", "error");
    return;
  }
  setupDropZone();
  setupTrackSorting();
  $("#hide-empty-tracks").addEventListener("change", (event) => {
    state.hideEmptyTracks = event.target.checked;
    renderTrackList();
  });
  setupPianoroll();
  setupPlaybackControls();
  setupPlaybackShortcut();
  $("#reset-button").addEventListener("click", handleReset);
  $("#render-button").addEventListener("click", handleRender);
  document.querySelectorAll('input[name="render-mode"]')
    .forEach((control) => control.addEventListener("change", handleRenderModeChange));
  $("#download-button").addEventListener("click", handleDownload);
  $("#download-wav-button").addEventListener("click", handleDownloadWav);
  $("#download-filename").addEventListener("input", onDownloadFilenameChange);
  $("#variation-button").addEventListener("click", handleVariations);
  $("#convert-button").addEventListener("click", handleConvert);
  $("#convert-file-select").addEventListener("change", handleSelectFile);
  $("#soundfont-select").addEventListener("change", handleSoundfontChange);
  $("#transform-speed").addEventListener("input", onTransformChange);
  $("#transform-transpose").addEventListener("input", onTransformChange);
  // 手入力で確定した（blur/Enter）タイミングで、常に小数第1位までの表示に揃える。
  // "input"イベント（タイプ中）で都度書き換えるとカーソル位置がずれるため使わない。
  $("#transform-speed").addEventListener("change", (event) => {
    const value = Number(event.target.value);
    if (!Number.isNaN(value)) event.target.value = value.toFixed(1);
  });
  $("#transform-speed-down").addEventListener("click", () => stepTransformInput("#transform-speed", -1));
  $("#transform-speed-up").addEventListener("click", () => stepTransformInput("#transform-speed", 1));
  $("#transform-transpose-down").addEventListener("click", () => stepTransformInput("#transform-transpose", -1));
  $("#transform-transpose-up").addEventListener("click", () => stepTransformInput("#transform-transpose", 1));

  await loadPreferences();
  await loadSoundfonts();
  try {
    const response = await apiFetch("/api/session");
    await refreshFromSession(await response.json());
  } catch (error) {
    showStatus(error.message, "error");
  }
}

init();
