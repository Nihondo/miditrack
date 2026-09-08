// MidiConverterから抽出した、生PCM/ADPCM波形のROM範囲解析。すべて`VGMData`（解析済み
// VGMファイル。conversion中に変化しない）だけを読み、MidiConverterの可変な
// per-instanceレジスタ状態には触れない純粋関数として、MidiConverterはdispatch・
// ライフサイクル・exportに専念する。

import { VGMData, VGMDataBlock } from './types';
import { CLOCK_MASK } from './vgm-chip-metadata';

const MAX_PCM_ANALYSIS_SAMPLES = 65536;
// C219 (NA-1/NA-2)の4音声ごとの外部bankレジスタ。c140ROMAddress()参照。
const C140_C219_EXTERNAL_BANK_REGISTERS = [0x1F7, 0x1F1, 0x1F3, 0x1F5] as const;

export interface PCMTrackEvent {
  type: 'start' | 'stop';
  sampleTime: number;
  isLoop?: boolean;
  /** PCMアドレス空間における排他的な再生終了位置。 */
  endAddressExclusive?: number;
  /** ループ時の再開位置。`isLoop`がtrueの場合だけ出力する。 */
  loopAddress?: number;
  /** チップまたはVGM streamから解決できた再生予定長。loop時は省略する。 */
  durationSamples?: number;
  /** VGM data bankから要求されるエンコード済みbyte数。 */
  dataLengthBytes?: number;
}

/** PCMトリガーが参照するVGM 0x67 data bank内の範囲。 */
export interface PCMDataBlockMetadata {
  bankType: number;
  bankInstance: number;
  blockId: number;
  /** stream bankでは連結先頭offset、ROMでは物理サンプルアドレス。 */
  bankOffset: number;
  /** block内の先頭offset。 */
  blockOffset: number;
  /** stream開始時に要求されたbyte数。長さを解決できない場合は省略する。 */
  lengthBytes?: number;
  /** ROM data blockが示すチップ側ROM全体のsize。 */
  romSizeBytes?: number;
  /** このROM data blockがロードするチップ側の先頭アドレス。 */
  romStartAddress?: number;
  /** ROM data block内の実データ部のsize。8 byteのROM headerは含まない。 */
  romDataLengthBytes?: number;
}

/** sidecarへ出力する、形式が確定した生PCMの基本波形特徴量。 */
export interface PCMAnalysisMetadata {
  format: 'signed-8bit-pcm' | 'yamaha-adpcm-b' | 'signed-12bit-be-pcm' | 'c140-compressed-pcm' | 'c219-mulaw';
  sourceByteLength: number;
  analyzedSampleCount: number;
  isDownsampled?: true;
  peak: number;
  mean: number;
  rms: number;
  zeroCrossingCount: number;
}

/** 波形特徴量だけから決める、楽器種別を主張しない説明的な音色ラベル。 */
export interface PCMTimbreMetadata {
  name: 'quiet' | 'tonal' | 'noise-like';
  confidence: number;
}

/** sidecarのdata block参照から実ROM blockを探す。 */
export function romDataBlockForMetadata(
  vgmData: VGMData,
  dataBlock: PCMDataBlockMetadata
): VGMDataBlock | undefined {
  return (vgmData.dataBlocks ?? []).find(candidate =>
    candidate.type === dataBlock.bankType
    && (candidate.instance ?? 0) === dataBlock.bankInstance
    && candidate.blockId === dataBlock.blockId
  );
}

/** ROM block内のbyteアドレス範囲を安全に取得する。 */
export function romBytesForRange(
  vgmData: VGMData,
  dataBlock: PCMDataBlockMetadata,
  endAddress: number
): Buffer | undefined {
  if (endAddress <= dataBlock.bankOffset || dataBlock.romStartAddress === undefined) return undefined;
  const block = romDataBlockForMetadata(vgmData, dataBlock);
  if (block === undefined) return undefined;
  const sourceByteLength = endAddress - dataBlock.bankOffset;
  if (dataBlock.blockOffset + sourceByteLength > block.payload.length - 8) return undefined;
  return block.payload.subarray(8 + dataBlock.blockOffset, 8 + dataBlock.blockOffset + sourceByteLength);
}

/** C140のwordアドレス範囲を、ROM block上のbig-endian byte列へ変換する。 */
export function c140ROMBytesForRange(
  vgmData: VGMData,
  dataBlock: PCMDataBlockMetadata,
  endAddress: number
): Buffer | undefined {
  if (endAddress <= dataBlock.bankOffset) return undefined;
  const block = romDataBlockForMetadata(vgmData, dataBlock);
  if (block === undefined) return undefined;
  const sourceByteLength = (endAddress - dataBlock.bankOffset) * 2;
  const sourceStart = 8 + dataBlock.blockOffset * 2;
  if (sourceStart + sourceByteLength > block.payload.length) return undefined;
  return block.payload.subarray(sourceStart, sourceStart + sourceByteLength);
}

/** 数値sample列を均等に間引き、正規化された波形特徴量へ変換する。 */
export function analyzePCMValues(
  format: PCMAnalysisMetadata['format'],
  sourceByteLength: number,
  sampleCount: number,
  maximumAmplitude: number,
  sampleAt: (index: number) => number
): PCMAnalysisMetadata | undefined {
  if (sampleCount === 0) return undefined;
  const analyzedSampleCount = Math.min(sampleCount, MAX_PCM_ANALYSIS_SAMPLES);
  let peak = 0; let sum = 0; let sumSquares = 0; let zeroCrossingCount = 0; let previousSign = 0;
  for (let index = 0; index < analyzedSampleCount; index++) {
    const sourceIndex = Math.floor((index * sampleCount) / analyzedSampleCount);
    const sample = sampleAt(sourceIndex);
    peak = Math.max(peak, Math.abs(sample)); sum += sample; sumSquares += sample * sample;
    const sign = Math.sign(sample);
    if (sign !== 0 && previousSign !== 0 && sign !== previousSign) zeroCrossingCount++;
    if (sign !== 0) previousSign = sign;
  }
  const normalize = (value: number) => Math.round((value / maximumAmplitude) * 1_000_000) / 1_000_000;
  return {
    format, sourceByteLength, analyzedSampleCount,
    ...(sampleCount > analyzedSampleCount ? { isDownsampled: true as const } : {}),
    peak: normalize(peak), mean: normalize(sum / analyzedSampleCount),
    rms: normalize(Math.sqrt(sumSquares / analyzedSampleCount)), zeroCrossingCount,
  };
}

/** 波形統計から、楽器種別を断定しない説明的な音色ラベルを作る。 */
export function pcmTimbreForAnalysis(analysis: PCMAnalysisMetadata): PCMTimbreMetadata {
  const crossingRate = analysis.zeroCrossingCount / Math.max(1, analysis.analyzedSampleCount - 1);
  const name = analysis.peak < 0.04 ? 'quiet' : crossingRate > 0.25 ? 'noise-like' : 'tonal';
  const confidence = Math.round(Math.min(1, 0.5 + Math.min(analysis.analyzedSampleCount, 4096) / 8192) * 100) / 100;
  return { name, confidence };
}

/** 8-bit符号PCMを均等に間引き、振幅とゼロクロスの基本特徴量を返す。 */
export function analyzeSigned8BitPCM(samples: Buffer, sign = 1): PCMAnalysisMetadata | undefined {
  return analyzePCMValues(
    'signed-8bit-pcm',
    samples.length,
    samples.length,
    128,
    index => sign * (samples[index] - 0x80)
  );
}

/** 単一ROM blockに完全に収まる符号付き8-bit PCMの基本波形特徴量を返す。 */
export function signed8BitPCMAnalysisForROMRange(
  vgmData: VGMData,
  dataBlock: PCMDataBlockMetadata,
  endAddress: number,
  sign = 1
): PCMAnalysisMetadata | undefined {
  const samples = romBytesForRange(vgmData, dataBlock, endAddress);
  return samples === undefined ? undefined : analyzeSigned8BitPCM(samples, sign);
}

/** C219 μ-law tableをMAMEと同じ手順で作り、復号後の波形を解析する。 */
export function c219MuLawAnalysisForROMRange(
  vgmData: VGMData,
  dataBlock: PCMDataBlockMetadata,
  endAddress: number,
  sign: number
): PCMAnalysisMetadata | undefined {
  const samples = romBytesForRange(vgmData, dataBlock, endAddress);
  if (samples === undefined) return undefined;
  return analyzePCMValues('c219-mulaw', samples.length, samples.length, 2048, index => {
    const value = samples[index];
    let magnitude = 0;
    for (let level = 0; level < 128; level++) {
      if (level < 16) magnitude += 1;
      else if (level < 24) magnitude += 2;
      else if (level < 48) magnitude += 4;
      else if (level < 100) magnitude += 8;
      else magnitude += 16;
      if (level === (value & 0x7F)) break;
    }
    const decoded = (value & 0x80) === 0 ? magnitude : (~magnitude & 0xFFE0);
    return sign * (decoded >> 5);
  });
}

/** C140のbig-endian 12-bit word PCMを解析する。 */
export function c14012BitPCMAnalysisForROMRange(
  vgmData: VGMData,
  dataBlock: PCMDataBlockMetadata,
  endAddress: number
): PCMAnalysisMetadata | undefined {
  const samples = c140ROMBytesForRange(vgmData, dataBlock, endAddress);
  if (samples === undefined) return undefined;
  const sampleCount = Math.floor(samples.length / 2);
  return analyzePCMValues(
    'signed-12bit-be-pcm', samples.length, sampleCount, 2048,
    index => samples.readInt16BE(index * 2) >> 4
  );
}

/** C140圧縮PCMのMAME互換テーブル復号を解析に用いる。 */
export function c140CompressedPCMAnalysisForROMRange(
  vgmData: VGMData,
  dataBlock: PCMDataBlockMetadata,
  endAddress: number
): PCMAnalysisMetadata | undefined {
  const samples = c140ROMBytesForRange(vgmData, dataBlock, endAddress);
  if (samples === undefined) return undefined;
  const sampleCount = Math.floor(samples.length / 2);
  return analyzePCMValues('c140-compressed-pcm', samples.length, sampleCount, 2048, index => {
    const byte = samples[index * 2];
    const signed = byte < 0x80 ? byte : byte - 0x100;
    const shift = signed & 7;
    const magnitude = Math.abs(signed >> 3) & 31;
    let decoded = ((0x80 << shift) & 0xFF00) + (magnitude << (shift === 0 ? 4 : shift + 3));
    if (signed < 0) decoded = -decoded;
    return decoded >> 4;
  });
}

/** YM2608 ADPCM-BをYamahaの予測式で復号し、全nibbleを解析する。 */
export function ym2608ADPCMBAnalysis(
  vgmData: VGMData,
  dataBlock: PCMDataBlockMetadata | undefined,
  sourceByteLength: number | undefined
): PCMAnalysisMetadata | undefined {
  if (dataBlock === undefined || sourceByteLength === undefined) return undefined;
  const endAddress = dataBlock.bankOffset + sourceByteLength;
  const encoded = romBytesForRange(vgmData, dataBlock, endAddress);
  if (encoded === undefined || encoded.length === 0) return undefined;
  const values: number[] = [];
  let accumulator = 0;
  let step = 127;
  for (const byte of encoded) {
    for (const nibble of [byte >> 4, byte & 0x0F]) {
      const magnitude = (2 * (nibble & 7) + 1) * step / 8;
      accumulator = Math.max(-32768, Math.min(32767, accumulator + ((nibble & 8) === 0 ? magnitude : -magnitude)));
      step = Math.max(127, Math.min(24576, Math.floor(step * [57, 57, 57, 57, 77, 102, 128, 153][nibble & 7] / 64)));
      values.push(accumulator);
    }
  }
  // The chip suppresses the final three buffered nibbles at EOS.
  return analyzePCMValues('yamaha-adpcm-b', encoded.length, Math.max(0, values.length - 3), 32768, index => values[index]);
}

/** 単一ROM blockへ完全に収まるSegaPCMの生8-bit PCMを解析する。 */
export function segaPCMAnalysisForTrack(
  vgmData: VGMData,
  dataBlock: PCMDataBlockMetadata | undefined,
  events: PCMTrackEvent[]
): PCMAnalysisMetadata | undefined {
  if (dataBlock?.bankType !== 0x80 || dataBlock.romStartAddress === undefined) return undefined;
  const startEvent = events.find(event => event.type === 'start' && event.endAddressExclusive !== undefined);
  if (startEvent?.endAddressExclusive === undefined) return undefined;
  return signed8BitPCMAnalysisForROMRange(vgmData, dataBlock, startEvent.endAddressExclusive);
}

/** C140/C219の確認済みPCMモードを、物理ROM範囲から解析する。 */
export function c140PCMAnalysisForVoice(
  vgmData: VGMData,
  dataBlock: PCMDataBlockMetadata | undefined,
  startAddress: number,
  endAddress: number,
  mode: number
): PCMAnalysisMetadata | undefined {
  if (startAddress !== dataBlock?.bankOffset) return undefined;
  if (vgmData.header.c140Type === 2) {
    // C219 bit 1 remains unverified and bit 2 is LFSR noise. Bit 0 selects
    // μ-law, and bit 6 inverses the decoded sample sign.
    if ((mode & 0x06) !== 0) return undefined;
    const sign = (mode & 0x40) === 0 ? 1 : -1;
    return (mode & 0x01) === 0
      ? signed8BitPCMAnalysisForROMRange(vgmData, dataBlock, endAddress, sign)
      : c219MuLawAnalysisForROMRange(vgmData, dataBlock, endAddress, sign);
  }
  return (mode & 0x08) === 0
    ? c14012BitPCMAnalysisForROMRange(vgmData, dataBlock, endAddress)
    : c140CompressedPCMAnalysisForROMRange(vgmData, dataBlock, endAddress);
}

/** SegaPCM interface registerのROMバンク設定を物理アドレスの先頭へ変換する。 */
export function segaPCMBankBaseAddress(vgmData: VGMData, control: number): number {
  const interfaceRegister = vgmData.header.segaPCMInterface >>> 0;
  const bankShift = interfaceRegister & 0xFF;
  const interfaceBankMask = (interfaceRegister >>> 16) & 0xFF;
  // libvgm defaults a zero mask to the conventional 315-5218 $70 mask.
  const requestedMask = interfaceBankMask === 0 ? 0x70 : interfaceBankMask;
  if (bankShift > 20) return 0;
  const addressableBankMask = Math.floor(0x1FFFFF / 2 ** bankShift);
  const bankMask = requestedMask & addressableBankMask;
  return (control & bankMask) * 2 ** bankShift;
}

/** SegaPCMの非ループ範囲を、VGMの44.1 kHz時間単位へ概算変換する。 */
export function segaPCMDurationSamples(
  vgmData: VGMData,
  address: number,
  endPage: number,
  frequency: number,
  sampleRate: number
): number | undefined {
  if (frequency === 0) return undefined;
  const clock = vgmData.header.segaPCMClock & CLOCK_MASK;
  if (clock === 0) return undefined;
  // The 315-5218's 16 voices advance their 16.8 address at clock / 128.
  const endAddress = ((endPage + 1) & 0xFF) << 16;
  const distance = (endAddress - address + 0x1000000) & 0xFFFFFF;
  if (distance === 0) return undefined;
  return Math.round((distance * sampleRate * 128) / (frequency * clock));
}

/** C140/C219の非ループ範囲を、VGMの44.1 kHz時間単位へ概算変換する。 */
export function c140DurationSamples(
  vgmData: VGMData,
  start: number,
  end: number,
  frequency: number,
  sampleRate: number
): number | undefined {
  if (end <= start || frequency === 0) return undefined;
  const inputClock = vgmData.header.c140Clock & CLOCK_MASK;
  if (inputClock === 0) return undefined;
  // VGMPlay's C140 core treats a MHz-class header clock as the input clock and
  // derives its base rate by /384; already-low clocks are an explicit base rate.
  const baseRate = inputClock >= 1000000 ? Math.floor(inputClock / 384) : inputClock;
  if (baseRate === 0) return undefined;
  const addressLength = (end - start) * (vgmData.header.c140Type === 2 ? 2 : 1);
  return Math.round((addressLength * sampleRate * 65536) / (frequency * baseRate * 2));
}

/** C140系レジスタのバンク・開始位置を、VGM ROM blockで使う物理ROMアドレスへ変換する。 */
export function c140ROMAddress(
  vgmData: VGMData,
  c140Registers: Uint8Array,
  channel: number,
  bank: number,
  address: number
): number {
  const logicalAddress = (bank << 16) | address;
  if (vgmData.header.c140Type === 1) {
    // System 21 はC140の論理アドレスをROM配線に合わせて並べ替える。
    return (logicalAddress & 0x7FFFF) | ((logicalAddress & 0x300000) >> 1);
  }
  if (vgmData.header.c140Type === 2) {
    // C219 (NA-1/NA-2): 音声アドレスはword単位、4音声ごとの外部bankは128 KiB単位。
    const externalBank = c140Registers[C140_C219_EXTERNAL_BANK_REGISTERS[Math.floor(channel / 4)]] & 0x03;
    return (externalBank << 17) + (bank << 16) + (address << 1);
  }
  return logicalAddress;
}
