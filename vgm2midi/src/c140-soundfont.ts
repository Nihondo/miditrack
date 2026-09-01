import * as fs from 'fs';
import { VGMData, VGMDataBlock } from './types';

/** VGM 0x8D のC140 ROMから抽出する、SoundFont用の1サンプル。 */
interface C140Sample {
  id: string;
  midiNote: number;
  pcm: Int16Array;
  loopStart?: number;
  loopEnd?: number;
  sampleRate: number;
}

interface C140VoiceRegisters {
  bank: number;
  start: number;
  end: number;
  loop: number;
  frequency: number;
  mode: number;
}

const C140_ROM_DATA_TYPE = 0x8D;
const C140_SYSTEM2_TYPE = 0x00;
const C140_SYSTEM2_CLOCK_DIVIDER = 576;
const C140_SYSTEM2_FALLBACK_RATE = 49152000 / 2304;
const SF2_DRUM_BANK = 128;
const SF2_GENERATOR_INSTRUMENT = 41;
const SF2_GENERATOR_KEY_RANGE = 43;
const SF2_GENERATOR_SAMPLE_MODES = 54;
const SF2_GENERATOR_SAMPLE_ID = 53;

/** C140の曲内で実際に使われたPCMを、GMドラムノート対応のSF2へ書き出す。 */
export function writeC140SoundFont(
  vgmData: VGMData,
  sampleNotes: ReadonlyMap<string, number>,
  outputPath: string,
): number {
  if (vgmData.header.c140Clock <= 0 || sampleNotes.size === 0) return 0;
  const rom = buildC140Rom(vgmData.dataBlocks ?? []);
  const samples = collectC140Samples(vgmData, sampleNotes, rom);
  if (samples.length === 0) return 0;
  fs.writeFileSync(outputPath, buildSoundFont(samples));
  return samples.length;
}

function buildC140Rom(blocks: VGMDataBlock[]): Buffer {
  const romBlocks = blocks.filter(block => block.type === C140_ROM_DATA_TYPE && (block.instance ?? 0) === 0);
  let romSize = 0;
  for (const block of romBlocks) {
    if (block.payload.length >= 8) romSize = Math.max(romSize, block.payload.readUInt32LE(0));
  }
  if (romSize === 0 || romSize > 16 * 1024 * 1024) return Buffer.alloc(0);
  const rom = Buffer.alloc(romSize);
  for (const block of romBlocks) {
    if (block.payload.length < 8) continue;
    const start = block.payload.readUInt32LE(4);
    const data = block.payload.subarray(8);
    if (start >= rom.length) continue;
    data.copy(rom, start, 0, Math.min(data.length, rom.length - start));
  }
  return rom;
}

function collectC140Samples(
  vgmData: VGMData,
  sampleNotes: ReadonlyMap<string, number>,
  rom: Buffer,
): C140Sample[] {
  if (rom.length === 0 || vgmData.header.c140Type !== C140_SYSTEM2_TYPE) return [];
  const registers = new Uint8Array(0x200);
  const definitions = new Map<string, C140VoiceRegisters>();
  const active = new Array<boolean>(24).fill(false);
  for (const command of vgmData.commands) {
    if (command.type !== 'chip_write' || command.chip !== 'C140' || (command.instance ?? 0) !== 0) continue;
    if (command.register === undefined || command.data === undefined) continue;
    const register = command.register & 0x1FF;
    registers[register] = command.data;
    if (register >= 0x180 || (register & 0x0F) !== 0x05) continue;
    const channel = register >> 4;
    const isKeyOn = (command.data & 0x80) !== 0 || ((command.data & 0x40) !== 0 && active[channel]);
    active[channel] = isKeyOn;
    if (!isKeyOn) continue;
    const base = channel << 4;
    const bank = registers[base + 4];
    const start = (registers[base + 6] << 8) | registers[base + 7];
    const id = `${bank.toString(16).padStart(2, '0')}${start.toString(16).padStart(4, '0')}`;
    if (!sampleNotes.has(`c140_sample_${id}`) || definitions.has(id)) continue;
    definitions.set(id, {
      bank,
      start,
      end: (registers[base + 8] << 8) | registers[base + 9],
      loop: (registers[base + 10] << 8) | registers[base + 11],
      frequency: (registers[base + 2] << 8) | registers[base + 3],
      mode: command.data,
    });
  }
  const samples: C140Sample[] = [];
  for (const [id, definition] of definitions) {
    const midiNote = sampleNotes.get(`c140_sample_${id}`);
    if (midiNote === undefined) continue;
    const start = mapSystem2Address(definition.bank, definition.start);
    const end = mapSystem2Address(definition.bank, definition.end);
    if (end <= start || end > rom.length) continue;
    const sourcePcm = decodeSystem2Pcm(rom, start, end);
    const sourceRate = calculateC140SourceRate(vgmData.header.c140Clock, definition.frequency);
    const pcm = sourcePcm;
    if (pcm.length < 2) continue;
    const loop = mapSystem2Address(definition.bank, definition.loop);
    const hasLoop = (definition.mode & 0x10) !== 0 && loop > start && loop < end;
    samples.push({
      id,
      midiNote,
      pcm,
      ...(hasLoop ? {
        loopStart: loop - start,
        loopEnd: pcm.length,
      } : {}),
      sampleRate: Math.max(4000, Math.round(sourceRate)),
    });
  }
  return samples.sort((left, right) => left.midiNote - right.midiNote);
}

/** System 2基板の外部バンク回路に従い、C140のアドレスを1 MiB ROMへ畳み込む。 */
function mapSystem2Address(bank: number, address: number): number {
  const fullAddress = (bank << 16) | address;
  return ((fullAddress & 0x200000) >>> 2) | (fullAddress & 0x7FFFF);
}

/** System 2 C140の符号付き8-bit PCMを、SF2用の16-bit PCMへ拡張する。 */
function decodeSystem2Pcm(rom: Buffer, start: number, end: number): Int16Array {
  const pcm = new Int16Array(end - start);
  for (let index = 0; index < pcm.length; index += 1) {
    pcm[index] = rom.readInt8(start + index) << 8;
  }
  return pcm;
}

/** System 2のC140分周クロックと位相加算値からPCMの自然サンプルレートを得る。 */
function calculateC140SourceRate(clock: number, frequency: number): number {
  const baseRate = clock > 0 ? clock / C140_SYSTEM2_CLOCK_DIVIDER : C140_SYSTEM2_FALLBACK_RATE;
  return frequency > 0 ? baseRate * 2 * frequency / 65536 : baseRate;
}

function buildSoundFont(samples: C140Sample[]): Buffer {
  const smplParts: Buffer[] = [];
  const headers: Buffer[] = [];
  let cursor = 0;
  for (const sample of samples) {
    const pcm = Buffer.alloc(sample.pcm.length * 2);
    for (let index = 0; index < sample.pcm.length; index += 1) pcm.writeInt16LE(sample.pcm[index], index * 2);
    smplParts.push(pcm);
    headers.push(buildSampleHeader(sample.id, cursor, cursor + sample.pcm.length, sample.loopStart === undefined ? cursor : cursor + sample.loopStart, sample.loopEnd === undefined ? cursor + sample.pcm.length : cursor + sample.loopEnd, sample.sampleRate, sample.midiNote));
    cursor += sample.pcm.length;
  }
  smplParts.push(Buffer.alloc(92));
  headers.push(buildSampleHeader('EOS', cursor, cursor, cursor, cursor, 44100, 0));
  const smpl = Buffer.concat(smplParts);
  const info = list('INFO', [chunk('ifil', u16(2, 1)), chunk('isng', text('EMU8000')), chunk('INAM', text('miditrack C140'))]);
  const sdta = list('sdta', [chunk('smpl', smpl)]);
  const generators = samples.flatMap((sample, index) => [
    generator(SF2_GENERATOR_KEY_RANGE, sample.midiNote | (sample.midiNote << 8)),
    ...(sample.loopStart === undefined ? [] : [generator(SF2_GENERATOR_SAMPLE_MODES, 1)]),
    // SoundFont 2.1 requires SampleID to be the final generator in a zone.
    generator(SF2_GENERATOR_SAMPLE_ID, index),
  ]);
  const bagOffsets: number[] = [];
  let generatorOffset = 0;
  for (const sample of samples) {
    bagOffsets.push(generatorOffset);
    generatorOffset += 2 + (sample.loopStart === undefined ? 0 : 1);
  }
  const inst = Buffer.concat([instrument('C140 PCM', 0), instrument('EOI', samples.length)]);
  const ibag = Buffer.concat([...bagOffsets.map(offset => bag(offset, 0)), bag(generatorOffset, 0)]);
  const pdta = list('pdta', [
    chunk('phdr', Buffer.concat([preset('C140 PCM', 0), preset('EOP', 1)])),
    chunk('pbag', Buffer.concat([bag(0, 0), bag(1, 0)])),
    chunk('pmod', Buffer.alloc(10)),
    chunk('pgen', generator(SF2_GENERATOR_INSTRUMENT, 0)),
    chunk('inst', inst),
    chunk('ibag', ibag),
    chunk('imod', Buffer.alloc(10)),
    chunk('igen', Buffer.concat(generators)),
    chunk('shdr', Buffer.concat(headers)),
  ]);
  const body = Buffer.concat([Buffer.from('sfbk'), info, sdta, pdta]);
  return Buffer.concat([Buffer.from('RIFF'), u32(body.length), body]);
}

function buildSampleHeader(name: string, start: number, end: number, loopStart: number, loopEnd: number, sampleRate: number, rootKey: number): Buffer {
  return Buffer.concat([fixedText(name, 20), u32(start), u32(end), u32(loopStart), u32(loopEnd), u32(sampleRate), Buffer.from([rootKey, 0]), u16(0), u16(1)]);
}

function preset(name: string, bagIndex: number): Buffer { return Buffer.concat([fixedText(name, 20), u16(0), u16(SF2_DRUM_BANK), u16(bagIndex), Buffer.alloc(12)]); }
function instrument(name: string, bagIndex: number): Buffer { return Buffer.concat([fixedText(name, 20), u16(bagIndex)]); }
function bag(generatorIndex: number, modulatorIndex: number): Buffer { return Buffer.concat([u16(generatorIndex), u16(modulatorIndex)]); }
function generator(oper: number, amount: number): Buffer { return Buffer.concat([u16(oper), u16(amount)]); }
function chunk(id: string, data: Buffer): Buffer { return Buffer.concat([Buffer.from(id), u32(data.length), data, ...(data.length % 2 === 0 ? [] : [Buffer.alloc(1)])]); }
function list(type: string, contents: Buffer[]): Buffer { return chunk('LIST', Buffer.concat([Buffer.from(type), ...contents])); }
function text(value: string): Buffer {
  const result = Buffer.from(`${value}\0`, 'ascii');
  // FluidSynthはINFOの文字列チャンクも偶数サイズであることを要求する。
  return result.length % 2 === 0 ? result : Buffer.concat([result, Buffer.alloc(1)]);
}
function fixedText(value: string, length: number): Buffer { const result = Buffer.alloc(length); result.write(value.slice(0, length - 1), 'ascii'); return result; }
function u16(...values: number[]): Buffer { const result = Buffer.alloc(values.length * 2); values.forEach((value, index) => result.writeUInt16LE(value & 0xFFFF, index * 2)); return result; }
function u32(...values: number[]): Buffer { const result = Buffer.alloc(values.length * 4); values.forEach((value, index) => result.writeUInt32LE(value >>> 0, index * 4)); return result; }
