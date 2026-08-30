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
// crossfadeToRender()が再生中の乗り換えに使う等パワークロスフェードの長さ（ms）。
const CROSSFADE_MS = 120;
const POINTER_FOCUS_CONTROL_SELECTOR = [
  "select",
  'input[type="radio"]',
  'input[type="checkbox"]',
  'input[type="range"]',
  'input[type="file"]',
].join(",");
const POINTER_CHANGE_CONTROL_SELECTOR = [
  "select",
  'input[type="radio"]',
  'input[type="checkbox"]',
  'input[type="file"]',
].join(",");

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
  transformPatchPromise: null,
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
  pointerActivatedControl: null,
  renderMode: "fast",
  autoRenderTimer: null,
  renderGeneration: 0,
  renderTask: null,
  renderTaskGeneration: null,
  // A/Bクロスフェード再生（crossfadeToRender()）関連の状態。
  // "a"|"b"のどちらの<audio>要素が現在の再生源かを指す。もう一方は次のレンダリング
  // 結果を裏でロード・シークしておく待避先として使う。
  activePlayerId: "a",
  // ユーザーが#player-volume/#player-muteで指定した意図。<audio>要素自身の.volumeは
  // クロスフェード中フレームごとに書き換わるため、UIとその真実の値はここに置き、
  // 要素側は常にこのstateからの派生値として扱う（applyPlayerGains()参照）。
  userVolume: 1,
  isUserMuted: false,
  // crossfadeToRender()の多重実行防止と、進行中フェードの追い越し検出用の世代番号。
  isSwapping: false,
  swapGeneration: 0,
  // トラック設定・SoundFont・速度/ピッチ等を変更した後、まだ試聴音声へ反映されて
  // いないことを示す。再生操作はこの状態のまま旧音源を鳴らさず、最新レンダーの
  // 完了を待つ。
  isRenderStale: false,
  // 速度/ピッチ変更で/api/pianorollの再取得（durationSeconds更新を含む）が必要だが、
  // 再生中は音がまだ旧設定のまま鳴っているため今すぐは反映できない、という状態。
  // schedulePianorollReload()が立て、実際に試聴音声が入れ替わった直後（またはその前に
  // 一時停止された場合はその時点）でapplyPendingPianorollReload()が下ろす。
  pendingPianorollReload: false,
  // schedulePianorollReload()が裏で開始しておく/api/pianorollのfetch Promise。
  // クロスフェード完了を待つ間に取得も終わらせておくことで、乗り換え直後の
  // 反映が追加のネットワーク待ちを挟まず、ほぼ同期的に行える（詳細は
  // schedulePianorollReload()/applyPendingPianorollReload()のコメントを参照）。
  pendingPianorollFetch: null,
  // trueなら、反映時にノート（static layer）も再描画する。速度のみの変更では
  // 開始時刻・長さ・曲長がすべて同じ比率でスケールするため、キャンバス上の
  // ノートの相対位置（x座標比率）は変わらず、再描画が不要（schedulePianorollReload()
  // 参照）。複数の変更が重なった場合に備え、trueは反映するまでOR蓄積する。
  pendingPianorollNeedsRedraw: false,
};

// --- A/Bクロスフェード再生（player-a / player-b） ---
// 試聴用<audio>は2枚あり、state.activePlayerIdが指す一方だけが「現在の再生源」。
// 既存コードの大部分は$("#player")の代わりにactivePlayer()を呼ぶだけでよく、
// 挙動は今まで通り「今鳴っている（かもしれない）1枚」を指す。裏の1枚は
// crossfadeToRender()が次のレンダリング結果のロード・シーク・フェードにだけ使う。

function activePlayer() {
  return $(state.activePlayerId === "a" ? "#player-a" : "#player-b");
}

function inactivePlayer() {
  return $(state.activePlayerId === "a" ? "#player-b" : "#player-a");
}

function allPlayers() {
  return [$("#player-a"), $("#player-b")];
}

function swapActivePlayer() {
  state.activePlayerId = state.activePlayerId === "a" ? "b" : "a";
}

// crossfadeToRender()の呼び出しを直列化する。連続編集からの自動乗り換えと
// 再生操作による最新レンダーのロードがほぼ同時に発生しても、2つの呼び出しが同じ
// 待避用<audio>要素（inactivePlayer()）へ同時に書き込んで壊れないようにするため。
// resetPlayer()（ハードリセット）は直接この変数をリセットして進行中のキューを捨てる。
let swapQueue = Promise.resolve();

// #player-volume/#player-muteが表す「ユーザーの意図した音量」を、現在の
// activePlayer()へ反映する。クロスフェード中はrunCrossfade()がフレームごとに
// 両要素のvolumeを直接管理するため、ここでは触らない。
function applyPlayerGains() {
  if (state.isSwapping) return;
  const gain = state.isUserMuted ? 0 : state.userVolume;
  activePlayer().volume = gain;
}

// トラック設定・SoundFont・速度/ピッチ等の変更で試聴音声が実際の設定より古くなった
// ことを示すだけの軽量な印。resetPlayer()と違い<audio>のsrcにも再生にも触れない
// ため、鳴っている音は変更後もそのまま鳴り続ける。scheduleAutoRender()が拾って
// 裏でレンダリングし、crossfadeToRender()で滑らかに乗り換えた時点でfalseに戻る。
function markRenderStale() {
  state.isRenderStale = true;
}

function clearRenderStale() {
  state.isRenderStale = false;
}

function isActivePlayerPlaying() {
  const player = activePlayer();
  return !player.paused && !player.ended && !!player.getAttribute("src");
}

// 速度変更はピアノロールのdurationSeconds（時間軸そのもの）を変える。再生中は
// 鳴っている音がまだ旧設定のままなので、durationSecondsだけ先に新しい値へ切り替えると
// 「seconds（旧設定のまま進む音の経過秒数）÷ 新しいdurationSeconds」で計算される
// 再生位置バーのx座標が、音の実際の進み具合と無関係にずれて見える。そのため
// 再生中はapplyPendingPianorollReload()を呼べる（＝試聴音声が新設定へ実際に
// 切り替わった）瞬間まで反映を遅らせるが、フェッチ自体はここで裏で始めておく。
// crossfadeToRender()の完了を待っている間に大抵は取得も終わるため、実際に適用する
// 時点でネットワーク待ちがほぼ発生せず、「音は切り替わったのにピアノロールの時間軸は
// まだ旧設定」という窓もほぼゼロになる。
// needsNoteRedraw: このリロードが実際にノート（static layer）の再描画を要するか。
// 速度のみの変更（transposeが同じ）ではdurationSecondsと全ノートのstart/duration
// （秒）が同じ比率でスケールするだけなので、キャンバス上のx座標比率
// （drawPianorollTrack()のstart/payload.durationSeconds）は数学的に不変であり、
// 再描画してもピクセル単位で同じ絵になる。呼び出し元（flushTransform()）が
// 実際にtransposeが変わったかどうかで判定する。
function schedulePianorollReload({ needsNoteRedraw = true } = {}) {
  const loadId = ++state.pianorollLoadId;
  state.pendingPianorollReload = true;
  // 複数の変更が反映待ちのまま重なった場合、どれか一つでも再描画を要していれば
  // trueのままにする（後発の呼び出しがneedsNoteRedraw:falseでも取りこぼさない）。
  state.pendingPianorollNeedsRedraw = state.pendingPianorollNeedsRedraw || needsNoteRedraw;
  state.pendingPianorollFetch = apiFetch("/api/pianoroll")
    .then((response) => response.json())
    .then((payload) => ({ loadId, payload }))
    .catch((error) => ({ loadId, error }));
}

// pendingPianorollReloadが立っていれば、schedulePianorollReload()が裏で進めておいた
// フェッチの結果を反映する。呼び出し元は「今この瞬間に反映してよい」（試聴音声が
// 実際に新設定へ切り替わった、または元々再生していなかった）と判断した後でこれを
// 呼ぶ（flushTransform()の停止時分岐、scheduleAutoRender()のクロスフェード完了後・
// ensureLatestRender()のレンダー完了後）。
async function applyPendingPianorollReload() {
  if (!state.pendingPianorollReload) return;
  state.pendingPianorollReload = false;
  const needsNoteRedraw = state.pendingPianorollNeedsRedraw;
  state.pendingPianorollNeedsRedraw = false;
  const fetchPromise = state.pendingPianorollFetch;
  state.pendingPianorollFetch = null;
  if (!fetchPromise) return;
  const result = await fetchPromise;
  // 反映するより先に、さらに新しい編集やセッション読み込みで追い越されていたら捨てる。
  if (result.loadId !== state.pianorollLoadId) return;
  if (result.error) {
    clearPianoroll("ピアノロールを読み込めませんでした。");
    $("#pianoroll-status").textContent = result.error.message;
    return;
  }
  if (needsNoteRedraw) {
    applyPianorollPayload(result.payload);
  } else {
    // durationSeconds（と再生位置バーの計算に使う値）だけを更新し、既存の
    // static layer（ノート・グリッド）は使い回す — 上のneedsNoteRedrawの説明を参照。
    state.pianoroll = result.payload;
    updatePlaybackTime();
    updatePianorollInteraction();
    updatePianorollZoomControls();
    drawPianoroll();
  }
}

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

function setRenderSpinner(isVisible) {
  $("#render-spinner").hidden = !isVisible;
}

function clearAutoRenderTimer() {
  clearTimeout(state.autoRenderTimer);
  state.autoRenderTimer = null;
}

function cancelAutoRender() {
  clearAutoRenderTimer();
  state.renderGeneration += 1;
  setRenderSpinner(false);
}

function isCurrentRenderGeneration(generation) {
  return generation === state.renderGeneration;
}

function applyRenderPayload(payload) {
  if (!state.session) return;
  state.session.hasRender = true;
  state.session.renderId = payload.renderId;
  state.session.renderMode = payload.renderMode;
  state.session.hasDownload = true;
  updateSectionsReadiness();
}

// 指定世代の試聴音声を生成し、停止中は無音で、再生中はクロスフェードで差し替える。
// 後発の編集に追い越された応答は、プレイヤーへ反映しない。
async function renderGeneration(generation) {
  const renderMode = selectedRenderMode();
  if (!state.session || state.session.tracks.length === 0) return null;
  if (isCurrentRenderGeneration(generation)) setRenderSpinner(true);
  try {
    const response = await apiFetch("/api/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ renderMode }),
    });
    const payload = await response.json();
    if (!isCurrentRenderGeneration(generation)) return null;
    applyRenderPayload(payload);
    const player = await crossfadeToRender(
      payload.renderId,
      () => isCurrentRenderGeneration(generation),
    );
    if (!isCurrentRenderGeneration(generation)) return null;
    await applyPendingPianorollReload();
    if (!isCurrentRenderGeneration(generation)) return null;
    clearRenderStale();
    updatePianorollInteraction();
    drawPianoroll();
    return player;
  } catch (error) {
    if (isCurrentRenderGeneration(generation)) showStatus(error.message, "error");
    throw error;
  } finally {
    if (isCurrentRenderGeneration(generation)) setRenderSpinner(false);
  }
}

// 同じ編集世代なら、自動処理・再生操作・ソロ試聴で1つのレンダーを共有する。
function requestRenderGeneration(generation) {
  if (
    state.renderTask
    && state.renderTaskGeneration === generation
  ) {
    return state.renderTask;
  }
  const task = renderGeneration(generation);
  state.renderTask = task;
  state.renderTaskGeneration = generation;
  task.finally(() => {
    if (state.renderTask === task) {
      state.renderTask = null;
      state.renderTaskGeneration = null;
    }
  }).catch(() => {});
  return task;
}

// トラック設定・SoundFont・速度/ピッチ・試聴モード等の変更から500ms操作が無かったら、
// 最新状態を自動レンダーする。停止中でもWAVをプレイヤーへロードするが、自動再生はしない。
function scheduleAutoRender(delay = PREWARM_DELAY_MS) {
  cancelAutoRender();
  if (!state.session || state.session.tracks.length === 0) return;
  const generation = state.renderGeneration;
  state.autoRenderTimer = setTimeout(() => {
    state.autoRenderTimer = null;
    requestRenderGeneration(generation).catch(() => {});
  }, delay);
}

function handleRenderModeChange(event) {
  if (!event.target.checked) return;
  state.renderMode = event.target.value;
  markRenderStale();
  updateSectionsReadiness();
  scheduleAutoRender();
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
    markRenderStale();
    updateSectionsReadiness();
    scheduleAutoRender();
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
  for (const row of state.trackRows) {
    if (!row.sourceSelect || row.index === originIndex) continue;
    if (row.sourceSelect.value === value) continue;
    if (!Array.from(row.sourceSelect.options).some((option) => option.value === value)) continue;
    row.sourceSelect.value = value;
    row.sourceSelect.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

// Cmd/Ctrlを押しながらの楽器選択で、編集可能な他の全トラックの楽器も同じ
// GMプログラムに揃える。
function applyProgramToAllTracks(value, originIndex) {
  for (const row of state.trackRows) {
    if (!row.programSelect || row.programSelect.disabled || row.index === originIndex) continue;
    if (row.programSelect.value === value) continue;
    row.programSelect.value = value;
    row.programSelect.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

// Cmd/Ctrlを押しながらのミュート切り替えで、他の全トラックも同じミュート
// 状態（ミュート／解除）に揃える。解除時は各トラックが個別に覚えている
// 直前の音量へそれぞれ戻る（一律の音量に揃えるわけではない）。
function applyMuteToAllTracks(shouldMute, originIndex) {
  for (const row of state.trackRows) {
    if (!row.muteButton || !row.volumeSlider || row.index === originIndex) continue;
    const isMuted = Number(row.volumeSlider.value) === 0;
    if (isMuted === shouldMute) continue;
    row.muteButton.click();
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
    // 「ソロ試聴」ボタン。他のトラックをミュートして最新音源を準備・再生する
    // 操作をワンクリックにまとめたもので、サーバー側の状態やAPIは
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

  setBusy(true);
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
    cancelAutoRender();
    markRenderStale();
    const player = await ensureLatestRender();
    if (player) await playPreparedPlayer(player);
  } catch (error) {
    state.soloTrackIndex = null;
    showStatus(error.message, "error");
  } finally {
    // 他トラックの音量が0になった（または解除で戻った）ため、
    // ピアノロールの減光表示も現在のstate.sessionに合わせて描き直す。
    redrawPianorollStatic();
    setBusy(false);
  }
}

async function exitSolo() {
  const snapshot = state.soloVolumeSnapshot;
  state.soloTrackIndex = null;
  state.soloVolumeSnapshot = null;
  if (!snapshot) return;

  setBusy(true);
  try {
    const response = await apiFetch("/api/session/tracks", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ volumes: snapshot }),
    });
    state.session = await response.json();
    await renderTrackList();
    updateSectionsReadiness();
    markRenderStale();
    scheduleAutoRender();
  } catch (error) {
    showStatus(error.message, "error");
  } finally {
    // enterSolo()と同じ理由でピアノロールを再描画する。
    redrawPianorollStatic();
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
      markRenderStale();
      scheduleAutoRender();
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

// 取得済みのペイロードをstate.pianorollへ反映して再描画する。loadPianoroll()と
// schedulePianorollReload()（フェッチと適用のタイミングを分離する版）の両方から
// 呼ぶ共通の「適用」部分。
function applyPianorollPayload(payload) {
  state.pianoroll = payload;
  updatePlaybackTime();
  const status = payload.truncated
    ? "ノート数が表示上限を超えたため、先頭部分のみ表示しています。"
    : "";
  setPianorollMessage(payload.noteCount > 0 ? "" : "表示できるノートがありません。", status);
  redrawPianorollStatic();
  updatePianorollInteraction();
  updatePianorollZoomControls();
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
    applyPianorollPayload(payload);
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
  const seconds = Math.min(payload.durationSeconds, getDisplayPlaybackSeconds());
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
  updatePianorollAria(getDisplayPlaybackSeconds());
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
  const progress = Math.min(1, activePlayer().currentTime / state.pianoroll.durationSeconds);
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
  if (!state.session?.hasRender || !state.pianoroll || !activePlayer().getAttribute("src")) return;
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
      target = activePlayer().currentTime + keySteps[event.key];
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
  // A/Bどちらの要素がloadedmetadataを発火してもupdatePianorollInteraction()自体は
  // activePlayer()（今のactivePlayerId）から読み直すだけなので、両方に張って構わない。
  for (const player of allPlayers()) {
    player.addEventListener("loadedmetadata", updatePianorollInteraction);
  }
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", redrawPianorollStatic);
  updatePianorollZoomControls();
}

function updateSectionsReadiness() {
  const ready = !!(state.session && state.session.tracks.length > 0);
  $("#tracks-card").classList.toggle("ready", ready);
  $("#audition-card").classList.toggle("ready", ready);
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

// 両方の<audio>を完全に停止・空にし、進行中のクロスフェードがあれば打ち切る。
// MIDI/音源の差し替え・変換・全体リセットなど、試聴音声そのものが無効になる場面
// でだけ呼ぶ。トラック設定・SoundFont・速度/ピッチ等の編集はmarkRenderStale()を
// 使い、鳴っている音を止めない（crossfadeToRender()が新しいレンダリング結果を
// 用意でき次第、滑らかに乗り換える）。
function resetPlayer() {
  state.swapGeneration += 1;
  state.isSwapping = false;
  swapQueue = Promise.resolve();
  for (const player of allPlayers()) {
    player.pause();
    player.removeAttribute("src");
    player.load();
  }
  state.activePlayerId = "a";
  clearRenderStale();
  setPianorollAutoFollow(false);
  stopPlaybackTimeAnimation();
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
  cancelAutoRender();
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
  if (!payload.tracks || payload.tracks.length === 0) return;
  if (payload.hasRender && payload.renderId) {
    clearRenderStale();
    await crossfadeToRender(payload.renderId, () => state.session === payload);
    return;
  }
  markRenderStale();
  scheduleAutoRender(0);
}

function onTransformChange() {
  clearTimeout(state.transformPatchTimer);
  state.transformPatchTimer = setTimeout(() => {
    state.transformPatchTimer = null;
    flushTransform();
  }, 250);
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
  if (state.transformPatchPromise) return state.transformPatchPromise;
  const speedInput = $("#transform-speed");
  const transposeInput = $("#transform-transpose");
  const speed = Number(speedInput.value);
  const transpose = Number(transposeInput.value);
  if (Number.isNaN(speed) || Number.isNaN(transpose)) {
    showStatus("速度・ピッチには数値を入力してください", "error");
    return false;
  }
  // トランスポーズが実際に変わるかどうかで、ピアノロールのノート再描画が要るかを
  // 判定する（schedulePianorollReload()のneedsNoteRedrawコメント参照）。PATCH送信前の
  // state.session（＝現在表示中の値）と比較する。
  const transposeChanged = !state.session || state.session.transpose !== transpose;
  const patchPromise = (async () => {
    try {
      const response = await apiFetch("/api/session/transform", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ speed, transpose }),
      });
      state.session = await response.json();
      markRenderStale();
      updateSectionsReadiness();
      // durationSecondsの更新自体は速度変更でも必要（再生位置バー・シークの分母）だが、
      // 再生中に今すぐ反映すると、まだ旧速度のまま鳴っている音の経過秒数を新しい
      // durationSecondsで割ることになり、クロスフェードで音が実際に切り替わるまでの間、
      // 表示と音の前提がずれるため反映を遅らせる。
      schedulePianorollReload({ needsNoteRedraw: transposeChanged });
      if (!isActivePlayerPlaying()) await applyPendingPianorollReload();
      scheduleAutoRender();
      return true;
    } catch (error) {
      showStatus(error.message, "error");
      return false;
    }
  })();
  state.transformPatchPromise = patchPromise;
  const didSucceed = await patchPromise;
  if (state.transformPatchPromise === patchPromise) state.transformPatchPromise = null;
  return didSucceed;
}

async function flushPendingTransform() {
  if (state.transformPatchTimer !== null) {
    clearTimeout(state.transformPatchTimer);
    state.transformPatchTimer = null;
    if (!(await flushTransform())) return false;
  }
  if (state.transformPatchPromise && !(await state.transformPatchPromise)) return false;
  // 進行中のPATCHを待つ間に次の入力が来た場合は、その入力も送信してから再生する。
  if (state.transformPatchTimer !== null) return flushPendingTransform();
  return true;
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
    // 選べる曲が1件だけなら選択UIは不要。ただし曲番号は0とは限らないため、
    // gatherConvertOptions()では非表示中でもこの<option>の値を送る。
    songGroup.hidden = source.songs.length <= 1;
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
  if ($("#convert-song-select").options.length > 0) {
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

// loadedmetadata/errorのどちらかが発火するまで待つ小さなヘルパー。
// crossfadeToRender()が待避用<audio>のメタデータ読込を待つのに使う。
function waitForLoadOutcome(element) {
  if (element.readyState >= 1) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      element.removeEventListener("loadedmetadata", finish);
      element.removeEventListener("error", finish);
      resolve();
    };
    element.addEventListener("loadedmetadata", finish, { once: true });
    element.addEventListener("error", finish, { once: true });
  });
}

// from（フェードアウトする側）とto（フェードインする側）の音量を、等パワー
// カーブ（cos/sin）でCROSSFADE_MSかけて入れ替える。state.userVolume/isUserMutedを
// 上限として使うため、フェード中にユーザーが音量を変えても違和感のない範囲に収まる。
// generationが変わったら（新しいcrossfadeToRender()呼び出しに追い越されたら）即座に
// 打ち切る。
function runCrossfade(from, to, generation, canCommit) {
  return new Promise((resolve) => {
    const gain = state.isUserMuted ? 0 : state.userVolume;
    const startedAt = performance.now();
    const step = () => {
      if (generation !== state.swapGeneration || !canCommit()) {
        resolve();
        return;
      }
      const t = Math.min(1, (performance.now() - startedAt) / CROSSFADE_MS);
      const angle = (t * Math.PI) / 2;
      from.volume = gain * Math.cos(angle);
      to.volume = gain * Math.sin(angle);
      if (t >= 1) {
        resolve();
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

// crossfadeToRender()の実処理。swapQueueで直列化されるので、呼び出し時点の
// activePlayer()/inactivePlayer()は常に一貫している。
async function runSwap(renderId, canCommit = () => true) {
  const generation = ++state.swapGeneration;
  state.isSwapping = true;
  try {
    if (!canCommit()) return activePlayer();
    const active = activePlayer();
    const next = inactivePlayer();
    const nextUrl = audioUrl(renderId);

    // 既に鳴っている（または直前に読み込んだ）音源と同一なら何もしない。
    if (active.getAttribute("src") === nextUrl) return active;

    const wasPlaying = !active.paused && !active.ended && !!active.getAttribute("src");
    // 速度変更等で曲長が変わっても音楽上の同じ位置を継続するため、絶対秒ではなく
    // 曲全体に対する進捗率で換算する。activeはこの後もawaitのたびに再生され続けるので、
    // ratioは使う直前に毎回activeの最新currentTimeから求め直す（呼び出し箇所を参照）。
    const fromDuration = getPlaybackDuration();
    const currentRatio = () => {
      if (!Number.isFinite(fromDuration) || fromDuration <= 0) return 0;
      return Math.min(1, Math.max(0, (active.currentTime || 0) / fromDuration));
    };

    next.src = nextUrl;
    next.load();
    await waitForLoadOutcome(next);
    if (generation !== state.swapGeneration || !canCommit()) {
      next.pause();
      next.removeAttribute("src");
      next.load();
      return activePlayer();
    }

    const nextDuration = Number.isFinite(next.duration) ? next.duration : fromDuration;
    const seekNextTo = (ratio) => {
      if (!Number.isFinite(nextDuration)) return;
      next.currentTime = Math.min(nextDuration, Math.max(0, ratio * nextDuration));
    };
    // 一度目のシーク: play()をactiveに近い位置から開始させ、無関係な区間をバッファ
    // させないため。waitForLoadOutcome()のネットワーク待ちの間もactiveは進み続けて
    // いるので、この時点のratioはあくまで暫定値。
    seekNextTo(currentRatio());

    let didStartPlaying = false;
    if (wasPlaying) {
      next.volume = 0;
      try {
        await next.play();
        // play()の起動待ち（バッファリング）でもactiveはさらに進んでいる。フェードで
        // 音量を上げ始める前、nextがまだ無音のこのタイミングでもう一度シークし直す
        // ことで、ここまでの待ち時間による遅れをフェード開始前に解消する。これを
        // 省くと、フェード完了・入れ替えの瞬間にnextがactiveより数十ms遅れたまま
        // 表示に反映され、ピアノロールの再生位置バーが一瞬戻ってから正しい位置へ
        // 戻るように見える（ユーザー報告のバグ）。
        seekNextTo(currentRatio());
        didStartPlaying = true;
      } catch (_error) {
        // 自動再生がブロックされた場合はフェード無しの即差し替えへフォールバックする。
      }
    }
    if (generation !== state.swapGeneration || !canCommit()) {
      next.pause();
      next.removeAttribute("src");
      next.load();
      return activePlayer();
    }

    if (didStartPlaying) {
      await runCrossfade(active, next, generation, canCommit);
    } else {
      next.volume = state.isUserMuted ? 0 : state.userVolume;
    }
    if (generation !== state.swapGeneration || !canCommit()) {
      next.pause();
      next.removeAttribute("src");
      next.load();
      active.volume = state.isUserMuted ? 0 : state.userVolume;
      return activePlayer();
    }

    active.pause();
    active.removeAttribute("src");
    active.load();
    swapActivePlayer();
    updatePlaybackControls();
    // rAFループの次フレームを待たず、乗り換えた直後の位置を即座に反映する。
    // 1フレーム（最大16ms程度）とはいえ待つ理由が無く、ここで描き直しておけば
    // 上のシーク調整と合わせてバーの見た目上のズレが実質ゼロになる。
    drawPianoroll();
    return activePlayer();
  } finally {
    state.isSwapping = false;
  }
}

// 現在鳴っている（かもしれない）試聴音声を止めずに、renderIdのWAVへ乗り換える。
// 再生中なら短時間の等パワークロスフェードで、停止中（または初回読み込み）なら
// 位置を保ったまま即座に差し替える。戻り値は乗り換え完了後のactivePlayer()。
function crossfadeToRender(renderId, canCommit) {
  const task = swapQueue.then(
    () => runSwap(renderId, canCommit),
    () => runSwap(renderId, canCommit),
  );
  swapQueue = task.catch(() => {});
  return task;
}

// 最新世代のレンダーがプレイヤーへ反映されるまで待つ。デバウンスタイマーはここで
// 取り消すが、世代番号は変えないため、既に進行中の同世代レンダーはそのまま共有する。
async function ensureLatestRender() {
  clearAutoRenderTimer();
  while (state.session && state.session.tracks.length > 0) {
    if (
      !state.isRenderStale
      && state.session.hasRender
      && activePlayer().getAttribute("src")
    ) {
      return activePlayer();
    }
    const generation = state.renderGeneration;
    const player = await requestRenderGeneration(generation);
    if (player && isCurrentRenderGeneration(generation)) return player;
  }
  return null;
}

async function playPreparedPlayer(player) {
  try {
    await player.play();
  } catch (_error) {
    showStatus("ブラウザが試聴音声の再生を許可しませんでした。もう一度再生してください。", "error");
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

// スペースキー1回分の再生・一時停止トグル。編集後は旧音源を再生せず、最新レンダーが
// プレイヤーへ反映されるまで待ってから再生する。
async function togglePlayback() {
  if (!state.session || state.session.tracks.length === 0 || document.body.classList.contains("busy")) return;
  const player = activePlayer();
  if (!player.paused) {
    player.pause();
    return;
  }
  clearTimeout(state.patchTimer);
  if (!(await flushPendingTrackSettings())) return;
  if (!(await flushPendingTransform())) return;
  try {
    const preparedPlayer = await ensureLatestRender();
    if (preparedPlayer) await playPreparedPlayer(preparedPlayer);
  } catch (_error) {
    // renderGeneration()が現在世代のエラーを表示する。
  }
}

// 再生ボタンと既存のカーソルキー操作で同じシーク処理を共有する。
// audio.durationはメタデータ読込前にNaNとなるため、常に利用できる
// ピアノロールの曲長をフォールバックとして使う。
function getPlaybackDuration() {
  const playerDuration = activePlayer().duration;
  if (Number.isFinite(playerDuration)) return playerDuration;
  return state.pianoroll?.durationSeconds || 0;
}

// カウンタとピアノロールの再生位置バーが表示すべき秒数。activePlayer()は
// トラック設定等の変更後もsrcを維持したまま鳴り続ける（markRenderStale()参照）ため、
// 単純に現在のactivePlayer()から読むだけでよい。
function getDisplayPlaybackSeconds() {
  return activePlayer().currentTime || 0;
}

function getDisplayPlaybackDuration() {
  return getPlaybackDuration();
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
  const duration = getDisplayPlaybackDuration();
  const current = Math.min(duration, Math.max(0, getDisplayPlaybackSeconds()));
  applyPlaybackClock($("#playback-current-time"), current);
  applyPlaybackClock($("#playback-duration"), duration);
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
    const player = activePlayer();
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

// #player-volume/#player-muteの表示は常にstate.userVolume/isUserMutedを真実の値とする
// （<audio>要素自身の.volumeはクロスフェード中フレームごとに書き換わるため参照しない）。
function updatePlayerVolume() {
  const volumePercent = Math.round(state.userVolume * 100);
  const volumeSlider = $("#player-volume");
  const muteButton = $("#player-mute");
  volumeSlider.value = String(volumePercent);
  volumeSlider.setAttribute("aria-valuetext", `${volumePercent}%`);
  $("#player-volume-value").textContent = `${volumePercent}%`;
  muteButton.setAttribute("aria-pressed", String(state.isUserMuted));
  muteButton.setAttribute("aria-label", state.isUserMuted ? "ミュートを解除" : "ミュート");
}

function updatePlaybackProgress() {
  drawPianoroll();
  updatePlaybackTime();
  followPianorollPlayback();
}

function seekPlaybackTo(seconds) {
  const player = activePlayer();
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
  seekPlaybackTo(activePlayer().currentTime + seconds);
}

function updatePlaybackControls() {
  const player = activePlayer();
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

// A/Bどちらの<audio>要素で発火したイベントも同じハンドラへ束ねるが、
// event.targetが「今のactivePlayer()」と一致する場合だけ処理する。これが無いと、
// クロスフェード中に裏で再生を開始したinactivePlayer()側の'play'や、乗り換え完了後に
// 停止・空にした旧activePlayer()側の'pause'/'emptied'が、今まさに鳴っている新しい
// activePlayer()の状態を巻き戻してしまう（例: rAFループの停止）。
function onActivePlayerEvent(eventName, handler) {
  for (const player of allPlayers()) {
    player.addEventListener(eventName, (event) => {
      if (event.target !== activePlayer()) return;
      handler(event);
    });
  }
}

function setupPlaybackControls() {
  applyPlayerGains();
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
    state.userVolume = Number(event.target.value) / 100;
    if (state.userVolume > 0) state.isUserMuted = false;
    applyPlayerGains();
    updatePlayerVolume();
  });
  $("#player-mute").addEventListener("click", () => {
    state.isUserMuted = !state.isUserMuted;
    applyPlayerGains();
    updatePlayerVolume();
  });
  onActivePlayerEvent("play", (event) => {
    if (event.target.currentTime <= 0.05) {
      setPianorollAutoFollow(true);
      scrollPianorollToStart();
    }
    startPlaybackTimeAnimation();
    updatePlaybackControls();
  });
  onActivePlayerEvent("pause", () => {
    stopPlaybackTimeAnimation();
    updatePlaybackControls();
  });
  onActivePlayerEvent("ended", () => {
    setPianorollAutoFollow(false);
    stopPlaybackTimeAnimation();
    updatePlaybackControls();
  });
  onActivePlayerEvent("emptied", () => {
    setPianorollAutoFollow(false);
    stopPlaybackTimeAnimation();
    updatePlaybackControls();
  });
  for (const eventName of ["loadedmetadata", "durationchange"]) {
    onActivePlayerEvent(eventName, updatePlaybackControls);
  }
  onActivePlayerEvent("timeupdate", updatePlaybackProgress);
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

// ポインターで選択系フォーム部品を操作した後だけフォーカスを解放し、Space/矢印の
// グローバル再生操作へすぐ戻れるようにする。Tab/矢印/Spaceによるキーボード操作では
// pointerdownが発生しないためフォーカスを維持し、ネイティブ操作を妨げない。
// テキスト・数値入力は編集を続ける前提なので対象外。
function resolvePointerControl(target) {
  if (!(target instanceof Element)) return null;
  const label = target.closest("label");
  if (label?.control) return label.control;
  return target.closest("select, input");
}

function rememberPointerControl(event) {
  const control = resolvePointerControl(event.target);
  state.pointerActivatedControl = control?.matches(POINTER_FOCUS_CONTROL_SELECTOR)
    ? control
    : null;
}

function blurPointerChangedControl(event) {
  const control = event.target;
  if (control !== state.pointerActivatedControl) return;
  if (!control.matches(POINTER_CHANGE_CONTROL_SELECTOR)) return;
  state.pointerActivatedControl = null;
  control.blur();
}

function blurPointerReleasedRange(event) {
  const control = resolvePointerControl(event.target);
  if (
    !control
    || control !== state.pointerActivatedControl
    || !control.matches('input[type="range"]')
  ) return;
  state.pointerActivatedControl = null;
  control.blur();
}

function blurPointerClickedChoice(event) {
  const control = resolvePointerControl(event.target);
  if (control !== state.pointerActivatedControl) return;
  if (event.target !== control) return;
  if (!control.matches('input[type="radio"], input[type="checkbox"]')) return;
  state.pointerActivatedControl = null;
  control.blur();
}

function setupPlaybackShortcut() {
  document.addEventListener("click", blurMouseActivatedButton);
  document.addEventListener("pointerdown", rememberPointerControl, true);
  document.addEventListener("change", blurPointerChangedControl);
  document.addEventListener("pointerup", blurPointerReleasedRange);
  document.addEventListener("click", blurPointerClickedChoice);
  document.addEventListener("pointercancel", () => {
    state.pointerActivatedControl = null;
  });
  document.addEventListener("keydown", () => {
    state.pointerActivatedControl = null;
  }, true);
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
