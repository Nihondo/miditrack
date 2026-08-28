import { VGMData } from './types';
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
export declare function renderDacWav(data: VGMData, totalSamples: number, outPath: string): {
    framesWritten: number;
    voicesFound: number;
};
