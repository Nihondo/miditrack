import { VGMData } from './types';
/**
 * ループ展開済みVGMからSN76489/HuC6280のノイズだけを16bit/44.1kHz/stereo WAVへ描画する。
 *
 * これは完全なチップエミュレーションではなくLFSR専用レンダラである。トーン、FM、
 * HuC6280のDDA/PCM、マスター/チャンネルバランスは描画しない。ノイズが実際に発音する
 * 区間が無い場合は出力ファイルを作らず、voicesFound=0を返す。
 */
export declare function renderNoiseWav(data: VGMData, totalSamples: number, outPath: string): {
    framesWritten: number;
    voicesFound: number;
};
