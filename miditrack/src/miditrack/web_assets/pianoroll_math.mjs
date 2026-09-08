/** ピアノロール描画で共有する状態非依存の座標・時刻計算。 */

const BLACK_PIANO_KEY_PITCH_CLASSES = new Set([1, 3, 6, 8, 10]);

/** 圧縮ノート配列のフィールド名から配列オフセットを作る。 */
export function pianorollFieldOffsets(payload) {
  return Object.fromEntries(payload.fields.map((field, index) => [field, index]));
}

/** 曲の再生秒数をアクセシブルな日本語表示へ整形する。 */
export function formatPianorollTime(seconds, t) {
  const safeSeconds = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = Math.floor(safeSeconds % 60);
  return minutes > 0
    ? t("{minutes}分{seconds}秒", { minutes, seconds: remainder })
    : t("{seconds}秒", { seconds: remainder });
}

/** 再生時計を秒以下3桁の表示部品へ整形する。 */
export function formatPlaybackClock(seconds) {
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

/** 音高行の上端をピアノロール座標へ変換する。 */
export function pianorollPitchY(pitch, layout) {
  return layout.height - ((pitch - layout.minNote + 1) / layout.noteSpan * layout.height);
}

/** ノートと鍵盤で共有する整数ピクセルの音高境界を返す。 */
export function pianorollPitchBounds(pitch, layout) {
  const top = Math.round(pianorollPitchY(pitch, layout));
  const bottom = Math.round(pianorollPitchY(pitch - 1, layout));
  return { top, bottom, height: Math.max(1, bottom - top) };
}

/** MIDI音高が黒鍵かを返す。 */
export function isPianorollBlackKey(pitch) {
  return BLACK_PIANO_KEY_PITCH_CLASSES.has((pitch % 12 + 12) % 12);
}

/** C音だけに表示するオクターブラベルを返す。 */
export function pianorollOctaveLabel(pitch) {
  return pitch % 12 === 0 ? `C${Math.floor(pitch / 12) - 1}` : "";
}

/** 音高行の垂直中心を返す。 */
export function pianorollPitchCenterY(pitch, layout) {
  const { top, height } = pianorollPitchBounds(pitch, layout);
  return top + height / 2;
}

/** 指定方向で隣接する白鍵の音高を返す。 */
export function adjacentPianorollWhitePitch(pitch, direction) {
  let adjacentPitch = pitch + direction;
  while (isPianorollBlackKey(adjacentPitch)) adjacentPitch += direction;
  return adjacentPitch;
}

/** 黒鍵の行と整合する白鍵の垂直境界を返す。 */
export function pianorollWhiteKeyBounds(pitch, layout) {
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
