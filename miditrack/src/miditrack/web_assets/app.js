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
  pendingAssignments: {}, // トラック番号(number) -> GMプログラム番号 | null（未送信分）
  pendingVolumes: {},     // トラック番号(number) -> 音量パーセント（未送信分）
  pendingSources: {},     // トラック番号(number) -> soundfont | game（未送信分）
  patchTimer: null,
  patchPromise: null,     // 送信中の設定PATCH。試聴開始時の競合を防ぐ。
  transformPatchTimer: null, // 全体の速度・ピッチ（PATCH /api/session/transform）用のデバウンス。
  statusTimer: null,
  convertFields: [], // 変換パネルに描画中のオプションフィールド { name, type, input, conflicts }
  soundfontPayload: null, // 直近の /api/soundfonts レスポンス（hasGameSoundfont変化時の再描画用）
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

async function buildTrackRow(track) {
  const row = document.createElement("tr");
  row.className = "track-row";
  if (!track.editable) row.classList.add("is-locked");
  // 曲中で楽器が変わる警告用の別行（後述）。is-hardwareの背景色をrowと
  // 揃えるため、sourceSelectのchangeハンドラからも参照できるようにしておく。
  let warningRow = null;

  const nameCell = document.createElement("td");
  const nameLabel = document.createElement("div");
  nameLabel.className = "track-name";
  nameLabel.textContent = track.name;
  nameCell.appendChild(nameLabel);
  row.appendChild(nameCell);

  const channelCell = document.createElement("td");
  channelCell.className = "track-channel";
  channelCell.textContent = track.channels.length
    ? track.channels.map((c) => c + 1).join(", ")
    : "—";
  row.appendChild(channelCell);

  const noteCell = document.createElement("td");
  noteCell.textContent = String(track.noteCount);
  row.appendChild(noteCell);

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
      warningRow?.classList.toggle("is-hardware", isHardware);
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
      const volumeSlider = row.querySelector("input[type=range]");
      if (volumeSlider) volumeSlider.disabled = isHardware;
      onSourceChange(track.index, sourceSelect.value);
    });
    sourceCell.appendChild(sourceSelect);
  } else {
    sourceCell.textContent = track.source === "game" ? "原曲の音源" : "SoundFont";
  }
  row.classList.toggle("is-hardware", track.source === "game" && isChipHardwareFormat());
  row.appendChild(sourceCell);

  const instrumentCell = document.createElement("td");
  let warningText = null;
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
    pinButton.addEventListener("click", () => {
      if (select.value === KEEP_ORIGINAL) return;
      toggleProgramPinned(Number(select.value));
    });
    state.instrumentRows.push({ select, updatePinButton });

    const selectRow = document.createElement("div");
    selectRow.className = "instrument-select-row";
    selectRow.appendChild(select);
    selectRow.appendChild(pinButton);
    instrumentCell.appendChild(selectRow);

    if (track.programChangeCount > 1) {
      warningText = "曲中で楽器が変わります。適用するとすべて上書きされます";
    }
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
    slider.value = String(track.volumePercent ?? 100);
    slider.disabled = track.source === "game" && isChipHardwareFormat();
    slider.dataset.trackIndex = String(track.index);
    slider.setAttribute("aria-valuetext", `${slider.value}%`);

    const value = document.createElement("output");
    value.className = "track-volume-value";
    value.setAttribute("for", inputId);
    value.value = `${slider.value}%`;
    value.textContent = value.value;

    slider.addEventListener("input", () => {
      value.value = `${slider.value}%`;
      value.textContent = value.value;
      slider.setAttribute("aria-valuetext", value.value);
      onVolumeChange(track.index, Number(slider.value));
    });
    control.appendChild(label);
    control.appendChild(slider);
    control.appendChild(value);
    volumeCell.appendChild(control);
  } else {
    volumeCell.textContent = "—";
  }
  row.appendChild(volumeCell);

  if (!warningText) return row;

  // 警告文をメイン行のtd内に置くと、tdの縦方向中央揃え（vertical-align: middle）が
  // 「セレクト+警告文をまとめたブロック」ごと中央に置いてしまい、セレクト自体の
  // 高さが警告文の無い他の行とズレて見える。警告文だけを次のtr（楽器列の位置に
  // colspanで表示）へ切り出すことで、メイン行の高さは警告文の有無に関わらず揃い、
  // セレクトの垂直位置も全行で一致する。
  row.classList.add("has-warning");
  const fragment = document.createDocumentFragment();
  fragment.appendChild(row);

  warningRow = document.createElement("tr");
  warningRow.className = "track-row-warning";
  warningRow.classList.toggle("is-hardware", row.classList.contains("is-hardware"));
  warningRow.appendChild(document.createElement("td")).colSpan = 4;
  const warningCell = document.createElement("td");
  const warning = document.createElement("p");
  warning.className = "pc-warning";
  warning.textContent = warningText;
  warningCell.appendChild(warning);
  warningRow.appendChild(warningCell);
  warningRow.appendChild(document.createElement("td"));
  fragment.appendChild(warningRow);

  return fragment;
}

function onProgramChange(trackIndex, value) {
  state.pendingAssignments[trackIndex] = value === KEEP_ORIGINAL ? null : Number(value);
  if (value !== KEEP_ORIGINAL) recordProgramUsage(Number(value));
  clearTimeout(state.patchTimer);
  state.patchTimer = setTimeout(flushPendingTrackSettings, 200);
}

function onVolumeChange(trackIndex, volumePercent) {
  state.pendingVolumes[trackIndex] = volumePercent;
  clearTimeout(state.patchTimer);
  state.patchTimer = setTimeout(flushPendingTrackSettings, 200);
}

function onSourceChange(trackIndex, source) {
  state.pendingSources[trackIndex] = source;
  clearTimeout(state.patchTimer);
  state.patchTimer = setTimeout(flushPendingTrackSettings, 200);
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
      resetPlayer();
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

async function renderTrackList() {
  const tbody = $("#track-list");
  tbody.innerHTML = "";
  state.instrumentRows = [];
  const tracks = state.session ? state.session.tracks : [];
  $("#tracks-empty").hidden = tracks.length > 0;
  for (const track of tracks) {
    tbody.appendChild(await buildTrackRow(track));
  }
}

function updateSectionsReadiness() {
  const ready = !!(state.session && state.session.tracks.length > 0);
  $("#tracks-card").classList.toggle("ready", ready);
  $("#audition-card").classList.toggle("ready", ready);
  $("#render-button").disabled = !ready;
  $("#download-button").disabled = !(state.session && state.session.hasDownload);
  $("#download-wav-button").disabled = !(state.session && state.session.hasDownload);
  // バリエーション一括生成はensure_render()を経由しないため事前の試聴レンダリングは
  // 不要（hasRenderではなくhasDownload = MIDIアップロード済みかどうかで活性化する）。
  $("#variation-button").disabled = !(state.session && state.session.hasDownload);
  $("#upload-filename").textContent = state.session && state.session.filename
    ? state.session.filename
    : "";
}

function resetPlayer() {
  const player = $("#player");
  player.removeAttribute("src");
  player.load();
}

// セッションのspeed/transposeを速度・ピッチ入力欄へ反映する。未指定（handleReset()の
// 手組みpayload等）は既定値1.0/0として扱う。
function renderTransformFields(payload) {
  const speed = payload && typeof payload.speed === "number" ? payload.speed : 1.0;
  const transpose = payload && typeof payload.transpose === "number" ? payload.transpose : 0;
  $("#transform-speed").value = String(speed);
  $("#transform-transpose").value = String(transpose);
}

async function refreshFromSession(payload) {
  state.session = payload;
  await renderTrackList();
  updateSectionsReadiness();
  renderConvertPanel(payload.source || null);
  renderTransformFields(payload);
  // hasGameSoundfontの変化を#soundfont-helpへ即座に反映する（新規fetchはしない）。
  if (state.soundfontPayload) {
    renderSoundfontOptions(state.soundfontPayload);
  }
}

function onTransformChange() {
  clearTimeout(state.transformPatchTimer);
  state.transformPatchTimer = setTimeout(flushTransform, 250);
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
    showStatus("速度・ピッチを変更しました。もう一度「適用して試聴」を押してください。");
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

  let input;
  if (field.type === "bool") {
    input = document.createElement("input");
    input.type = "checkbox";
    input.checked = previousValue !== undefined ? !!previousValue : !!field.default;
    wrapper.appendChild(input);
    wrapper.appendChild(label);
  } else {
    input = document.createElement("input");
    input.type = "number";
    input.step = "any";
    if (field.min !== undefined && field.min !== null) input.min = String(field.min);
    const initialValue = previousValue !== undefined ? previousValue : field.default;
    if (initialValue !== undefined && initialValue !== null) {
      input.value = String(initialValue);
    }
    wrapper.appendChild(label);
    wrapper.appendChild(input);
  }
  input.id = `convert-field-${field.name}`;
  input.addEventListener("input", updateConvertFieldConflicts);
  input.addEventListener("change", updateConvertFieldConflicts);

  if (field.help) {
    const help = document.createElement("p");
    help.className = "field-help";
    help.textContent = field.help;
    wrapper.appendChild(help);
  }

  state.convertFields.push({
    name: field.name,
    type: field.type,
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
  for (const entry of state.convertFields) {
    values[entry.name] = readConvertFieldValue(entry);
  }
  for (const entry of state.convertFields) {
    const blocked = entry.conflicts.some(
      (other) => values[other] !== null && values[other] !== undefined && values[other] !== false
    );
    entry.input.disabled = blocked;
    entry.wrapper.classList.toggle("is-disabled", blocked);
    entry.wrapper.title = blocked
      ? `${entry.conflicts.join("・")}と同時に指定できません`
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
  // 「PALタイミングを使用」「実機音（原曲の音源）を使う」のチェックが
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
  } catch (error) {
    showStatus(error.message, "error");
  } finally {
    setBusy(false);
  }
}

async function handleRender() {
  clearTimeout(state.patchTimer);
  if (!(await flushPendingTrackSettings())) return;
  setBusy(true, "レンダリング中…");
  try {
    const response = await apiFetch("/api/render", { method: "POST" });
    const payload = await response.json();
    const player = $("#player");
    player.src = audioUrl(payload.renderId);
    player.load();
    if (state.session) {
      state.session.hasRender = true;
      state.session.renderId = payload.renderId;
      state.session.hasDownload = true;
    }
    updateSectionsReadiness();
    showStatus("試聴の準備ができました。", "success");
  } catch (error) {
    showStatus(error.message, "error");
  } finally {
    setBusy(false);
  }
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
  return downloadFrom("/api/download/wav", "miditrack_edited.wav", "WAVを書き出し中…");
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
// 上の「全体の速度・ピッチ」と同じMIDI書き換え+再レンダリングを組み合わせの
// 数だけ実行するサーバー側処理を待つだけなので、クライアント側で整数チェック等は
// 行わない（サーバーのvalidate_variation_options()のエラーメッセージに委ねる）。
async function handleVariations() {
  const speeds = parseNumberList($("#variation-speeds").value);
  const transposes = parseNumberList($("#variation-transposes").value);
  if (speeds === null || transposes === null) {
    showStatus("速度・ピッチには数値をカンマ区切りで入力してください", "error");
    return;
  }
  const comboCount = (speeds.length || 2) * (transposes.length || 5);
  setBusy(true, `バリエーションを生成中…（${comboCount}回レンダリングします）`);
  try {
    const response = await apiFetch("/api/variations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        speeds: speeds.length > 0 ? speeds : undefined,
        transposes: transposes.length > 0 ? transposes : undefined,
      }),
    });
    const payload = await response.json();
    showStatus(`${payload.items.length}件のバリエーション（WAV+MIDI）を生成しました。ダウンロードします…`);
    const filename = `${(state.session && state.session.filename) || "miditrack"}_variations.zip`;
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
  $("#reset-button").addEventListener("click", handleReset);
  $("#render-button").addEventListener("click", handleRender);
  $("#download-button").addEventListener("click", handleDownload);
  $("#download-wav-button").addEventListener("click", handleDownloadWav);
  $("#variation-button").addEventListener("click", handleVariations);
  $("#convert-button").addEventListener("click", handleConvert);
  $("#convert-file-select").addEventListener("change", handleSelectFile);
  $("#soundfont-select").addEventListener("change", handleSoundfontChange);
  $("#transform-speed").addEventListener("input", onTransformChange);
  $("#transform-transpose").addEventListener("input", onTransformChange);

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
