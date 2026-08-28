// midi2wav.ts
// --wav オプション用: 書き出した .mid をプロジェクトルートの midi2wav.sh
// (fluidsynth ラッパー) に渡して WAV をレンダリングする。
//
// このリポジトリのパスは "Chill & Relax GAME MUSIC" のようにスペースと '&' を
// 含むため、シェル経由の実行 (exec()/execSync()、あるいは spawn(..., { shell: true }))
// は確実に壊れる。spawnSync(bin, args, { shell: false }) (Node のデフォルト) で
// argv 配列を直接渡し、シェルの介在を避ける。nsf2midi/spc2midi の
// src/midi2wav.cpp (posix_spawn 版) と同じ設計・同じ解決順。

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

function isExecutableFile(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

// midi2wav 実行体を解決する:
//   1. MIDI2WAV_BIN 環境変数 -- 設定されているのに実行できなければ致命的エラー
//      (フォールバックしない。tools/make_videos_web.py の REC2ASS_BIN と同じ方針)
//   2. このファイルの隣にあるリポジトリルートの midi2wav.sh
//      (ビルド後の __dirname は "<repo>/vgm2midi/dist" を指す)
//   3. PATH 上の "midi2wav" (Node の spawnSync がシェルを介さず自前で PATH を
//      解決するので、素のコマンド名をそのまま返す)
// 戻り値が null なら (1) が失敗したことを意味し、呼び出し側は変換を中止する。
function resolveMidi2WavBin(): string | null {
  const envBin = process.env.MIDI2WAV_BIN;
  if (envBin) {
    if (!isExecutableFile(envBin)) {
      console.error(`error: MIDI2WAV_BIN is set but not executable: ${envBin}`);
      return null;
    }
    return envBin;
  }

  const sibling = path.join(__dirname, '..', '..', 'midi2wav.sh');
  if (isExecutableFile(sibling)) {
    return sibling;
  }

  return 'midi2wav';
}

// midPath の MIDI ファイルを wavPath に WAV としてレンダリングする。
// soundfontPath が未指定 (または空) なら midi2wav.sh 自身のデフォルト
// SoundFont 解決に任せる。失敗時は stderr にエラーを出力して false を返す。
export function renderWav(midPath: string, wavPath: string, soundfontPath?: string): boolean {
  const bin = resolveMidi2WavBin();
  if (!bin) {
    return false;
  }

  const args: string[] = ['-f'];
  if (soundfontPath) {
    args.push('-s', soundfontPath);
  }
  args.push('-o', wavPath, midPath);

  const result = spawnSync(bin, args, { stdio: 'inherit' });

  if (result.error) {
    console.error(`error: failed to launch midi2wav (${bin}): ${result.error.message}`);
    return false;
  }
  if (result.status !== 0) {
    console.error(`error: midi2wav failed to render ${wavPath}`);
    return false;
  }

  return true;
}
