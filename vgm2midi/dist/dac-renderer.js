"use strict";
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
exports.renderDacWav = renderDacWav;
const fs = __importStar(require("fs"));
const wav_writer_1 = require("./wav-writer");
/**
 * ループ展開済みVGMからYM2612 DAC(PCM)チャンネルだけを16bit/44.1kHz/stereo WAVへ描画する。
 *
 * ストリームモード（`$E0`シーク + `$80-8F`ストリーム書き込み）はPCMデータバンク
 * （`VGMData.ym2612PcmData`、データブロックtype 0x00の連結、`VGMParser`が保持）から
 * 実際のバイト値を読み、直接モード（YM2612レジスタ`$2A`への直書き）はコマンド自体が
 * 運ぶバイト値をそのまま使う。どちらも8bit符号なしPCM（0x80中心）を符号付き16bitへ
 * 拡張するサンプル&ホールドDACとして扱う。
 *
 * 実機ではレジスタ`$2A`書き込みはDACラッチを`$2B` bit7（DAC有効ビット）に関係なく
 * 常に更新し、そのビットはチャンネル6の出力をDACラッチかFM合成かのどちらから
 * 取るかだけを選ぶ。そのため`pcmPointer`/`currentLevel`の更新は無効時も続けるが、
 * `renderInterval()`が実際に音として混ぜるのは`dacEnabled`のときだけにする —
 * 無効化中に再度有効化すると、新しい`$2A`書き込みが無くても直前のラッチ値が
 * そのまま鳴り直す実機の挙動を再現する。
 *
 * これは完全なチップエミュレータではない。PCMバイトが取得できない区間
 * （バンク未捕捉、シーク先がバンク範囲外）は無音のまま進む。DACの発音が
 * 一度も実際に混ざらなかった場合は出力ファイルを作らず、voicesFound=0を返す。
 */
function renderDacWav(data, totalSamples, outPath) {
    if (!Number.isSafeInteger(totalSamples) || totalSamples < 0) {
        throw new Error(`totalSamples must be a non-negative safe integer: ${totalSamples}`);
    }
    fs.rmSync(outPath, { force: true });
    const output = new Int16Array(totalSamples * wav_writer_1.WAV_CHANNELS);
    const bank = data.ym2612PcmData;
    const voices = new Set();
    let cursor = 0;
    let dacEnabled = false;
    let pcmPointer;
    let currentLevel;
    const renderInterval = (requestedSamples) => {
        const sampleCount = Math.max(0, Math.min(requestedSamples, totalSamples - cursor));
        if (sampleCount === 0)
            return;
        const pcmSample = dacEnabled && currentLevel !== undefined
            ? (0, wav_writer_1.clampInt16)((currentLevel - 128) * 256)
            : 0;
        for (let offset = 0; offset < sampleCount; offset++) {
            const frameIndex = (cursor + offset) * wav_writer_1.WAV_CHANNELS;
            output[frameIndex] = pcmSample;
            output[frameIndex + 1] = pcmSample;
        }
        cursor += sampleCount;
    };
    for (const command of data.commands) {
        if (cursor >= totalSamples)
            break;
        if (command.type === 'wait') {
            renderInterval(command.samples ?? 0);
        }
        else if (command.type === 'pcm_seek' && command.chip === 'YM2612') {
            pcmPointer = command.address;
        }
        else if (command.type === 'pcm_write' && command.chip === 'YM2612') {
            if (bank !== undefined && pcmPointer !== undefined && pcmPointer < bank.length) {
                currentLevel = bank[pcmPointer];
                pcmPointer += 1;
                if (dacEnabled)
                    voices.add('ym2612dac_stream');
            }
            renderInterval(command.samples ?? 0);
        }
        else if (command.type === 'chip_write' && command.chip === 'YM2612'
            && command.port === 0 && command.register === 0x2B && command.data !== undefined) {
            dacEnabled = (command.data & 0x80) !== 0;
        }
        else if (command.type === 'chip_write' && command.chip === 'YM2612'
            && command.port === 0 && command.register === 0x2A && command.data !== undefined) {
            currentLevel = command.data & 0xff;
            if (dacEnabled)
                voices.add('ym2612dac_direct');
        }
    }
    renderInterval(totalSamples - cursor);
    if (voices.size === 0) {
        return { framesWritten: 0, voicesFound: 0 };
    }
    (0, wav_writer_1.writeWaveFile)(outPath, output);
    return { framesWritten: totalSamples, voicesFound: voices.size };
}
