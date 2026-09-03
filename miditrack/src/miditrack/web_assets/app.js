"use strict";

// 他の初期化処理より前にdata-themeを確定させ、ライト→ダークの一瞬のちらつきを
// 防ぐ。保存済みのappTheme（light/dark明示指定）はloadPreferences()内の
// applyThemeSetting()がこの後で上書きする。index.htmlのCSPがインライン
// scriptを許可しない（script-src 'self'）ため、head内のインラインscriptでは
// なくここに置く — このファイル自体はdeferで読み込まれ、render-blockingな
// <link rel="stylesheet">の解決とほぼ同じタイミングで実行されるため、外部
// ファイルであっても実用上ちらつきは防げる。
document.documentElement.dataset.theme =
  matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

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
// --no-token起動時はindex.html側でこのmetaがfalseに置換される
// （web.pyのindex()参照）。トークン必須のときだけ未取得を早期エラーにする。
const isTokenRequired =
  document.querySelector('meta[name="miditrack-token-required"]')?.content !== "false";

// miditrack_app.swiftのmakeWebView()がWKUserScript（atDocumentStart）で
// ページ内スクリプトより先に注入するフラグ。ネイティブアプリのときだけ
// 全画面レイアウトを固定する。WKUserScriptはbody生成時にもクラスを付与し、
// init()でもDOM操作を完了するため、通常レイアウトが一瞬描画されない。
const isNativeApp = window.__miditrackNative === true;
let nativeLocalOpenPromise = Promise.resolve();

const KEEP_ORIGINAL = "__keep__";
const DEFAULT_GM_PROGRAM = "80";
const MIDI_EXTENSION_RE = /\.(mid|midi)$/i;
const MAX_FAVORITE_PROGRAMS = 8;
const PIANOROLL_ZOOM_LEVELS = [1, 1.5, 2, 3, 4, 6, 8];
// Cmd+ホイール1段階ズームに必要な累積deltaY。マウスホイール1クリック分
// （多くの環境で±100前後）でだいたい1段階変わり、トラックパッドの連続した
// 小さなdeltaYは蓄積されてから1段階ずつ変わる（暴走ズームを防ぐ）。
const PIANOROLL_ZOOM_WHEEL_THRESHOLD = 100;
const PLAYBACK_SEEK_SECONDS = 1;
const SHIFT_PLAYBACK_SEEK_SECONDS = 5;
const LOOP_DRAG_THRESHOLD_PX = 6;
const MIN_LOOP_SECONDS = 0.1;
const PREWARM_DELAY_MS = 500;
const BLACK_PIANO_KEY_PITCH_CLASSES = new Set([1, 3, 6, 8, 10]);
const THEME_MODES = new Set(["system", "light", "dark"]);
const PIANOROLL_HEIGHTS = new Set(["compact", "standard", "tall"]);
const PIANOROLL_GRID_DIVISIONS = new Set([4, 8, 16]);
const TRACK_ROLES = [
  { id: "melody", label: "主旋律" },
  { id: "counterMelody", label: "対旋律" },
  { id: "bass", label: "ベース" },
  { id: "accompaniment", label: "伴奏" },
  { id: "percussion", label: "打楽器" },
];
const NEW_ENSEMBLE_PRESET_PROGRAMS = {
  melody: 80,
  counterMelody: 81,
  bass: 38,
  accompaniment: 88,
  percussion: 24,
};
const PERCUSSION_KIT_PROGRAMS = [
  { program: 0, name: "Standard Kit" },
  { program: 8, name: "Room Kit" },
  { program: 16, name: "Power Kit" },
  { program: 24, name: "Electronic Kit" },
  { program: 25, name: "TR-808 Kit" },
  { program: 32, name: "Jazz Kit" },
  { program: 40, name: "Brush Kit" },
  { program: 48, name: "Orchestra Kit" },
  { program: 56, name: "SFX Kit" },
];
// crossfadeToRender()が再生中の乗り換えに使う等パワークロスフェードの長さ（ms）。
const CROSSFADE_MS = 120;
const POINTER_FOCUS_CONTROL_SELECTOR = [
  "select",
  'input[type="radio"]',
  'input[type="checkbox"]',
  'input[type="range"]',
  'input[type="file"]',
  'input[type="color"]',
].join(",");
const POINTER_CHANGE_CONTROL_SELECTOR = [
  "select",
  'input[type="radio"]',
  'input[type="checkbox"]',
  'input[type="file"]',
  'input[type="color"]',
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
  displayMode: "normal",    // 通常表示または全画面DAW表示。サーバー側の設定に永続化する。
  hasRoundedPianorollNotes: true, // ピアノロールのノートを角丸で描くか。設定として永続化する。
  hasOutlinedPianorollNotes: true, // ピアノロールのノートに濃い縁取りを描くか。設定として永続化する。
  isPianorollKeyboardVisible: true, // ピアノロール左端の鍵盤を表示するか。設定として永続化する。
  appTheme: "system", // 全体テーマ（system/light/dark）。設定として永続化する。
  pianorollHeight: "standard", // ピアノロールカードの高さ（compact/standard/tall）。
  isPianorollGridVisible: true, // ピアノロールのグリッド線を描くか。
  pianorollGridDivisions: 8, // 縦グリッドの分割数（4/8/16）。
  pianorollBackgroundColor: null, // 背景色のユーザー指定（#rrggbb）。nullならテーマ既定。
  pianorollGridColor: null, // グリッド線色のユーザー指定（#rrggbb）。nullならテーマ既定。
  trackColorPalette: "rainbow", // トラック配色パレット（rainbow/muted/accessible）。
  instrumentRows: [],     // 現在描画中の楽器行 { select, pinButton } の一覧。ピン留め変更時に全行を再描画する。
  // 現在描画中の全トラック行のコントロール参照
  // { sourceInputs, programSelect, volumeSlider, muteButton }（無いものはnull）。
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
  downloadFilenamePatchPromise: null,
  statusTimer: null,
  convertFields: [], // 変換パネルに描画中のオプションフィールド { name, type, input, conflicts }
  soundfontPayload: null, // 直近の /api/soundfonts レスポンス（hasGameSoundfont変化時の再描画用）
  soloTrackIndex: null,     // ソロ試聴中のトラック番号（無ければnull）
  soloVolumeSnapshot: null, // ソロ開始直前の全トラック音量 { トラック番号: パーセント }。解除時に戻す。
  soloOperation: null,      // ソロ開始・解除中のPromise。同時クリックによる状態競合を防ぐ。
  trackSort: { key: "index", direction: "asc" },
  hideEmptyTracks: true, // ノート数0のトラックを一覧から隠すか（#hide-empty-tracksチェックボックスの状態）。設定として永続化する。
  trackRenderId: 0,
  pianoroll: null,
  pianorollLoadId: 0,
  pianorollSize: null,
  pianorollKeyboardSize: null,
  pianorollTimelineWidth: 0,
  pianorollScrollFrameId: null,
  pianorollPointerId: null,
  pianorollPointerStartClientX: null,
  pianorollPointerAnchorSeconds: null,
  isPianorollLoopDragging: false,
  pianorollZoom: 1,
  pianorollZoomWheelDelta: 0,
  isPianorollAutoFollowing: false,
  pianorollAutoScrollTarget: null,
  loopStartSeconds: null,
  loopEndSeconds: null,
  isLoopEnabled: false,
  highlightedTrackIndex: null,
  ensemblePresets: [],
  ensemblePresetId: null,
  trackRoles: {},
  ensemblePresetSnapshot: null,
  playbackTimeFrameId: null,
  pointerActivatedControl: null,
  renderMode: "fast",
  autoRenderTimer: null,
  renderGeneration: 0,
  renderTask: null,
  renderTaskGeneration: null,
  renderTaskUsesPreview: false,
  fullRenderTask: null,
  // 現在の<audio>が曲全体タイムラインのどの範囲を表すか。短区間WAVの
  // currentTimeは窓内ローカル秒なので、すべての表示・シークはここを介して
  // 曲全体の絶対秒へ変換する。
  activeSource: { kind: "full", timelineStartSeconds: 0, timelineEndSeconds: null },
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
    updatePianorollPlayhead();
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
    state.displayMode = payload.displayMode === "fullscreen" ? "fullscreen" : "normal";
    state.hasRoundedPianorollNotes = payload.roundedPianorollNotes !== false;
    state.hasOutlinedPianorollNotes = payload.outlinedPianorollNotes !== false;
    state.isPianorollKeyboardVisible = payload.showPianorollKeyboard !== false;
    state.appTheme = THEME_MODES.has(payload.appTheme) ? payload.appTheme : "system";
    state.pianorollHeight = PIANOROLL_HEIGHTS.has(payload.pianorollHeight)
      ? payload.pianorollHeight
      : "standard";
    state.isPianorollGridVisible = payload.showPianorollGrid !== false;
    state.pianorollGridDivisions = PIANOROLL_GRID_DIVISIONS.has(payload.pianorollGridDivisions)
      ? payload.pianorollGridDivisions
      : 8;
    state.pianorollBackgroundColor = payload.pianorollBackgroundColor || null;
    state.pianorollGridColor = payload.pianorollGridColor || null;
    state.trackColorPalette = TRACK_COLOR_PALETTES[payload.trackColorPalette]
      ? payload.trackColorPalette
      : "rainbow";
    state.hideEmptyTracks = payload.hideEmptyTracks !== false;
    $("#pianoroll-rounded-notes").checked = state.hasRoundedPianorollNotes;
    $("#pianoroll-outlined-notes").checked = state.hasOutlinedPianorollNotes;
    $("#pianoroll-show-keyboard").checked = state.isPianorollKeyboardVisible;
    $("#hide-empty-tracks").checked = state.hideEmptyTracks;
    updatePianorollKeyboardVisibility();
    setFullscreenLayout(isNativeApp || state.displayMode === "fullscreen");
    applyThemeSetting();
    applyPianorollHeight();
    applyPianorollColors();
    syncSettingsDialogControls();
    state.ensemblePresets = payload.ensemblePresets || [];
    renderEnsemblePresetOptions();
  } catch (_error) {
    // 読み込めなくても機能自体は空の状態で継続する。
  }
}

// "system"をmatchMediaで具体値（light/dark）へ解決する。
function resolveTheme(setting) {
  if (setting === "light" || setting === "dark") return setting;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// 全体テーマ設定をDOMへ反映する。ピアノロールのCanvas色もCSS変数から読むため、
// テーマが変わったら静的Canvasの再描画が要る。ユーザー指定色（null=テーマ
// 既定）が無い色ピッカーの表示値もテーマ変更にあわせて追従させないと、
// 「実際に描かれる色」と「ピッカーの表示」がテーマ切り替え後にずれるため
// syncSettingsDialogControls()も呼ぶ。
function applyThemeSetting() {
  document.documentElement.dataset.theme = resolveTheme(state.appTheme);
  redrawPianorollStatic();
  syncSettingsDialogControls();
}

// ピアノロールカードの高さを表示設定へ反映する。
function applyPianorollHeight() {
  $(".pianoroll-card").dataset.height = state.pianorollHeight;
  refreshPianorollLayout();
}

// ユーザー指定の背景色・グリッド線色を反映する。null（テーマ既定）なら
// カスタムプロパティを削除するだけで、cssColor()がテーマ側の値へ自然に
// フォールバックする。
function applyPianorollColors() {
  const root = document.documentElement;
  // 背景色を指定した場合はPITCHレーンにも同じ色を当てる。片方だけテーマ既定の
  // 階調が残ると、指定色との組み合わせ次第で不自然に浮くため。レーンの区別は
  // 既存の境界線（グリッド線色）が担う。
  const overrides = [
    ["--pianoroll-background", state.pianorollBackgroundColor],
    ["--pianoroll-automation-background", state.pianorollBackgroundColor],
    ["--pianoroll-grid-line", state.pianorollGridColor],
  ];
  for (const [token, value] of overrides) {
    if (value) root.style.setProperty(token, value);
    else root.style.removeProperty(token);
  }
  redrawPianorollStatic();
}

// 設定ダイアログの各コントロールの表示値をstateへ同期する。読み込み直後、
// および「テーマ既定に戻す」操作の直後に呼ぶ。色ピッカーは、ユーザー指定が
// 無い間は現在の実効色（テーマ既定の解決結果）を表示する。
function syncSettingsDialogControls() {
  $("#app-theme").value = state.appTheme;
  $("#pianoroll-height").value = state.pianorollHeight;
  $("#pianoroll-show-grid").checked = state.isPianorollGridVisible;
  $("#pianoroll-grid-divisions").value = String(state.pianorollGridDivisions);
  $("#track-color-palette").value = state.trackColorPalette;
  $("#pianoroll-background-color").value =
    state.pianorollBackgroundColor || cssColor("--pianoroll-background", "#fafbfc");
  $("#pianoroll-grid-color").value =
    state.pianorollGridColor || cssColor("--pianoroll-grid-line", "#ebecf0");
}

// 表示設定の変更をサーバー側設定へ保存する。起動ごとにポートが変わるため
// localStorageではなく/api/preferencesを使う。表示専用の設定なので、保存に
// 失敗しても今回の表示は維持したまま静かに続行する（呼び出し元は既にstateと
// 画面を同期的に更新済み）。
async function savePreferenceFields(updates) {
  try {
    await apiFetch("/api/preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
  } catch (_error) {
    // 保存に失敗しても今回の表示・状態は維持する。
  }
}

// 表示モードの変更をサーバー側設定へ保存する。
function saveDisplayMode() {
  return savePreferenceFields({ displayMode: state.displayMode });
}

// ピアノロールのノート形状をサーバー側設定へ保存する。設定変更は静的Canvasの
// 再描画だけで完結するため、MIDIや試聴音声を再生成する必要はない。
function saveRoundedPianorollNotes() {
  return savePreferenceFields({ roundedPianorollNotes: state.hasRoundedPianorollNotes });
}

// ピアノロールのノート縁取りをサーバー側設定へ保存する。縁取りも表示専用なので、
// 設定変更時は静的Canvasを再描画するだけで、MIDIや試聴音声を再生成しない。
function saveOutlinedPianorollNotes() {
  return savePreferenceFields({ outlinedPianorollNotes: state.hasOutlinedPianorollNotes });
}

// ピアノロール鍵盤の表示状態をサーバー側設定へ保存する。設定変更ではCanvasの
// レイアウトと静的描画だけを更新し、MIDIや試聴音声を再生成しない。
function savePianorollKeyboardVisibility() {
  return savePreferenceFields({ showPianorollKeyboard: state.isPianorollKeyboardVisible });
}

// ピン留め・使用回数の変更をサーバー側の設定ファイルへ書き戻す。UIの見た目自体は
// 呼び出し元が既にstateを更新して同期的に反映しているため、ここは書き込み失敗を
// 静かに無視してよい（次回の変更で再送されれば整合する）。
function savePinnedPrograms() {
  return savePreferenceFields({ pinnedPrograms: [...state.pinnedPrograms] });
}

function saveUsageCounts() {
  return savePreferenceFields({ usageCounts: state.usageCounts });
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
  document.querySelectorAll(".solo-button").forEach((button) => { button.disabled = isBusy; });
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

function sourceFromPayload(payload) {
  return {
    kind: payload.renderKind || "full",
    timelineStartSeconds: Number(payload.timelineStartSeconds) || 0,
    timelineEndSeconds: Number.isFinite(payload.timelineEndSeconds)
      ? Number(payload.timelineEndSeconds)
      : null,
  };
}

function sourceGlobalSeconds(player = activePlayer(), source = state.activeSource) {
  return (source?.timelineStartSeconds || 0) + (player.currentTime || 0);
}

function sourceLocalSeconds(globalSeconds, source) {
  const start = source?.timelineStartSeconds || 0;
  const end = source?.timelineEndSeconds;
  const local = Math.max(0, globalSeconds - start);
  return Number.isFinite(end) ? Math.min(Math.max(0, end - start), local) : local;
}

function sourceContainsTimelineSeconds(seconds, source = state.activeSource) {
  const start = source?.timelineStartSeconds || 0;
  const end = source?.timelineEndSeconds;
  return seconds >= start && (!Number.isFinite(end) || seconds <= end);
}

// 指定世代の試聴音声を生成し、停止中は無音で、再生中はクロスフェードで差し替える。
// 後発の編集に追い越された応答は、プレイヤーへ反映しない。
async function renderGeneration(generation, { preferPreview = false } = {}) {
  const renderMode = selectedRenderMode();
  if (!state.session || state.session.tracks.length === 0) return null;
  if (isCurrentRenderGeneration(generation)) setRenderSpinner(true);
  try {
    let player = activePlayer();
    let didActivatePreview = false;
    if (preferPreview) {
      const previewResponse = await apiFetch("/api/render/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          renderMode,
          stateRevision: state.session.stateRevision,
          timelineSeconds: sourceGlobalSeconds(),
        }),
      });
      const preview = await previewResponse.json();
      if (!isCurrentRenderGeneration(generation)) return null;
      if (preview.available) {
        applyRenderPayload(preview);
        player = await crossfadeToRender(
          preview.renderId,
          () => isCurrentRenderGeneration(generation),
          sourceFromPayload(preview),
        );
        didActivatePreview = true;
        if (!isCurrentRenderGeneration(generation)) return null;
        await applyPendingPianorollReload();
        if (!isCurrentRenderGeneration(generation)) return null;
        clearRenderStale();
        updatePianorollInteraction();
        updatePianorollPlayhead();
      }
    }
    const renderTask = renderFullGeneration(generation, renderMode, { background: preferPreview });
    const fullTask = renderTask.finally(() => {
      if (state.fullRenderTask !== fullTask) return;
      state.fullRenderTask = null;
      if (isCurrentRenderGeneration(generation)) setRenderSpinner(false);
    });
    state.fullRenderTask = fullTask;
    fullTask.catch(() => {});
    return didActivatePreview ? player : fullTask;
  } catch (error) {
    if (isCurrentRenderGeneration(generation)) showStatus(error.message, "error");
    throw error;
  } finally {
    if (isCurrentRenderGeneration(generation)) {
      setRenderSpinner(state.fullRenderTask !== null);
    }
  }
}

async function renderFullGeneration(generation, renderMode, { background = false } = {}) {
  const response = await apiFetch("/api/render", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ renderMode }),
    ...(background ? { priority: "low" } : {}),
  });
  const payload = await response.json();
  if (!isCurrentRenderGeneration(generation)) return null;
  applyRenderPayload(payload);
  const player = await crossfadeToRender(
    payload.renderId,
    () => isCurrentRenderGeneration(generation),
    sourceFromPayload(payload),
  );
  if (!isCurrentRenderGeneration(generation)) return null;
  await applyPendingPianorollReload();
  clearRenderStale();
  updatePianorollInteraction();
  updatePianorollPlayhead();
  return player;
}

// 同じ編集世代なら、自動処理・再生操作・ソロ試聴で1つのレンダーを共有する。
function requestRenderGeneration(generation, { preferPreview = false } = {}) {
  if (
    state.renderTask
    && state.renderTaskGeneration === generation
    && (state.renderTaskUsesPreview || !preferPreview)
  ) {
    return state.renderTask;
  }
  const task = renderGeneration(generation, { preferPreview });
  state.renderTask = task;
  state.renderTaskGeneration = generation;
  state.renderTaskUsesPreview = preferPreview;
  task.finally(() => {
    if (state.renderTask === task) {
      state.renderTask = null;
      state.renderTaskGeneration = null;
      state.renderTaskUsesPreview = false;
    }
  }).catch(() => {});
  return task;
}

// トラック設定・SoundFont・速度/ピッチ・試聴モード等の変更から500ms操作が無かったら、
// 最新状態を自動レンダーする。停止中の編集では短区間プレビューを作らず、従来どおり
// 全尺だけを仕上げる。再生開始時のensureLatestRender()だけがpreferPreviewを指定する。
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
  return state.programNames[track.currentProgram] || `${track.currentProgram + 1}番`;
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

// 楽器<select>はネイティブポップアップがキー入力を奪うためmousedown時点で、
// 音源radioとミュートボタンは選択対象が直接クリックできるためclick時点で、
// Cmd/Ctrlによる全トラック一括適用を判定する。
function isBulkApplyEvent(event) {
  return event.metaKey || event.ctrlKey;
}

// Cmd/Ctrlを押しながらの音源選択で、他の全トラックの音源radioも同じ値に
// 揃える。選択肢が無い（その値を持たない）行や、既に同じ値の行はスキップする。
function applySourceToAllTracks(value, originIndex) {
  for (const row of state.trackRows) {
    if (!row.sourceInputs || row.index === originIndex) continue;
    const sourceInput = row.sourceInputs.find((input) => input.value === value);
    if (!sourceInput || sourceInput.checked) continue;
    sourceInput.checked = true;
    sourceInput.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

function updateTrackSource(track, row, value) {
  const isHardware = value === "game" && isChipHardwareFormat();
  row.classList.toggle("is-hardware", isHardware);
  const programSelect = row.querySelector(".program-select");
  if (programSelect) {
    programSelect.disabled = value !== "soundfont";
    if (
      value === "soundfont" &&
      track.availableSources.includes("game") &&
      programSelect.value === KEEP_ORIGINAL
    ) {
      programSelect.value = DEFAULT_GM_PROGRAM;
      onProgramChange(track.index, programSelect.value);
    }
  }
  onSourceChange(track.index, value);
}

function createTrackSourceOption(track, row, source) {
  const input = document.createElement("input");
  input.className = "render-mode-input track-source-input";
  input.type = "radio";
  input.name = `track-source-${track.index}`;
  input.id = `track-source-${track.index}-${source}`;
  input.value = source;
  input.checked = source === track.source;
  const label = document.createElement("label");
  label.htmlFor = input.id;
  label.textContent = source === "game" ? "原曲" : "SF";
  input.addEventListener("change", () => {
    if (input.checked) updateTrackSource(track, row, input.value);
  });
  input.addEventListener("click", (event) => {
    if (isBulkApplyEvent(event)) applySourceToAllTracks(input.value, track.index);
  });
  return { input, label };
}

function createTrackSourceControl(track, row, trackRowRef) {
  const fieldset = document.createElement("fieldset");
  fieldset.className = "render-mode-field track-source-field";
  const legend = document.createElement("legend");
  legend.className = "visually-hidden";
  legend.textContent = `${track.name}の音源`;
  const options = document.createElement("div");
  options.className = "render-mode-options track-source-options";
  const sourceInputs = track.availableSources.map((source) => {
    const option = createTrackSourceOption(track, row, source);
    options.append(option.input, option.label);
    return option.input;
  });
  if (track.sourceGroupSize > 1) {
    fieldset.title = `同じ物理チャンネルを共有する${track.sourceGroupSize}トラックを同時に切り替えます`;
  }
  fieldset.append(legend, options);
  trackRowRef.sourceInputs = sourceInputs;
  return fieldset;
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

function setHighlightedTrack(trackIndex) {
  if (state.highlightedTrackIndex === trackIndex) return;
  state.highlightedTrackIndex = trackIndex;
  redrawPianorollStatic();
}

// トラック名とカラーバーを一つのネイティブbuttonとして扱い、ポインターまたは
// キーボードを押している間だけピアノロール上の対象トラックを強調する。
// clickで状態を固定しないため、再生・ミュート・ソロの状態には一切影響しない。
function setupTrackHighlightControl(control, trackIndex) {
  const beginHighlight = () => setHighlightedTrack(trackIndex);
  const endHighlight = () => {
    if (state.highlightedTrackIndex === trackIndex) setHighlightedTrack(null);
  };
  control.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    control.setPointerCapture(event.pointerId);
    beginHighlight();
  });
  control.addEventListener("pointerup", endHighlight);
  control.addEventListener("pointercancel", endHighlight);
  control.addEventListener("lostpointercapture", endHighlight);
  control.addEventListener("keydown", (event) => {
    if (!["Enter", " "].includes(event.key) || event.repeat) return;
    if (event.key === " ") event.preventDefault();
    beginHighlight();
  });
  control.addEventListener("keyup", (event) => {
    if (["Enter", " "].includes(event.key)) endHighlight();
  });
  control.addEventListener("blur", endHighlight);
}

function activeEnsemblePreset() {
  return state.ensemblePresets.find((preset) => preset.id === state.ensemblePresetId) || null;
}

function createTrackRoleControl(track, trackRowRef) {
  const select = document.createElement("select");
  select.className = "program-select role-select";
  select.dataset.trackIndex = String(track.index);
  select.setAttribute("aria-label", `${track.name}の役割`);
  const emptyOption = document.createElement("option");
  emptyOption.value = "";
  emptyOption.textContent = "役割を選択";
  select.appendChild(emptyOption);
  for (const role of TRACK_ROLES) {
    const option = document.createElement("option");
    option.value = role.id;
    option.textContent = role.label;
    select.appendChild(option);
  }
  select.value = state.trackRoles[track.index] || "";
  select.addEventListener("change", () => onTrackRoleChange(track.index, select.value));
  trackRowRef.roleSelect = select;
  return select;
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
    sourceInputs: null,
    programSelect: null,
    roleSelect: null,
    volumeSlider: null,
    muteButton: null,
    soloButton: null,
  };
  rowState.trackRows.push(trackRowRef);

  const nameCell = document.createElement("td");
  nameCell.className = "track-name-cell";
  const nameLabel = document.createElement("button");
  nameLabel.type = "button";
  nameLabel.className = "track-name";
  nameLabel.setAttribute("aria-label", `${track.name}を押している間、ピアノロールで強調表示`);
  const colorBar = document.createElement("span");
  colorBar.className = "track-color-bar";
  colorBar.setAttribute("aria-hidden", "true");
  colorBar.style.setProperty("--track-color", getTrackColor(track.index, state.session?.tracks.length || 1));
  const nameText = document.createElement("span");
  nameText.className = "track-name-text";
  nameText.textContent = track.name;
  nameLabel.append(colorBar, nameText);
  setupTrackHighlightControl(nameLabel, track.index);
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
    sourceCell.appendChild(createTrackSourceControl(track, row, trackRowRef));
  } else {
    sourceCell.textContent = track.source === "game" ? "原曲の音源" : "SoundFont";
  }
  row.classList.toggle("is-hardware", track.source === "game" && isChipHardwareFormat());
  row.appendChild(sourceCell);

  const instrumentCell = document.createElement("td");
  instrumentCell.className = "track-instrument-cell";
  if (track.editable) {
    if (activeEnsemblePreset()) {
      instrumentCell.appendChild(createTrackRoleControl(track, trackRowRef));
    } else {
    const fragment = await loadInstrumentOptions();
    const select = document.createElement("select");
    select.className = "program-select instrument-select";
    select.dataset.trackIndex = String(track.index);

    const keepOption = document.createElement("option");
    keepOption.value = KEEP_ORIGINAL;
    const hasGameSource = track.availableSources.includes("game");
    // VGM/NSFの実機チップ経路（vgm2midi/nsf2midi）はGM準拠のProgram Changeを
    // 書き込むため、currentProgramをそのままGM音色として案内できる。SPCの
    // "game"はBRRサンプル由来のバンク切替で、Program Changeはゲーム固有の
    // インデックス（GM名と無関係）なので、この扱いには含めない。
    const hasKnownGmProgram =
      isChipHardwareFormat() &&
      track.currentProgram !== null &&
      track.currentProgram !== undefined;
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
        : hasKnownGmProgram
          ? String(track.currentProgram)
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
      pinButton.disabled = program === null || select.disabled;
    };
    updatePinButton();

    select.addEventListener("change", () => {
      onProgramChange(track.index, select.value);
      updatePinButton();
    });
    // 楽器<select>はネイティブポップアップを持つためmousedown+preventDefault方式にする
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
  // 全画面レイアウトではtrをgrid化して3段のチャンネルストリップへ再配置する
  // （app.css の body.is-fullscreen .track-row）ため、display:gridで失われる
  // テーブルのセマンティクスをここで明示的に補う。
  row.setAttribute("role", "row");
  for (const cell of row.children) cell.setAttribute("role", "cell");
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

function captureEnsemblePresetSnapshot() {
  const assignments = {};
  const sources = {};
  for (const track of state.session?.tracks || []) {
    assignments[track.index] = track.assignedProgram ?? null;
    sources[track.index] = track.source;
  }
  return { assignments, sources };
}

function queueTrackRoleAssignment(trackIndex, roleId) {
  const preset = activeEnsemblePreset();
  const track = state.session?.tracks.find((item) => item.index === trackIndex);
  if (!preset || !track || !roleId) return;
  const program = preset.programs[roleId];
  if (program === undefined) return;
  clearSoloStateIfActive();
  state.pendingAssignments[trackIndex] = program;
  if (track.availableSources.includes("soundfont")) {
    state.pendingSources[trackIndex] = "soundfont";
  }
}

function onTrackRoleChange(trackIndex, roleId) {
  if (TRACK_ROLES.some((role) => role.id === roleId)) {
    state.trackRoles[trackIndex] = roleId;
    queueTrackRoleAssignment(trackIndex, roleId);
  } else {
    delete state.trackRoles[trackIndex];
    const snapshot = state.ensemblePresetSnapshot;
    if (snapshot) {
      state.pendingAssignments[trackIndex] = snapshot.assignments[trackIndex] ?? null;
      state.pendingSources[trackIndex] = snapshot.sources[trackIndex];
    }
  }
  clearTimeout(state.patchTimer);
  state.patchTimer = setTimeout(flushPendingTrackSettings, 200);
}

function pianorollTrackStatistics(track) {
  const payload = state.pianoroll;
  if (!payload || !track?.notes?.length) return { averageNote: 0, density: 0 };
  const offsets = pianorollFieldOffsets(payload);
  let noteTotal = 0;
  let noteCount = 0;
  for (let offset = 0; offset < track.notes.length; offset += payload.stride) {
    noteTotal += track.notes[offset + offsets.note];
    noteCount += 1;
  }
  return {
    averageNote: noteCount > 0 ? noteTotal / noteCount : 0,
    density: noteCount / Math.max(1, payload.durationSeconds),
  };
}

// MIDIチャンネル、トラック名、音域、発音密度から初期役割を提案する。
// 結果は確定値ではなく各行の<select>へ入る初期候補で、ユーザーが自由に修正できる。
function suggestTrackRoles() {
  const tracks = (state.session?.tracks || []).filter((track) => track.editable && track.noteCount > 0);
  const pianoTracks = new Map((state.pianoroll?.tracks || []).map((track) => [track.index, track]));
  const suggested = {};
  const pitched = [];
  for (const track of tracks) {
    const isPercussion = track.channels.includes(9)
      || /drum|perc|rhythm|noise|kick|snare|打楽器|ドラム|ノイズ/i.test(track.name);
    if (isPercussion) {
      suggested[track.index] = "percussion";
      continue;
    }
    const statistics = pianorollTrackStatistics(pianoTracks.get(track.index));
    pitched.push({ track, ...statistics });
  }
  if (pitched.length === 1) {
    suggested[pitched[0].track.index] = "melody";
  } else if (pitched.length > 1) {
    const byPitch = pitched.slice().sort((left, right) => left.averageNote - right.averageNote);
    const bass = byPitch.shift();
    suggested[bass.track.index] = "bass";
    const byLeadScore = byPitch.sort((left, right) => (
      (right.averageNote + right.density * 2) - (left.averageNote + left.density * 2)
    ));
    const melody = byLeadScore.shift();
    if (melody) suggested[melody.track.index] = "melody";
    const counterMelody = byLeadScore.shift();
    if (counterMelody) suggested[counterMelody.track.index] = "counterMelody";
    for (const item of byLeadScore) suggested[item.track.index] = "accompaniment";
  }
  state.trackRoles = suggested;
  return Object.keys(suggested).length;
}

function renderEnsemblePresetOptions() {
  const select = $("#ensemble-preset-select");
  if (!select) return;
  select.replaceChildren();
  const clearOption = document.createElement("option");
  clearOption.value = "";
  clearOption.textContent = "プリセット解除";
  select.appendChild(clearOption);
  for (const preset of state.ensemblePresets) {
    const option = document.createElement("option");
    option.value = preset.id;
    option.textContent = preset.name;
    select.appendChild(option);
  }
  updateEnsemblePresetControls();
}

function updateEnsemblePresetControls() {
  const select = $("#ensemble-preset-select");
  if (!select) return;
  select.value = state.ensemblePresetId || "";
  select.disabled = !(state.session && state.session.tracks.length > 0);
  $("#ensemble-preset-new").disabled = false;
  $("#ensemble-preset-edit").disabled = !activeEnsemblePreset();
  $("#ensemble-preset-delete").disabled = !activeEnsemblePreset();
  const header = $(".track-instrument-header-label");
  if (header) header.textContent = state.ensemblePresetId ? "役割" : "楽器";
}

async function handleEnsemblePresetChange(event) {
  const nextPresetId = event.target.value || null;
  clearTimeout(state.patchTimer);
  if (!(await flushPendingTrackSettings())) {
    updateEnsemblePresetControls();
    return false;
  }
  if (!nextPresetId) {
    const previousPresetId = state.ensemblePresetId;
    const snapshot = state.ensemblePresetSnapshot;
    state.ensemblePresetId = null;
    if (snapshot) {
      Object.assign(state.pendingAssignments, snapshot.assignments);
      Object.assign(state.pendingSources, snapshot.sources);
    }
    state.ensemblePresetSnapshot = null;
    updateEnsemblePresetControls();
    if (snapshot) {
      const didRestore = await flushPendingTrackSettings();
      if (!didRestore) {
        state.ensemblePresetId = previousPresetId;
        state.ensemblePresetSnapshot = snapshot;
        updateEnsemblePresetControls();
      }
      return didRestore;
    }
    await renderTrackList();
    return true;
  }
  if (!state.ensemblePresets.some((preset) => preset.id === nextPresetId)) {
    updateEnsemblePresetControls();
    return false;
  }
  if (!state.ensemblePresetId) {
    state.ensemblePresetSnapshot = captureEnsemblePresetSnapshot();
  }
  state.ensemblePresetId = nextPresetId;
  if (Object.keys(state.trackRoles).length === 0) {
    const suggestionCount = suggestTrackRoles();
    if (suggestionCount > 0) {
      showStatus(`${suggestionCount}トラックの役割を提案しました。必要に応じて変更できます。`);
    }
  }
  for (const [trackIndex, roleId] of Object.entries(state.trackRoles)) {
    queueTrackRoleAssignment(Number(trackIndex), roleId);
  }
  updateEnsemblePresetControls();
  if (Object.keys(state.pendingAssignments).length > 0 || Object.keys(state.pendingSources).length > 0) {
    return flushPendingTrackSettings();
  }
  await renderTrackList();
  return true;
}

function createEnsemblePresetId() {
  const suffix = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `custom-${suffix}`;
}

function createPercussionKitOptions(select) {
  for (const kit of PERCUSSION_KIT_PROGRAMS) {
    const option = document.createElement("option");
    option.value = String(kit.program);
    option.textContent = kit.name;
    select.appendChild(option);
  }
}

async function populateEnsemblePresetDialog(preset = null) {
  const form = $("#ensemble-preset-form");
  const isEditing = !!preset;
  const programs = preset?.programs || NEW_ENSEMBLE_PRESET_PROGRAMS;
  form.dataset.presetId = preset?.id || "";
  $("#ensemble-preset-dialog-title").textContent = isEditing ? "編成プリセットを編集" : "編成プリセットを新規作成";
  $("#ensemble-preset-name").value = preset?.name || "";
  const instrumentOptions = await loadInstrumentOptions();
  for (const role of TRACK_ROLES) {
    const select = $(`#ensemble-preset-program-${role.id}`);
    select.replaceChildren();
    if (role.id === "percussion") createPercussionKitOptions(select);
    else select.appendChild(instrumentOptions.cloneNode(true));
    if (!Array.from(select.options).some((option) => option.value === String(programs[role.id]))) {
      const option = document.createElement("option");
      option.value = String(programs[role.id]);
      option.textContent = `ドラムキット（プログラム ${Number(programs[role.id]) + 1}）`;
      select.appendChild(option);
    }
    select.value = String(programs[role.id]);
  }
}

async function openEnsemblePresetDialog(preset = null) {
  const dialog = $("#ensemble-preset-dialog");
  try {
    await populateEnsemblePresetDialog(preset);
    dialog.showModal();
    $("#ensemble-preset-name").focus();
  } catch (error) {
    showStatus(error.message, "error");
  }
}

function collectEnsemblePresetPrograms() {
  return Object.fromEntries(TRACK_ROLES.map((role) => [
    role.id,
    Number($(`#ensemble-preset-program-${role.id}`).value),
  ]));
}

async function saveEnsemblePresets(presets) {
  const response = await apiFetch("/api/preferences", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ensemblePresets: presets }),
  });
  const payload = await response.json();
  state.ensemblePresets = payload.ensemblePresets || [];
  renderEnsemblePresetOptions();
}

async function applyActiveEnsemblePreset() {
  for (const [trackIndex, roleId] of Object.entries(state.trackRoles)) {
    queueTrackRoleAssignment(Number(trackIndex), roleId);
  }
  if (Object.keys(state.pendingAssignments).length > 0 || Object.keys(state.pendingSources).length > 0) {
    await flushPendingTrackSettings();
  } else {
    await renderTrackList();
  }
}

async function handleEnsemblePresetSave(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const presetId = form.dataset.presetId || createEnsemblePresetId();
  const preset = {
    id: presetId,
    name: $("#ensemble-preset-name").value.trim(),
    programs: collectEnsemblePresetPrograms(),
  };
  const existingIndex = state.ensemblePresets.findIndex((item) => item.id === presetId);
  const nextPresets = existingIndex < 0
    ? [...state.ensemblePresets, preset]
    : state.ensemblePresets.map((item, index) => (index === existingIndex ? preset : item));
  try {
    await saveEnsemblePresets(nextPresets);
    $("#ensemble-preset-dialog").close();
    if (state.ensemblePresetId === presetId) await applyActiveEnsemblePreset();
    showStatus(`編成プリセット「${preset.name}」を保存しました。`, "success");
  } catch (error) {
    showStatus(error.message, "error");
  }
}

async function handleEnsemblePresetDelete() {
  const preset = activeEnsemblePreset();
  if (!preset || !window.confirm(`編成プリセット「${preset.name}」を削除しますか？`)) return;
  try {
    if (!(await handleEnsemblePresetChange({ target: { value: "" } }))) return;
    await saveEnsemblePresets(state.ensemblePresets.filter((item) => item.id !== preset.id));
    showStatus(`編成プリセット「${preset.name}」を削除しました。`, "success");
  } catch (error) {
    showStatus(error.message, "error");
  }
}

function setupEnsemblePresets() {
  const select = $("#ensemble-preset-select");
  select.addEventListener("change", handleEnsemblePresetChange);
  $("#ensemble-preset-new").addEventListener("click", () => openEnsemblePresetDialog());
  $("#ensemble-preset-edit").addEventListener("click", () => {
    openEnsemblePresetDialog(activeEnsemblePreset());
  });
  $("#ensemble-preset-delete").addEventListener("click", handleEnsemblePresetDelete);
  $("#ensemble-preset-form").addEventListener("submit", handleEnsemblePresetSave);
  $("#ensemble-preset-cancel").addEventListener("click", () => {
    $("#ensemble-preset-dialog").close();
  });
  // ダイアログを閉じると開いたボタン（新規作成・編集）へフォーカスが戻るため、
  // closeイベント後にblur()してスペースキーで再生トグルを使えるようにする。
  $("#ensemble-preset-dialog").addEventListener("close", () => {
    const active = document.activeElement;
    if (active === $("#ensemble-preset-new") || active === $("#ensemble-preset-edit")) {
      active.blur();
    }
  });
  renderEnsemblePresetOptions();
  updateEnsemblePresetControls();
}

// 指定トラック以外を音量0にしてレンダリング・再生する「ソロ試聴」を
// 開始／解除する。もう一度同じボタンを押すと解除に切り替わる。
async function toggleTrackSolo(trackIndex) {
  if (state.soloOperation) return state.soloOperation;
  const operation = state.soloTrackIndex === trackIndex
    ? exitSolo()
    : enterSolo(trackIndex);
  state.soloOperation = operation;
  try {
    await operation;
  } finally {
    if (state.soloOperation === operation) state.soloOperation = null;
  }
}

function collectCurrentVolumes() {
  const volumes = {};
  for (const track of state.session?.tracks || []) {
    if (!track.volumeEditable) continue;
    volumes[track.index] = track.volumePercent;
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
  if (!snapshot) return;

  setBusy(true);
  try {
    const response = await apiFetch("/api/session/tracks", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ volumes: snapshot }),
    });
    state.session = await response.json();
    state.soloTrackIndex = null;
    state.soloVolumeSnapshot = null;
    await renderTrackList();
    updateSectionsReadiness();
    markRenderStale();
    scheduleAutoRender();
  } catch (error) {
    // PATCHに失敗した場合は、解除前のソロ状態と復元用スナップショットを保持する。
    // ここで捨てると、他トラックが0%のままになり再試行もできない。
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
  if (key === "instrument" && state.ensemblePresetId) return state.trackRoles[track.index] || "";
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

// トラック配色パレット。fill/outlineはどちらも(trackIndex, trackCount, opacity)を
// 受け取り、getTrackColor()/getTrackOutlineColor()経由でのみ使われる —
// ピアノロールのノートとトラック行のカラーマーカーが同じ色を参照する
// 唯一の真実の源（CLAUDE.md参照）はこの2関数のままで、パレットはその内部実装。
const TRACK_COLOR_PALETTES = {
  // 現行の見た目。色相をトラック数で等分する。
  rainbow: {
    fill: (trackIndex, trackCount, opacity) => {
      const hue = (trackIndex / Math.max(1, trackCount)) * 360;
      return `hsl(${hue} 68% 48% / ${opacity})`;
    },
    // 塗りと同じ色相・彩度のまま明度だけを下げ、トラック色と一貫した
    // 控えめな縁取り色を返す。
    outline: (trackIndex, trackCount, opacity) => {
      const hue = (trackIndex / Math.max(1, trackCount)) * 360;
      return `hsl(${hue} 68% 40% / ${opacity})`;
    },
  },
  // 虹色より鮮やかにし、トラックごとの色分けを強調する。
  vivid: {
    fill: (trackIndex, trackCount, opacity) => {
      const hue = (trackIndex / Math.max(1, trackCount)) * 360;
      return `hsl(${hue} 90% 48% / ${opacity})`;
    },
    outline: (trackIndex, trackCount, opacity) => {
      const hue = (trackIndex / Math.max(1, trackCount)) * 360;
      return `hsl(${hue} 90% 38% / ${opacity})`;
    },
  },
  // 彩度を落として長時間の閲覧でも目が疲れにくくする。
  muted: {
    fill: (trackIndex, trackCount, opacity) => {
      const hue = (trackIndex / Math.max(1, trackCount)) * 360;
      return `hsl(${hue} 42% 52% / ${opacity})`;
    },
    outline: (trackIndex, trackCount, opacity) => {
      const hue = (trackIndex / Math.max(1, trackCount)) * 360;
      return `hsl(${hue} 42% 44% / ${opacity})`;
    },
  },
  // 色覚多様性に配慮した固定8色（Okabe-Ito配色）を巡回して割り当てる。
  accessible: {
    colors: [
      [230, 159, 0], [86, 180, 233], [0, 158, 115], [240, 228, 66],
      [0, 114, 178], [213, 94, 0], [204, 121, 167], [0, 0, 0],
    ],
    fill(trackIndex, _trackCount, opacity) {
      const [r, g, b] = this.colors[trackIndex % this.colors.length];
      return `rgb(${r} ${g} ${b} / ${opacity})`;
    },
    outline(trackIndex, _trackCount, opacity) {
      const [r, g, b] = this.colors[trackIndex % this.colors.length];
      const darken = (channel) => Math.round(channel * 0.78);
      return `rgb(${darken(r)} ${darken(g)} ${darken(b)} / ${opacity})`;
    },
  },
};

function activeTrackColorPalette() {
  return TRACK_COLOR_PALETTES[state.trackColorPalette] || TRACK_COLOR_PALETTES.rainbow;
}

function getTrackColor(trackIndex, trackCount, opacity = 1) {
  return activeTrackColorPalette().fill(trackIndex, trackCount, opacity);
}

function getTrackOutlineColor(trackIndex, trackCount, opacity = 1) {
  return activeTrackColorPalette().outline(trackIndex, trackCount, opacity);
}

function formatPianorollTime(seconds) {
  const safeSeconds = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = Math.floor(safeSeconds % 60);
  return minutes > 0 ? `${minutes}分${remainder}秒` : `${remainder}秒`;
}

function formatPlaybackClock(seconds) {
  const totalMilliseconds = Math.max(0, Math.floor((Number(seconds) || 0) * 1000));
  const minutes = Math.floor(totalMilliseconds / 60000);
  const remainder = totalMilliseconds % 60000;
  const wholeSeconds = Math.floor(remainder / 1000);
  const milliseconds = remainder % 1000;
  return {
    whole: `${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}`,
    decimal: String(milliseconds).padStart(3, "0"),
  };
}

function normalizePianorollLoopRange(startSeconds, endSeconds) {
  const duration = state.pianoroll?.durationSeconds || 0;
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || duration <= 0) return null;
  const start = Math.min(duration, Math.max(0, startSeconds));
  const end = Math.min(duration, Math.max(0, endSeconds));
  if (end - start < MIN_LOOP_SECONDS) return null;
  return { start, end };
}

function selectedPianorollLoopRange() {
  return normalizePianorollLoopRange(state.loopStartSeconds, state.loopEndSeconds);
}

function activePianorollLoopRange() {
  return state.isLoopEnabled ? selectedPianorollLoopRange() : null;
}

function updatePianorollLoopRegion() {
  const region = $("#pianoroll-loop-region");
  const range = selectedPianorollLoopRange();
  const payload = state.pianoroll;
  const size = state.pianorollSize;
  const timelineWidth = state.pianorollTimelineWidth;
  if (!region || !range || !payload || !size || !timelineWidth || payload.durationSeconds <= 0) {
    if (region) region.hidden = true;
    return;
  }
  const scrollLeft = $("#pianoroll-scroll").scrollLeft;
  const startX = range.start / payload.durationSeconds * timelineWidth - scrollLeft;
  const endX = range.end / payload.durationSeconds * timelineWidth - scrollLeft;
  const visibleStart = Math.max(0, startX);
  const visibleEnd = Math.min(size.width, endX);
  if (visibleEnd <= visibleStart) {
    region.hidden = true;
    return;
  }
  region.hidden = false;
  region.classList.toggle("is-enabled", state.isLoopEnabled);
  region.style.inlineSize = `${visibleEnd - visibleStart}px`;
  region.style.transform = `translate3d(${visibleStart}px, 0, 0)`;
}

function setPianorollLoopRange(startSeconds, endSeconds, { enable = state.isLoopEnabled } = {}) {
  const range = normalizePianorollLoopRange(startSeconds, endSeconds);
  if (!range) return false;
  state.loopStartSeconds = range.start;
  state.loopEndSeconds = range.end;
  state.isLoopEnabled = enable;
  updatePianorollLoopRegion();
  return true;
}

function clearPianorollLoop() {
  state.loopStartSeconds = null;
  state.loopEndSeconds = null;
  state.isLoopEnabled = false;
  updatePianorollLoopRegion();
}

function setPianorollMessage(message, status = "") {
  $("#pianoroll-empty").textContent = message;
  $("#pianoroll-empty").hidden = !message;
  $("#pianoroll-status").textContent = status;
}

function clearPianoroll(message = "MIDIを読み込むとここに表示されます。") {
  state.pianoroll = null;
  updatePianorollKeyboardVisibility();
  clearPianorollLoop();
  resetPianorollZoom();
  setPianorollMessage(message);
  updatePianorollInteraction();
  refreshPianorollLayout();
}

// 取得済みのペイロードをstate.pianorollへ反映して再描画する。loadPianoroll()と
// schedulePianorollReload()（フェッチと適用のタイミングを分離する版）の両方から
// 呼ぶ共通の「適用」部分。
function applyPianorollPayload(payload) {
  state.pianoroll = payload;
  const existingRange = selectedPianorollLoopRange();
  if (existingRange) {
    setPianorollLoopRange(existingRange.start, existingRange.end);
  } else {
    clearPianorollLoop();
  }
  updatePlaybackTime();
  const status = payload.truncated
    ? "ノート数が表示上限を超えたため、先頭部分のみ表示しています。"
    : "";
  setPianorollMessage(payload.noteCount > 0 ? "" : "表示できるノートがありません。", status);
  updatePianorollKeyboardVisibility();
  refreshPianorollLayout();
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

function drawPianorollGrid(context, width, noteHeight, timelineWidth, scrollLeft) {
  // 背景は表示設定に関わらず常に描く。グリッド線の表示ON/OFFは線だけを
  // 丸ごとスキップし、背景色には影響しない。
  context.fillStyle = cssColor("--pianoroll-background", "#fafbfc");
  context.fillRect(0, 0, width, noteHeight);
  if (!state.isPianorollGridVisible) return;
  context.strokeStyle = cssColor("--pianoroll-grid-line", "#ebecf0");
  context.lineWidth = 1;
  context.beginPath();
  const divisions = state.pianorollGridDivisions || 8;
  for (let index = 1; index < divisions; index += 1) {
    const x = Math.round(timelineWidth * index / divisions - scrollLeft) + 0.5;
    if (x < 0 || x > width) continue;
    context.moveTo(x, 0);
    context.lineTo(x, noteHeight);
  }
  // 横線は縦グリッドの分割数設定とは独立に、常に6分割のまま音高の目安を示す。
  for (let index = 1; index < 6; index += 1) {
    const y = Math.round(noteHeight * index / 6) + 0.5;
    context.moveTo(0, y);
    context.lineTo(width, y);
  }
  context.stroke();
}

function pianorollPitchY(pitch, layout) {
  return layout.height - ((pitch - layout.minNote + 1) / layout.noteSpan * layout.height);
}

// ノートと鍵盤で同じ整数CSSピクセル境界を使う。音域を高さで割った値は多くの場合
// 小数になるため、この境界を共有しないと隣り合うCanvasで最大1〜2pxずれる。
function pianorollPitchBounds(pitch, layout) {
  const top = Math.round(pianorollPitchY(pitch, layout));
  const bottom = Math.round(pianorollPitchY(pitch - 1, layout));
  return { top, bottom, height: Math.max(1, bottom - top) };
}

function isPianorollBlackKey(pitch) {
  return BLACK_PIANO_KEY_PITCH_CLASSES.has((pitch % 12 + 12) % 12);
}

function pianorollOctaveLabel(pitch) {
  return pitch % 12 === 0 ? `C${Math.floor(pitch / 12) - 1}` : "";
}

function pianorollPitchCenterY(pitch, layout) {
  const { top, height } = pianorollPitchBounds(pitch, layout);
  return top + height / 2;
}

function adjacentPianorollWhitePitch(pitch, direction) {
  let adjacentPitch = pitch + direction;
  while (isPianorollBlackKey(adjacentPitch)) adjacentPitch += direction;
  return adjacentPitch;
}

// 黒鍵のMIDI音高行を鍵盤の基準にし、前後の白鍵中心との中点を白鍵の境界にする。
// これにより黒鍵がロール上のC#/D#などの行と一致し、白鍵も正しい間隔で連続する。
function pianorollWhiteKeyBounds(pitch, layout) {
  const pitchHeight = layout.height / layout.noteSpan;
  const center = pianorollPitchCenterY(pitch, layout);
  const higherPitch = adjacentPianorollWhitePitch(pitch, 1);
  const lowerPitch = adjacentPianorollWhitePitch(pitch, -1);
  const top = (center + pianorollPitchCenterY(higherPitch, layout)) / 2;
  const bottom = (center + pianorollPitchCenterY(lowerPitch, layout)) / 2;
  return {
    top: Math.max(0, top),
    bottom: Math.min(layout.noteHeight, Math.max(top + pitchHeight, bottom)),
  };
}

function updatePianorollKeyboardVisibility() {
  const keyboard = $("#pianoroll-keyboard");
  keyboard.hidden = !(state.isPianorollKeyboardVisible && state.pianoroll?.noteCount > 0);
}

function clearPianorollKeyboard() {
  const keyboard = $("#pianoroll-keyboard");
  const context = keyboard.getContext("2d");
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, keyboard.width, keyboard.height);
}

// 鍵盤はノートCanvasと同じ音高計算を使う。黒鍵は対応するMIDI半音行を
// そのまま塗ることで、ノート行とのピクセル単位の整合を保つ。
function drawPianorollKeyboard(layout) {
  const keyboard = $("#pianoroll-keyboard");
  const size = state.pianorollKeyboardSize;
  if (keyboard.hidden || !size || size.width <= 0 || size.height <= 0) return;
  const context = keyboard.getContext("2d");
  const keyboardNoteHeight = Math.min(layout.noteHeight, size.height);
  const blackKeyWidth = Math.round(size.width * 0.72);
  // layout.minNote/maxNoteはピッチベンドで実際に鳴った音高（pianoroll.pyの
  // note_numbers）の最小・最大なので小数を含みうる（例: 29.988）。鍵盤の
  // 白鍵/黒鍵判定・Cラベルは半音単位の整数ピッチでしか意味を持たないため、
  // 表示範囲を整数へ丸めてから1半音ずつ列挙する。位置計算自体は
  // pianorollPitchBounds()等が元のlayout.minNote/noteSpanを使い続けるので、
  // ここを整数化しても縦位置のスケールはずれない。
  const firstPitch = Math.floor(layout.minNote);
  const lastPitch = Math.ceil(layout.maxNote);
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, keyboard.width, keyboard.height);
  context.setTransform(size.scaleX, 0, 0, size.scaleY, 0, 0);
  context.fillStyle = cssColor("--pianoroll-key-black", "#172b4d");
  context.fillRect(0, 0, size.width, keyboardNoteHeight);
  context.fillStyle = cssColor("--pianoroll-key-automation", "#f4f5f7");
  context.fillRect(0, keyboardNoteHeight, size.width, size.height - keyboardNoteHeight);
  context.fillStyle = cssColor("--pianoroll-key-white", "#ffffff");
  for (let pitch = firstPitch; pitch <= lastPitch; pitch += 1) {
    if (isPianorollBlackKey(pitch)) continue;
    const { top, bottom } = pianorollWhiteKeyBounds(pitch, layout);
    context.fillRect(0, top, size.width, bottom - top);
  }
  context.strokeStyle = cssColor("--pianoroll-key-border", "#dfe1e6");
  context.lineWidth = 1;
  context.beginPath();
  for (let pitch = firstPitch; pitch <= lastPitch; pitch += 1) {
    if (isPianorollBlackKey(pitch)) continue;
    const { top } = pianorollWhiteKeyBounds(pitch, layout);
    context.moveTo(0, Math.round(top) + 0.5);
    context.lineTo(size.width, Math.round(top) + 0.5);
  }
  context.stroke();
  context.fillStyle = cssColor("--pianoroll-key-black", "#172b4d");
  for (let pitch = firstPitch; pitch <= lastPitch; pitch += 1) {
    if (!isPianorollBlackKey(pitch)) continue;
    const { top, height } = pianorollPitchBounds(pitch, layout);
    context.fillRect(0, top, blackKeyWidth, height);
  }
  context.fillStyle = cssColor("--pianoroll-key-label", "#6b778c");
  context.font = "700 11px system-ui, sans-serif";
  context.textAlign = "right";
  context.textBaseline = "middle";
  for (let pitch = firstPitch; pitch <= lastPitch; pitch += 1) {
    const label = pianorollOctaveLabel(pitch);
    if (label) context.fillText(label, size.width - 4, pianorollPitchCenterY(pitch, layout));
  }
}

function drawPitchAutomationGrid(context, layout) {
  const { width, noteHeight, automationHeight } = layout;
  const top = noteHeight;
  context.fillStyle = cssColor("--pianoroll-automation-background", "#f4f5f7");
  context.fillRect(0, top, width, automationHeight);
  context.strokeStyle = cssColor("--pianoroll-grid-line", "#ebecf0");
  context.lineWidth = 1;
  context.beginPath();
  const center = Math.round(top + automationHeight / 2) + 0.5;
  context.moveTo(0, center);
  context.lineTo(width, center);
  context.stroke();
  context.fillStyle = cssColor("--neutral-60", "#6b778c");
  context.font = "10px system-ui, sans-serif";
  context.textBaseline = "middle";
  context.fillText("PITCH", 7, center);
}

function drawPitchAutomation(context, path, start, duration, track, layout, opacity) {
  const { payload, timelineWidth, scrollLeft, noteHeight, automationHeight } = layout;
  const xAt = (time) => time / payload.durationSeconds * timelineWidth - scrollLeft;
  const points = [];
  for (let offset = 0; offset < path.points.length; offset += 2) {
    const elapsed = Math.min(duration, Math.max(0, path.points[offset]));
    const bend = path.points[offset + 1];
    if (points.length && points.at(-1).time === elapsed) points[points.length - 1] = { time: elapsed, bend };
    else points.push({ time: elapsed, bend });
  }
  if (!points.length || points[0].time !== 0) points.unshift({ time: 0, bend: 0 });
  if (points.at(-1).time !== duration) points.push({ time: duration, bend: points.at(-1).bend });
  const maximumBend = Math.max(1, ...points.map((point) => Math.abs(point.bend)));
  const yAt = (bend) => noteHeight + automationHeight / 2 - bend / maximumBend * (automationHeight * 0.36);
  context.beginPath();
  context.moveTo(xAt(start + points[0].time), yAt(points[0].bend));
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index];
    const previous = points[index - 1];
    context.lineTo(xAt(start + point.time), yAt(previous.bend));
    context.lineTo(xAt(start + point.time), yAt(point.bend));
  }
  context.strokeStyle = getTrackColor(track.index, layout.trackCount, opacity);
  context.lineWidth = 2;
  context.stroke();
}

// 角丸設定が有効な時だけroundRect()でノートを描く。角丸の半径はノートの短辺の
// 半分以下に制限し、短いノートでも形状が崩れないようにする。縁取り設定が有効なら
// 同じ外形に少し濃いトラック色を重ねる。古いCanvas実装ではfillRect()/strokeRect()
// の矩形描画へフォールバックする。
function drawPianorollNote(context, x, y, width, height, outlineColor) {
  const canDrawRoundedNote = state.hasRoundedPianorollNotes && typeof context.roundRect === "function";
  if (!canDrawRoundedNote) {
    context.fillRect(x, y, width, height);
    if (state.hasOutlinedPianorollNotes) {
      context.strokeStyle = outlineColor;
      context.lineWidth = 1;
      context.strokeRect(x, y, width, height);
    }
    return;
  }
  const radius = Math.min(3, width / 2, height / 2);
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
  context.fill();
  if (state.hasOutlinedPianorollNotes) {
    context.strokeStyle = outlineColor;
    context.lineWidth = 1;
    context.stroke();
  }
}

function drawPianorollTrack(context, track, layout, mutedIndices) {
  const {
    payload, offsets, width, timelineWidth, scrollLeft, trackCount,
  } = layout;
  const isMuted = mutedIndices.has(track.index);
  context.fillStyle = getTrackColor(track.index, trackCount, isMuted ? 0.18 : 0.72);
  const outlineColor = getTrackOutlineColor(track.index, trackCount, isMuted ? 0.18 : 0.92);
  const pitchOpacity = isMuted ? 0.18 : 0.9;
  const pitchPaths = new Map((track.pitchPaths || []).map((path) => [path.noteIndex, path]));
  let noteIndex = 0;
  for (let offset = 0; offset < track.notes.length; offset += payload.stride) {
    const start = track.notes[offset + offsets.start];
    const duration = track.notes[offset + offsets.duration];
    const note = track.notes[offset + offsets.note];
    const pitchPath = pitchPaths.get(noteIndex);
    noteIndex += 1;
    const x = start / payload.durationSeconds * timelineWidth - scrollLeft;
    const noteWidth = Math.max(1, duration / payload.durationSeconds * timelineWidth);
    if (x > width || x + noteWidth < 0) continue;
    // 音高1段ぶんの高さを超えると、低い表示領域で隣接音高の矩形が重なる。
    // 通常は1.5pxを確保しつつ、想定外に高さが縮んだ場合も段間隔の80%以内に
    // 抑えて、異なるノートを別行として判別できるようにする。
    const pitchBounds = pianorollPitchBounds(note, layout);
    const noteHeight = Math.min(
      Math.max(1.5, pitchBounds.height * 0.72),
      pitchBounds.height * 0.8,
    );
    drawPianorollNote(
      context, x, pitchBounds.top, noteWidth, noteHeight, outlineColor,
    );
    if (pitchPath) drawPitchAutomation(context, pitchPath, start, duration, track, layout, pitchOpacity);
  }
}

function redrawPianorollStatic() {
  const payload = state.pianoroll;
  const size = state.pianorollSize;
  if (!size || size.width <= 0 || size.height <= 0) return;
  const canvas = $("#pianoroll-canvas");
  const context = canvas.getContext("2d");
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!payload) {
    clearPianorollKeyboard();
    updatePianorollPlayhead();
    updatePianorollLoopRegion();
    return;
  }
  const scrollLeft = $("#pianoroll-scroll").scrollLeft;
  const timelineWidth = state.pianorollTimelineWidth || size.width;
  context.setTransform(size.scaleX, 0, 0, size.scaleY, 0, 0);
  const hasPitchAutomation = payload.tracks.some((track) => track.pitchPaths?.length);
  const automationHeight = hasPitchAutomation ? Math.min(72, Math.max(48, size.height * 0.18)) : 0;
  const noteHeight = size.height - automationHeight;
  drawPianorollGrid(context, size.width, noteHeight, timelineWidth, scrollLeft);
  if (hasPitchAutomation) drawPitchAutomationGrid(context, { width: size.width, noteHeight, automationHeight });
  if (payload.noteCount > 0 && payload.durationSeconds > 0) {
    const mutedIndices = state.highlightedTrackIndex === null
      ? new Set((state.session?.tracks || [])
        .filter((track) => track.volumePercent === 0).map((track) => track.index))
      : new Set(payload.tracks
        .filter((track) => track.index !== state.highlightedTrackIndex)
        .map((track) => track.index));
    const layout = {
      payload, offsets: pianorollFieldOffsets(payload), width: size.width, height: noteHeight,
      timelineWidth, scrollLeft,
      minNote: payload.minNote, maxNote: payload.maxNote,
      noteSpan: payload.maxNote - payload.minNote + 3,
      trackCount: payload.tracks.length, noteHeight, automationHeight,
    };
    for (const track of payload.tracks) drawPianorollTrack(context, track, layout, mutedIndices);
    drawPianorollKeyboard(layout);
  } else {
    clearPianorollKeyboard();
  }
  updatePianorollPlayhead();
  updatePianorollLoopRegion();
}

// 再生中に毎フレーム動くのは2px幅のDOMレイヤーだけに限定する。transformは
// レイアウトを再計算せずcompositorで処理でき、静的Canvasの再転送も発生しない。
function updatePianorollPlayhead() {
  const playhead = $("#pianoroll-playhead");
  const payload = state.pianoroll;
  const size = state.pianorollSize;
  const timelineWidth = state.pianorollTimelineWidth;
  if (!payload || !size || !timelineWidth || payload.durationSeconds <= 0) {
    playhead.hidden = true;
    updatePianorollAria();
    return;
  }
  const seconds = Math.min(payload.durationSeconds, getDisplayPlaybackSeconds());
  const progress = seconds / payload.durationSeconds;
  const x = progress * timelineWidth - $("#pianoroll-scroll").scrollLeft;
  const maximumX = Math.max(0, size.width - 2);
  playhead.hidden = x < 0 || x > size.width;
  playhead.style.transform = `translate3d(${Math.min(maximumX, Math.max(0, x))}px, 0, 0)`;
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
  if (!state.pianorollTimelineWidth) return;
  const scrollArea = $("#pianoroll-scroll");
  const canvasWidth = state.pianorollTimelineWidth;
  const viewportHalf = scrollArea.clientWidth / 2;
  const progress = Math.min(1, sourceGlobalSeconds() / state.pianoroll.durationSeconds);
  const playheadX = progress * canvasWidth;
  if (playheadX <= viewportHalf) return;
  const maximumScroll = Math.max(0, canvasWidth - scrollArea.clientWidth);
  const target = Math.min(maximumScroll, Math.max(0, playheadX - viewportHalf));
  if (Math.abs(scrollArea.scrollLeft - target) < 0.5) return;
  state.pianorollAutoScrollTarget = target;
  scrollArea.scrollLeft = target;
}

function schedulePianorollViewportRedraw() {
  if (state.pianorollScrollFrameId !== null) return;
  state.pianorollScrollFrameId = requestAnimationFrame(() => {
    state.pianorollScrollFrameId = null;
    redrawPianorollStatic();
  });
}

function handlePianorollScroll() {
  schedulePianorollViewportRedraw();
  const target = state.pianorollAutoScrollTarget;
  if (target !== null && Math.abs($("#pianoroll-scroll").scrollLeft - target) < 1) {
    state.pianorollAutoScrollTarget = null;
    return;
  }
  setPianorollAutoFollow(false);
}

function setPianorollZoom(zoom, shouldPreserveCenter = true) {
  const timeline = $("#pianoroll-timeline");
  const scrollArea = $("#pianoroll-scroll");
  const previousWidth = timeline.getBoundingClientRect().width;
  const centerRatio = previousWidth > 0
    ? (scrollArea.scrollLeft + scrollArea.clientWidth / 2) / previousWidth
    : 0;
  state.pianorollZoom = zoom;
  timeline.style.inlineSize = `${zoom * 100}%`;
  updatePianorollZoomControls();
  requestAnimationFrame(() => {
    const nextWidth = timeline.getBoundingClientRect().width;
    state.pianorollTimelineWidth = nextWidth;
    scrollArea.scrollLeft = shouldPreserveCenter
      ? centerRatio * nextWidth - scrollArea.clientWidth / 2
      : 0;
    redrawPianorollStatic();
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

function resizePianorollViewport() {
  const viewport = $("#pianoroll-viewport");
  const width = $("#pianoroll-scroll").clientWidth;
  if (width > 0) viewport.style.inlineSize = `${width}px`;
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
  state.pianorollTimelineWidth = $("#pianoroll-timeline").getBoundingClientRect().width;
  redrawPianorollStatic();
}

function resizePianorollKeyboard(entry) {
  const keyboard = $("#pianoroll-keyboard");
  if (keyboard.hidden) {
    state.pianorollKeyboardSize = null;
    return;
  }
  const rect = keyboard.getBoundingClientRect();
  const deviceBox = entry?.devicePixelContentBoxSize?.[0];
  const pixelWidth = deviceBox?.inlineSize || Math.round(rect.width * window.devicePixelRatio);
  const pixelHeight = deviceBox?.blockSize || Math.round(rect.height * window.devicePixelRatio);
  if (pixelWidth <= 0 || pixelHeight <= 0) return;
  keyboard.width = pixelWidth;
  keyboard.height = pixelHeight;
  state.pianorollKeyboardSize = {
    width: rect.width, height: rect.height, pixelWidth, pixelHeight,
    scaleX: pixelWidth / rect.width, scaleY: pixelHeight / rect.height,
  };
  redrawPianorollStatic();
}

function refreshPianorollLayout() {
  resizePianorollViewport();
  resizePianorollKeyboard();
  resizePianoroll();
}

function pianorollSecondsAt(clientX) {
  if (!state.pianoroll || !state.pianorollTimelineWidth) return null;
  const canvas = $("#pianoroll-canvas");
  const scrollArea = $("#pianoroll-scroll");
  const rect = canvas.getBoundingClientRect();
  const x = scrollArea.scrollLeft + clientX - rect.left;
  const ratio = Math.min(1, Math.max(0, x / state.pianorollTimelineWidth));
  return ratio * state.pianoroll.durationSeconds;
}

function seekPianorollAt(clientX) {
  if (!state.session?.hasRender) return;
  const seconds = pianorollSecondsAt(clientX);
  if (seconds !== null) seekPlaybackTo(seconds);
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
    const isShiftSeek = event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight");
    const stepSeconds = isShiftSeek ? SHIFT_PLAYBACK_SEEK_SECONDS : PLAYBACK_SEEK_SECONDS;
    const keySteps = {
      ArrowLeft: -stepSeconds,
      ArrowRight: stepSeconds,
      PageDown: -10,
      PageUp: 10,
    };
    if (keySteps[event.key] !== undefined) {
      target = sourceGlobalSeconds() + keySteps[event.key];
    }
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = getTimelineDuration();
  }
  if (target === null) return;
  event.preventDefault();
  seekPlaybackTo(target);
}

// ピアノロール上にマウス/トラックパッドがある間、縦方向のホイール操作で
// 再生位置を送り・戻しできるようにする。横方向の操作（Shift+ホイールや
// トラックパッドの横スワイプ）は#pianoroll-scrollの既存の横スクロール
// （タイムラインのパン）に任せ、そちらだけ確実に動いている場合は
// preventDefault()しない — |deltaX| > |deltaY|ならこの関数は何もせず
// 通常のブラウザのスクロール処理へ委ねる。
// 符号は既存のPageUp(+10秒=前方)/PageDown(-10秒=後方)の向きに合わせる
// （WheelEventの仕様上、上スクロール=deltaY負、下スクロール=deltaY正）。
// deltaYをそのまま秒数に使うとマウスホイール1クリック分（多くの環境で
// ±100前後）がPLAYBACK_SEEK_SECONDS（1秒）とだいたい釣り合うが、
// トラックパッドの連続した小さなdeltaYでもなめらかにスクラブできるよう
// 固定ステップではなく比例スケールにする。
function handlePianorollWheel(event) {
  if (!state.pianoroll) return;
  // Cmdキーを押しながらのホイール操作はズーム専用にする（シークとは排他）。
  if (event.metaKey) {
    event.preventDefault();
    state.pianorollZoomWheelDelta -= event.deltaY;
    while (Math.abs(state.pianorollZoomWheelDelta) >= PIANOROLL_ZOOM_WHEEL_THRESHOLD) {
      const direction = state.pianorollZoomWheelDelta > 0 ? 1 : -1;
      changePianorollZoom(direction);
      state.pianorollZoomWheelDelta -= direction * PIANOROLL_ZOOM_WHEEL_THRESHOLD;
    }
    return;
  }
  if (!state.session?.hasRender) return;
  if (!activePlayer().getAttribute("src")) return;
  if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
  event.preventDefault();
  seekPlaybackBy(-(event.deltaY / 100) * PLAYBACK_SEEK_SECONDS);
}

function setupPianoroll() {
  const canvas = $("#pianoroll-canvas");
  const keyboard = $("#pianoroll-keyboard");
  const scrollArea = $("#pianoroll-scroll");
  resizePianorollViewport();
  const resizeObserver = new ResizeObserver(([entry]) => resizePianoroll(entry));
  const keyboardResizeObserver = new ResizeObserver(([entry]) => resizePianorollKeyboard(entry));
  const viewportObserver = new ResizeObserver(resizePianorollViewport);
  const supportsDevicePixels = typeof ResizeObserverEntry !== "undefined"
    && "devicePixelContentBoxSize" in ResizeObserverEntry.prototype;
  resizeObserver.observe(canvas, supportsDevicePixels ? { box: "device-pixel-content-box" } : {});
  keyboardResizeObserver.observe(keyboard, supportsDevicePixels ? { box: "device-pixel-content-box" } : {});
  viewportObserver.observe(scrollArea);
  canvas.addEventListener("pointerdown", (event) => {
    if (!state.pianoroll || event.pointerType === "touch" || event.button !== 0) return;
    state.pianorollPointerId = event.pointerId;
    state.pianorollPointerStartClientX = event.clientX;
    state.pianorollPointerAnchorSeconds = pianorollSecondsAt(event.clientX);
    state.isPianorollLoopDragging = false;
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (event.pointerId !== state.pianorollPointerId) return;
    const anchor = state.pianorollPointerAnchorSeconds;
    const current = pianorollSecondsAt(event.clientX);
    if (anchor === null || current === null) return;
    const distance = Math.abs(event.clientX - state.pianorollPointerStartClientX);
    if (!state.isPianorollLoopDragging && distance < LOOP_DRAG_THRESHOLD_PX) return;
    state.isPianorollLoopDragging = true;
    setPianorollLoopRange(Math.min(anchor, current), Math.max(anchor, current), { enable: true });
  });
  // クリック（ドラッグではない）時の挙動: 有効なループ範囲内をクリックした場合は
  // 区間を維持したまま再生位置だけをクリック箇所へ移動し、範囲外をクリックした場合は
  // ループ選択自体を解除してから再生位置を移動する。
  const finishPointerInteraction = (event) => {
    if (event.pointerId !== state.pianorollPointerId) return;
    const wasDragging = state.isPianorollLoopDragging;
    if (!wasDragging && event.type === "pointerup") {
      const range = activePianorollLoopRange();
      const seconds = pianorollSecondsAt(event.clientX);
      if (range && seconds !== null && (seconds < range.start || seconds >= range.end)) {
        clearPianorollLoop();
      }
      seekPianorollAt(event.clientX);
    }
    if (wasDragging) {
      const range = activePianorollLoopRange();
      if (range) seekPlaybackTo(range.start);
    }
    state.pianorollPointerId = null;
    state.pianorollPointerStartClientX = null;
    state.pianorollPointerAnchorSeconds = null;
    state.isPianorollLoopDragging = false;
  };
  canvas.addEventListener("pointerup", finishPointerInteraction);
  canvas.addEventListener("pointercancel", finishPointerInteraction);
  canvas.addEventListener("wheel", handlePianorollWheel, { passive: false });
  document.addEventListener("keydown", handleSeekKeydown);
  $("#pianoroll-zoom-out").addEventListener("click", () => changePianorollZoom(-1));
  $("#pianoroll-zoom-in").addEventListener("click", () => changePianorollZoom(1));
  $("#pianoroll-rounded-notes").addEventListener("change", (event) => {
    state.hasRoundedPianorollNotes = event.target.checked;
    redrawPianorollStatic();
    saveRoundedPianorollNotes();
  });
  $("#pianoroll-outlined-notes").addEventListener("change", (event) => {
    state.hasOutlinedPianorollNotes = event.target.checked;
    redrawPianorollStatic();
    saveOutlinedPianorollNotes();
  });
  $("#pianoroll-show-keyboard").addEventListener("change", (event) => {
    state.isPianorollKeyboardVisible = event.target.checked;
    updatePianorollKeyboardVisibility();
    refreshPianorollLayout();
    savePianorollKeyboardVisibility();
  });
  for (const eventName of ["wheel", "pointerdown", "touchstart"]) {
    scrollArea.addEventListener(eventName, () => setPianorollAutoFollow(false), { passive: true });
  }
  scrollArea.addEventListener("scroll", handlePianorollScroll, { passive: true });
  // A/Bどちらの要素がloadedmetadataを発火してもupdatePianorollInteraction()自体は
  // activePlayer()（今のactivePlayerId）から読み直すだけなので、両方に張って構わない。
  for (const player of allPlayers()) {
    player.addEventListener("loadedmetadata", updatePianorollInteraction);
  }
  // appThemeが"system"のときだけOSの変更を反映する。resolveTheme()はappTheme
  // が明示指定（light/dark）ならOSの値を無視してその指定を返すため、ここでは
  // 分岐せず常にapplyThemeSetting()を呼べば両方のケースが正しく処理される。
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyThemeSetting);
  updatePianorollZoomControls();
  updatePianorollLoopRegion();
}

function updateSectionsReadiness() {
  const ready = !!(state.session && state.session.tracks.length > 0);
  $("#tracks-card").classList.toggle("ready", ready);
  $("#audition-card").classList.toggle("ready", ready);
  $("#output-card").classList.toggle("ready", ready);
  document.querySelectorAll('input[name="render-mode"]')
    .forEach((control) => { control.disabled = !ready; });
  $("#download-button").disabled = !(state.session && state.session.hasDownload);
  $("#download-wav-button").disabled = !(state.session && state.session.hasDownload);
  $("#download-filename").disabled = !(state.session && state.session.hasDownload);
  $("#save-project-button").disabled = !ready;
  document.querySelectorAll(".transform-controls button, .transform-controls input")
    .forEach((control) => { control.disabled = !ready; });
  // バリエーション一括生成・トラックごと出力はどちらもensure_render()を経由しない
  // ため事前の試聴レンダリングは不要（hasRenderではなくhasDownload = MIDIアップ
  // ロード済みかどうかで活性化する）。
  $("#variation-button").disabled = !(state.session && state.session.hasDownload);
  $("#track-export-button").disabled = !(state.session && state.session.hasDownload);
  $("#track-export-group-chip-field").hidden = !isChipHardwareFormat();
  updateEnsemblePresetControls();
  updatePianorollLoopRegion();
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
  state.activeSource = { kind: "full", timelineStartSeconds: 0, timelineEndSeconds: null };
  state.fullRenderTask = null;
  clearRenderStale();
  setPianorollAutoFollow(false);
  stopPlaybackTimeAnimation();
  updatePlaybackTime();
  updatePlaybackControls();
  updatePianorollInteraction();
  updatePianorollPlayhead();
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

function restoreProjectEnsemblePreset(uiState) {
  const preset = uiState?.ensemblePresetDefinition;
  if (!preset || typeof preset !== "object") return;
  const index = state.ensemblePresets.findIndex((item) => item.id === preset.id);
  if (index < 0) state.ensemblePresets.push(preset);
  else state.ensemblePresets[index] = preset;
  renderEnsemblePresetOptions();
}

async function refreshFromSession(payload, { restoreConvertedOptions = false, uiState = null } = {}) {
  cancelAutoRender();
  // 新しいMIDI/音源の読み込みでトラック構成自体が変わりうるため、
  // 古いセッションのトラック番号を指したソロ試聴状態は持ち越さない。
  state.soloTrackIndex = null;
  state.soloVolumeSnapshot = null;
  state.highlightedTrackIndex = null;
  restoreProjectEnsemblePreset(uiState);
  state.ensemblePresetId = state.ensemblePresets.some(
    (preset) => preset.id === uiState?.ensemblePreset,
  ) ? uiState.ensemblePreset : null;
  state.trackRoles = uiState?.trackRoles && typeof uiState.trackRoles === "object"
    ? { ...uiState.trackRoles }
    : {};
  clearPianorollLoop();
  state.session = payload;
  const savedSnapshot = uiState?.ensemblePresetSnapshot;
  state.ensemblePresetSnapshot = state.ensemblePresetId && savedSnapshot
    ? {
      assignments: { ...savedSnapshot.assignments },
      sources: { ...savedSnapshot.sources },
    }
    : (state.ensemblePresetId ? captureEnsemblePresetSnapshot() : null);
  if (["fast", "quality"].includes(payload.renderMode)) {
    state.renderMode = payload.renderMode;
    const modeInput = $(`#render-mode-${state.renderMode}`);
    if (modeInput) modeInput.checked = true;
  }
  resetPianorollZoom();
  await renderTrackList();
  updateSectionsReadiness();
  renderConvertPanel(
    payload.source || null,
    restoreConvertedOptions ? payload.source?.convertedOptions || {} : null,
  );
  renderTransformFields(payload);
  renderDownloadFilenameField(payload);
  updateEnsemblePresetControls();
  // hasGameSoundfontの変化を#soundfont-helpへ即座に反映する（新規fetchはしない）。
  if (state.soundfontPayload) {
    renderSoundfontOptions(state.soundfontPayload);
  }
  await loadPianoroll();
  if (uiState?.loop) {
    setPianorollLoopRange(uiState.loop.start, uiState.loop.end, {
      enable: uiState.loop.enabled,
    });
  }
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
  if (state.downloadFilenamePatchPromise) return state.downloadFilenamePatchPromise;
  const input = $("#download-filename");
  const patchPromise = (async () => {
    try {
      const response = await apiFetch("/api/session/filename", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: input.value }),
      });
      state.session = await response.json();
      return true;
    } catch (error) {
      showStatus(error.message, "error");
      return false;
    }
  })();
  state.downloadFilenamePatchPromise = patchPromise;
  const didSucceed = await patchPromise;
  if (state.downloadFilenamePatchPromise === patchPromise) {
    state.downloadFilenamePatchPromise = null;
  }
  return didSucceed;
}

async function flushPendingDownloadFilename() {
  if (state.downloadFilenamePatchTimer !== null) {
    clearTimeout(state.downloadFilenamePatchTimer);
    state.downloadFilenamePatchTimer = null;
    if (!(await flushDownloadFilename())) return false;
  }
  if (state.downloadFilenamePatchPromise && !(await state.downloadFilenamePatchPromise)) {
    return false;
  }
  return state.downloadFilenamePatchTimer === null;
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
    showUploadCard();
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
    showUploadCard();
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

function renderConvertPanel(source, restoredConvertedOptions = null) {
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
  const previousSongIndex = restoredConvertedOptions
    ? String(restoredConvertedOptions.songIndex ?? "")
    : songSelect.value;

  // 同じ理由で、秒数・PALタイミング・chipNoise等の各オプションの値も
  // 再構築前に読み取って保持しておく（フィールド名 -> 値）。これが無いと
  // 変換のたびにチェックボックスが field.default（常に false）へ戻ってしまい、
  // 「PALタイミングを使用」「原曲の音源（実機）を初期選択」のチェックが
  // 変換後に外れて見える。
  const previousFieldValues = {};
  for (const entry of state.convertFields) {
    previousFieldValues[entry.name] = readConvertFieldValue(entry);
  }
  if (restoredConvertedOptions) {
    Object.assign(previousFieldValues, restoredConvertedOptions);
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
    hideUploadCard();
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
async function runSwap(renderId, canCommit = () => true, nextSource = null) {
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
    const resolvedNextSource = nextSource || {
      kind: "full", timelineStartSeconds: 0, timelineEndSeconds: null,
    };
    const currentGlobalSeconds = () => sourceGlobalSeconds(active, state.activeSource);

    next.src = nextUrl;
    next.load();
    await waitForLoadOutcome(next);
    if (generation !== state.swapGeneration || !canCommit()) {
      next.pause();
      next.removeAttribute("src");
      next.load();
      return activePlayer();
    }

    const seekNextTo = (globalSeconds) => {
      const localSeconds = sourceLocalSeconds(globalSeconds, resolvedNextSource);
      const nextDuration = next.duration;
      next.currentTime = Number.isFinite(nextDuration)
        ? Math.min(nextDuration, localSeconds)
        : localSeconds;
    };
    // 一度目のシーク: play()をactiveに近い位置から開始させ、無関係な区間をバッファ
    // させないため。waitForLoadOutcome()のネットワーク待ちの間もactiveは進み続けて
    // いるので、この時点のratioはあくまで暫定値。
    seekNextTo(currentGlobalSeconds());

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
        seekNextTo(currentGlobalSeconds());
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
    state.activeSource = resolvedNextSource;
    updatePlaybackControls();
    // rAFループの次フレームを待たず、乗り換えた直後の位置を即座に反映する。
    // 1フレーム（最大16ms程度）とはいえ待つ理由が無く、ここで描き直しておけば
    // 上のシーク調整と合わせてバーの見た目上のズレが実質ゼロになる。
    updatePianorollPlayhead();
    return activePlayer();
  } finally {
    state.isSwapping = false;
  }
}

// 現在鳴っている（かもしれない）試聴音声を止めずに、renderIdのWAVへ乗り換える。
// 再生中なら短時間の等パワークロスフェードで、停止中（または初回読み込み）なら
// 位置を保ったまま即座に差し替える。戻り値は乗り換え完了後のactivePlayer()。
function crossfadeToRender(renderId, canCommit, nextSource = null) {
  const task = swapQueue.then(
    () => runSwap(renderId, canCommit, nextSource),
    () => runSwap(renderId, canCommit, nextSource),
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
    const player = await requestRenderGeneration(generation, { preferPreview: true });
    if (player && isCurrentRenderGeneration(generation)) return player;
  }
  return null;
}

async function playPreparedPlayer(player) {
  const loopRange = activePianorollLoopRange();
  if (
    loopRange
    && (
      sourceGlobalSeconds(player) < loopRange.start
      || sourceGlobalSeconds(player) >= loopRange.end
    )
  ) {
    player.currentTime = sourceLocalSeconds(loopRange.start, state.activeSource);
  }
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

function getTimelineDuration() {
  return state.pianoroll?.durationSeconds || getPlaybackDuration();
}

// カウンタとピアノロールの再生位置バーが表示すべき秒数。activePlayer()は
// トラック設定等の変更後もsrcを維持したまま鳴り続ける（markRenderStale()参照）ため、
// 単純に現在のactivePlayer()から読むだけでよい。
function getDisplayPlaybackSeconds() {
  return sourceGlobalSeconds();
}

function getDisplayPlaybackDuration() {
  return getTimelineDuration();
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
// カウンタの0.001秒表示と同じ滑らかさにするため、再生中はrAFで毎フレーム
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
  enforcePianorollLoop();
  updatePianorollPlayhead();
  updatePlaybackTime();
  followPianorollPlayback();
}

function enforcePianorollLoop() {
  const range = activePianorollLoopRange();
  const player = activePlayer();
  if (!range || player.paused || !player.getAttribute("src")) return false;
  const current = sourceGlobalSeconds(player);
  if (current >= range.start && current < range.end - 0.02) return false;
  if (!sourceContainsTimelineSeconds(range.start)) return false;
  player.currentTime = sourceLocalSeconds(range.start, state.activeSource);
  return true;
}

function seekPlaybackTo(seconds) {
  const player = activePlayer();
  if (!state.session?.hasRender || !player.getAttribute("src")) return;
  const target = Math.min(getTimelineDuration(), Math.max(0, seconds));
  if (!sourceContainsTimelineSeconds(target)) {
    state.fullRenderTask?.then((fullPlayer) => {
      if (fullPlayer && sourceContainsTimelineSeconds(target)) seekPlaybackTo(target);
    }).catch(() => {});
    return;
  }
  player.currentTime = sourceLocalSeconds(target, state.activeSource);
  if (target <= 0.05) {
    if (!player.paused) setPianorollAutoFollow(true);
    scrollPianorollToStart();
  }
  updatePlaybackProgress();
}

function seekPlaybackBy(seconds) {
  seekPlaybackTo(sourceGlobalSeconds() + seconds);
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
    () => seekPlaybackBy(-SHIFT_PLAYBACK_SEEK_SECONDS),
  );
  $("#playback-forward").addEventListener(
    "click",
    () => seekPlaybackBy(SHIFT_PLAYBACK_SEEK_SECONDS),
  );
  $("#playback-start").addEventListener("click", () => {
    seekPlaybackTo(activePianorollLoopRange()?.start ?? 0);
  });
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
    if (sourceGlobalSeconds(event.target) <= 0.05) {
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
  onActivePlayerEvent("ended", async (event) => {
    const loopRange = activePianorollLoopRange();
    if (state.activeSource.kind === "segment" && state.fullRenderTask) {
      try {
        const fullPlayer = await state.fullRenderTask;
        if (fullPlayer && fullPlayer === activePlayer()) {
          if (loopRange) {
            seekPlaybackTo(loopRange.start);
          }
          await playPreparedPlayer(fullPlayer);
          return;
        }
      } catch (_error) {
        // 全尺レンダー失敗時は通常の終了処理へ進む。
      }
    }
    if (loopRange) {
      event.target.currentTime = sourceLocalSeconds(loopRange.start, state.activeSource);
      await playPreparedPlayer(event.target);
      return;
    }
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

async function downloadFrom(path, fallbackName, busyMessage, options = {}) {
  if (busyMessage) setBusy(true, busyMessage);
  try {
    const response = await apiFetch(path, options);
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
    return true;
  } catch (error) {
    showStatus(error.message, "error");
    return false;
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

function projectUiStatePayload() {
  const payload = { renderMode: selectedRenderMode() };
  const loopRange = selectedPianorollLoopRange();
  if (loopRange) {
    payload.loop = {
      start: loopRange.start,
      end: loopRange.end,
      enabled: state.isLoopEnabled,
    };
  }
  if (state.ensemblePresetId) {
    payload.ensemblePreset = state.ensemblePresetId;
    payload.ensemblePresetDefinition = activeEnsemblePreset();
    payload.trackRoles = { ...state.trackRoles };
    if (state.ensemblePresetSnapshot) {
      payload.ensemblePresetSnapshot = {
        assignments: { ...state.ensemblePresetSnapshot.assignments },
        sources: { ...state.ensemblePresetSnapshot.sources },
      };
    }
  }
  return payload;
}

async function handleSaveProject() {
  if (!state.session || state.session.tracks.length === 0) return;
  setBusy(true, "プロジェクトを保存中…");
  try {
    const didSaveTracks = await flushPendingTrackSettings();
    const didSaveTransform = await flushPendingTransform();
    const didSaveFilename = await flushPendingDownloadFilename();
    if (!didSaveTracks || !didSaveTransform || !didSaveFilename) return;
    const stem = state.session.downloadStem || state.session.filename || "miditrack";
    const didDownload = await downloadFrom(
      "/api/project/export",
      `${stem}.miditrack`,
      "",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(projectUiStatePayload()),
      },
    );
    if (didDownload) showStatus("プロジェクトを保存しました。", "success");
  } catch (error) {
    showStatus(error.message, "error");
  } finally {
    setBusy(false);
  }
}

function canReplaceCurrentSession() {
  return !!(state.session && (state.session.tracks.length > 0 || state.session.source));
}

async function handleOpenProject(file) {
  if (!file) return;
  if (canReplaceCurrentSession() && !window.confirm("現在のセッションを置き換えます。保存していない変更は失われます。続けますか？")) {
    $("#project-input").value = "";
    return;
  }
  setBusy(true, "プロジェクトを読み込み中…");
  const formData = new FormData();
  formData.append("project", file);
  try {
    const response = await apiFetch("/api/project/import", { method: "POST", body: formData });
    await applyProjectImportPayload(await response.json());
  } catch (error) {
    showStatus(error.message, "error");
  } finally {
    $("#project-input").value = "";
    setBusy(false);
  }
}

async function applyProjectImportPayload(payload) {
  const renderMode = payload.uiState?.renderMode;
  if (["fast", "quality"].includes(renderMode)) {
    state.renderMode = renderMode;
    const modeInput = $(`#render-mode-${renderMode}`);
    if (modeInput) modeInput.checked = true;
  }
  resetPlayer();
  await refreshFromSession(payload.session, {
    restoreConvertedOptions: true,
    uiState: payload.uiState,
  });
  await loadSoundfonts();
  if (payload.warnings?.length) showStatus(payload.warnings.join(" "));
  else showStatus("プロジェクトを読み込みました。", "success");
  showUploadCard();
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

// トラックごとの音声をZIPで出力する（POST /api/tracks/export）。
// ensure_render()を経由しないので事前の試聴レンダリングは不要
// （handleVariations()と同じ設計判断、#variation-buttonと同じ
// hasDownload基準で活性化する）。
async function handleTrackExport() {
  const groupChipTracks = $("#track-export-group-chip").checked;
  setBusy(true, "トラックごとのWAVを生成中…");
  try {
    const response = await apiFetch("/api/tracks/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupChipTracks }),
    });
    const payload = await response.json();
    showStatus(`${payload.items.length}件のトラックWAVを生成しました。ダウンロードします…`);
    const stem = (state.session && (state.session.downloadStem || state.session.filename)) || "miditrack";
    const filename = `${stem}_tracks.zip`;
    await downloadFrom("/api/download/tracks", filename);
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
    showUploadCard();
    showStatus("リセットしました。");
  } catch (error) {
    showStatus(error.message, "error");
  } finally {
    setBusy(false);
  }
}

// 全画面（DAW風）レイアウトを反映する。レイアウト自体はapp.cssの
// display:contents/grid配置に任せる。ピアノロールのcanvasはResizeObserverが
// 高さの変化を検知して自動的に再描画するため、ここでの追加処理は不要。
function setFullscreenLayout(isFullscreen, { shouldPersist = false } = {}) {
  document.body.classList.toggle("is-fullscreen", isFullscreen);
  $("#fullscreen-toggle").setAttribute("aria-pressed", String(isFullscreen));
  state.displayMode = isFullscreen ? "fullscreen" : "normal";
  if (isFullscreen) moveUploadCardToDialog();
  else moveUploadCardToShell();
  if (shouldPersist) saveDisplayMode();
}

// 表示モードの切替操作を登録する。
function setupFullscreenLayout() {
  const toggle = $("#fullscreen-toggle");
  // ネイティブアプリでは全画面（DAW）レイアウトに固定し、切り替え手段
  // （ボタン・Escapeキー）自体を提供しない。レイアウト本体はinit()の最初に
  // 適用済みで、loadPreferences()はその状態を再確認するだけにする。
  if (isNativeApp) {
    toggle.hidden = true;
    return;
  }
  toggle.addEventListener("click", () => {
    setFullscreenLayout(!document.body.classList.contains("is-fullscreen"), { shouldPersist: true });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    // 開いているネイティブダイアログにはEscの標準の閉じる動作を優先する。
    if (document.querySelector("dialog[open]")) return;
    // isPlaybackShortcutBlocked()はBUTTON/AUDIOも除外するが、それはSpaceが
    // それらの既定動作（クリック等）と衝突するため。EscapeにBUTTON上での
    // 既定動作は無く、キーボードでフォーカスしたボタン（例えばこの全画面
    // ボタン自身）からもEscapeで表示モードを切り替えられるべきなので、ここ
    // ではテキスト編集系（input/textarea/select/contenteditable）だけを
    // 素通しの対象にする。
    const target = event.target;
    if (target?.isContentEditable) return;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName)) return;
    setFullscreenLayout(!document.body.classList.contains("is-fullscreen"), { shouldPersist: true });
  });
}

// 通常表示用のアップロードカードを全画面時のネイティブダイアログへ移動する。
function moveUploadCardToDialog() {
  const card = $("#upload-card");
  const dialog = $("#open-dialog");
  dialog.append(card);
  card.open = true;
  $("#upload-card > summary").setAttribute("aria-disabled", "true");
}

// 全画面を終了したらアップロードカードを通常のメイン領域へ戻す。
function moveUploadCardToShell() {
  const card = $("#upload-card");
  const dialog = $("#open-dialog");
  if (dialog.open) dialog.close();
  $(".app-shell").prepend(card);
  card.open = true;
  $("#upload-card > summary").removeAttribute("aria-disabled");
}

// ファイル選択ダイアログを閉じる。未表示時に呼んでも副作用を持たない。
function closeOpenDialog() {
  const dialog = $("#open-dialog");
  if (dialog.open) dialog.close();
}

// 表示モードに応じて、操作後にファイル選択UIを表示する。
function showUploadCard() {
  // 全画面では選択中の内容（変換オプションを含む）を確認できるよう、
  // 開いているファイル選択ダイアログをそのまま維持する。
  if (!document.body.classList.contains("is-fullscreen")) $("#upload-card").open = true;
}

// Finder/Dockから音源を開いた直後は、変換オプションや曲選択をすぐ操作できる
// ようにネイティブ版のファイル選択モーダルを開く。MIDI単体とプロジェクト復元は
// 変換操作を必要としないため、この関数を呼ばない。
function showNativeSourceSelectionDialog() {
  showUploadCard();
  if (!document.body.classList.contains("is-fullscreen")) return;
  const dialog = $("#open-dialog");
  $("#upload-card").open = true;
  if (!dialog.open) dialog.showModal();
  dialog.focus({ preventScroll: true });
}

// 表示モードに応じて、変換完了後にファイル選択UIを閉じる。
function hideUploadCard() {
  if (document.body.classList.contains("is-fullscreen")) closeOpenDialog();
  else $("#upload-card").open = false;
}

// ダイアログ内容の外側を押したかを判定する。closedby非対応Safari用の補助。
function isDialogBackdropClick(dialog, event) {
  const rect = dialog.getBoundingClientRect();
  return event.clientY < rect.top || event.clientY > rect.bottom
    || event.clientX < rect.left || event.clientX > rect.right;
}

// ヘッダの「開く」からファイル選択ダイアログを開閉する。
function setupOpenDialog() {
  const dialog = $("#open-dialog");
  const uploadSummary = $("#upload-card > summary");
  $("#open-dialog-button").addEventListener("click", () => {
    $("#upload-card").open = true;
    dialog.showModal();
    dialog.focus({ preventScroll: true });
  });
  $("#open-dialog-close").addEventListener("click", () => dialog.close());

  // ダイアログを閉じるとブラウザが開くボタンへフォーカスを戻す。その状態で
  // スペースキーを押すとボタンの既定動作（再クリック）が優先されてしまうため、
  // closeイベント後にblur()してグローバルの再生トグルへスペースを届くようにする。
  dialog.addEventListener("close", () => {
    $("#open-dialog-button").blur();
  });

  // 通常表示ではdetailsの開閉を維持し、全画面のモーダル内だけは常時展開する。
  uploadSummary.addEventListener("click", (event) => {
    if (document.body.classList.contains("is-fullscreen")) event.preventDefault();
  });

  // closedby="any"が未対応のSafariでも背景クリックで閉じられるようにする。
  if (!("closedBy" in HTMLDialogElement.prototype)) {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog && isDialogBackdropClick(dialog, event)) dialog.close();
    });
  }
}

// 歯車ボタンから開く表示設定ダイアログの開閉と各コントロールを配線する。
// ダイアログ内の設定はすべて即時反映・即時保存で、OK/キャンセルの下書き
// 状態は持たない（元からあった3つのピアノロールのチェックボックスと同じ挙動）。
function setupSettingsDialog() {
  const dialog = $("#settings-dialog");
  $("#settings-open").addEventListener("click", () => dialog.showModal());
  $("#settings-close").addEventListener("click", () => dialog.close());
  // ダイアログを閉じると歯車ボタンへフォーカスが戻るため、
  // closeイベント後にblur()してスペースキーで再生トグルを使えるようにする。
  dialog.addEventListener("close", () => {
    $("#settings-open").blur();
  });

  $("#app-theme").addEventListener("change", (event) => {
    state.appTheme = event.target.value;
    applyThemeSetting();
    savePreferenceFields({ appTheme: state.appTheme });
  });

  $("#pianoroll-height").addEventListener("change", (event) => {
    state.pianorollHeight = event.target.value;
    applyPianorollHeight();
    savePreferenceFields({ pianorollHeight: state.pianorollHeight });
  });

  $("#pianoroll-show-grid").addEventListener("change", (event) => {
    state.isPianorollGridVisible = event.target.checked;
    redrawPianorollStatic();
    savePreferenceFields({ showPianorollGrid: state.isPianorollGridVisible });
  });

  $("#pianoroll-grid-divisions").addEventListener("change", (event) => {
    state.pianorollGridDivisions = Number(event.target.value);
    redrawPianorollStatic();
    savePreferenceFields({ pianorollGridDivisions: state.pianorollGridDivisions });
  });

  $("#track-color-palette").addEventListener("change", (event) => {
    state.trackColorPalette = event.target.value;
    redrawPianorollStatic();
    renderTrackList();
    savePreferenceFields({ trackColorPalette: state.trackColorPalette });
  });

  // 色ピッカーはinputイベント（ドラッグ中）でプレビューだけを更新し、
  // changeイベント（確定時）でPATCHを送る。ドラッグ中に毎回保存しないため。
  setupPianorollColorField({
    colorInputId: "#pianoroll-background-color",
    resetButtonId: "#pianoroll-background-reset",
    stateKey: "pianorollBackgroundColor",
    preferenceField: "pianorollBackgroundColor",
  });
  setupPianorollColorField({
    colorInputId: "#pianoroll-grid-color",
    resetButtonId: "#pianoroll-grid-reset",
    stateKey: "pianorollGridColor",
    preferenceField: "pianorollGridColor",
  });
}

function setupPianorollColorField({ colorInputId, resetButtonId, stateKey, preferenceField }) {
  const colorInput = $(colorInputId);
  colorInput.addEventListener("input", (event) => {
    state[stateKey] = event.target.value;
    applyPianorollColors();
  });
  colorInput.addEventListener("change", (event) => {
    state[stateKey] = event.target.value;
    savePreferenceFields({ [preferenceField]: state[stateKey] });
  });
  $(resetButtonId).addEventListener("click", () => {
    state[stateKey] = null;
    applyPianorollColors();
    syncSettingsDialogControls();
    savePreferenceFields({ [preferenceField]: null });
  });
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

// DOM更新後の描画機会を確実に1回挟む。最初のコールバックは描画前に実行される
// ため、二重requestAnimationFrameにして次のフレームまで待つ。
function waitForNextPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

// ネイティブアプリ（miditrack.app）のスプラッシュオーバーレイは、WKWebViewの
// ページ読み込み完了（didFinish）ではなく、この関数の通知を待ってから消える。
// PromiseやDOM更新の完了だけでは画面への描画は保証されないため、WebKitが更新済み
// UIを少なくとも1フレーム描画する機会を得てからpostMessageする。
async function notifyNativeAppReady() {
  const messageHandler = window.webkit?.messageHandlers?.miditrackReady;
  if (!isNativeApp || !messageHandler) return;
  await waitForNextPaint();
  messageHandler.postMessage({});
}

if (isNativeApp) {
  window.__miditrackOpenLocalFiles = (paths) => {
    nativeLocalOpenPromise = nativeLocalOpenPromise.then(() => openNativeLocalFiles(paths));
    return nativeLocalOpenPromise;
  };
}

async function openNativeLocalFiles(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return;
  if (canReplaceCurrentSession() && !window.confirm("現在のセッションを置き換えます。保存していない変更は失われます。続けますか？")) {
    return;
  }
  setBusy(true, "読み込み中…");
  try {
    const response = await apiFetch("/api/open-local", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths }),
    });
    const payload = await response.json();
    if (payload.kind === "project") {
      await applyProjectImportPayload(payload);
    } else if (payload.kind === "midi") {
      resetPlayer();
      await refreshFromSession(payload.session);
      showUploadCard();
      showStatus("MIDIを読み込みました。", "success");
    } else if (payload.kind === "source") {
      resetPlayer();
      await refreshFromSession(payload.session);
      showNativeSourceSelectionDialog();
      showStatus("音源を読み込みました。曲とオプションを選んで変換してください。", "success");
    } else {
      throw new Error("ローカルファイル読み込みの応答が不正です");
    }
  } catch (error) {
    showStatus(error.message, "error");
  } finally {
    setBusy(false);
  }
}

async function init() {
  // ネイティブ版は設定APIの応答を待たずに全画面レイアウトを完成させる。
  // Swift側のatDocumentStart注入と組み合わせ、通常レイアウトが一瞬見える
  // 起動時の切り替わりを防ぐ。
  if (isNativeApp) setFullscreenLayout(true);
  if (isTokenRequired && !token) {
    showStatus("起動トークンがありません。ターミナルに表示されたURLから開いてください。", "error");
    await notifyNativeAppReady();
    return;
  }
  setupDropZone();
  setupOpenDialog();
  setupFullscreenLayout();
  setupEnsemblePresets();
  setupTrackSorting();
  setupSettingsDialog();
  $("#hide-empty-tracks").addEventListener("change", (event) => {
    state.hideEmptyTracks = event.target.checked;
    renderTrackList();
    savePreferenceFields({ hideEmptyTracks: state.hideEmptyTracks });
  });
  setupPianoroll();
  setupPlaybackControls();
  setupPlaybackShortcut();
  $("#reset-button").addEventListener("click", handleReset);
  $("#open-project-button").addEventListener("click", () => $("#project-input").click());
  $("#project-input").addEventListener("change", (event) => handleOpenProject(event.target.files?.[0]));
  $("#save-project-button").addEventListener("click", handleSaveProject);
  document.querySelectorAll('input[name="render-mode"]')
    .forEach((control) => control.addEventListener("change", handleRenderModeChange));
  $("#download-button").addEventListener("click", handleDownload);
  $("#download-wav-button").addEventListener("click", handleDownloadWav);
  $("#download-filename").addEventListener("input", onDownloadFilenameChange);
  $("#variation-button").addEventListener("click", handleVariations);
  $("#track-export-button").addEventListener("click", handleTrackExport);
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
  } finally {
    await notifyNativeAppReady();
  }
}

init();
