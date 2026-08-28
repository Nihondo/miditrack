"use strict";
// midi2wav.ts
// --wav オプション用: 書き出した .mid をプロジェクトルートの midi2wav.sh
// (fluidsynth ラッパー) に渡して WAV をレンダリングする。
//
// このリポジトリのパスは "Chill & Relax GAME MUSIC" のようにスペースと '&' を
// 含むため、シェル経由の実行 (exec()/execSync()、あるいは spawn(..., { shell: true }))
// は確実に壊れる。spawnSync(bin, args, { shell: false }) (Node のデフォルト) で
// argv 配列を直接渡し、シェルの介在を避ける。nsf2midi/spc2midi の
// src/midi2wav.cpp (posix_spawn 版) と同じ設計・同じ解決順。
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.renderWav = renderWav;
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
function isExecutableFile(candidate) {
    try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return fs.statSync(candidate).isFile();
    }
    catch {
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
function resolveMidi2WavBin() {
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
function renderWav(midPath, wavPath, soundfontPath) {
    const bin = resolveMidi2WavBin();
    if (!bin) {
        return false;
    }
    const args = ['-f'];
    if (soundfontPath) {
        args.push('-s', soundfontPath);
    }
    args.push('-o', wavPath, midPath);
    const result = (0, child_process_1.spawnSync)(bin, args, { stdio: 'inherit' });
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
