import { VGMData } from './types';
/** C140の曲内で実際に使われたPCMを、GMドラムノート対応のSF2へ書き出す。 */
export declare function writeC140SoundFont(vgmData: VGMData, sampleNotes: ReadonlyMap<string, number>, outputPath: string): number;
