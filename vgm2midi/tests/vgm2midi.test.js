const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');

const {
  MidiConverter,
  YM2413_BUILTIN_CARRIER_REGISTER_BYTES,
  YM2413_BUILTIN_CARRIER_MULTIPLES,
} = require('../dist/midi-converter');
const { renderNoiseWav } = require('../dist/noise-renderer');
const { renderDacWav } = require('../dist/dac-renderer');
const { VGMParser } = require('../dist/vgm-parser');
const { prepareVGMPlayback } = require('../dist/vgm-playback');
const { COMMAND_CHIPS, STREAM_DEVICE_CHIPS } = require('../dist/vgm-chip-metadata');

function createHeader(overrides = {}) {
  return {
    fileId: 'Vgm ',
    eofOffset: 0,
    version: 0x0161,
    sn76489Clock: 0,
    sn76489Flags: 0,
    ym2413Clock: 0,
    gd3Offset: 0,
    totalSamples: 44100,
    loopOffset: 0,
    loopSamples: 0,
    rate: 0,
    ym2203Clock: 0,
    ym2608Clock: 0,
    ym3812Clock: 0,
    ym3526Clock: 0,
    y8950Clock: 0,
    ym2612Clock: 0,
    ym2151Clock: 3579545,
    vgmDataOffset: 0x100,
    segaPCMClock: 0,
    segaPCMInterface: 0,
    ay8910Clock: 0,
    ay8910Type: 0,
    ay8910Flags: 0,
    ym2203AyFlags: 0,
    ym2608AyFlags: 0,
    huc6280Clock: 0,
    c140Clock: 0,
    gbDmgClock: 0,
    ...overrides,
  };
}

function createVgmBuffer(commandBytes, version = 0x0161, dataOffset = 0x100) {
  const buffer = Buffer.alloc(dataOffset + commandBytes.length);
  buffer.write('Vgm ', 0, 'ascii');
  buffer.writeUInt32LE(buffer.length - 4, 0x04);
  buffer.writeUInt32LE(version, 0x08);
  buffer.writeUInt32LE(44100, 0x18);
  buffer.writeUInt32LE(3579545, 0x30);
  buffer.writeUInt32LE(dataOffset - 0x34, 0x34);
  Buffer.from(commandBytes).copy(buffer, dataOffset);
  return buffer;
}

test('VGMParser.fromBuffer accepts direct VGM and gzip-compressed VGZ bytes', () => {
  const vgm = createVgmBuffer([0x50, 0x90, 0x66]);
  assert.equal(VGMParser.fromBuffer(vgm).parse().commands[0].type, 'psg_write');
  assert.equal(VGMParser.fromBuffer(zlib.gzipSync(vgm)).parse().commands[0].type, 'psg_write');
});

test('native offline build refuses an absent source cache before invoking git clone or fetch', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgm2midi-native-offline-'));
  const fakeBin = path.join(directory, 'bin'); const marker = path.join(directory, 'git-was-called');
  fs.mkdirSync(fakeBin);
  const fakeGit = path.join(fakeBin, 'git');
  fs.writeFileSync(fakeGit, `#!/bin/sh\nprintf invoked > "${marker}"\nexit 99\n`);
  fs.chmodSync(fakeGit, 0o755);
  const source = path.join(directory, 'missing-source');
  const script = path.join(__dirname, '..', 'scripts', 'build-native.sh');
  const result = childProcess.spawnSync('bash', [script], {
    env: {
      ...process.env, PATH: `${fakeBin}:${process.env.PATH}`,
      VGM2MIDI_NATIVE_OFFLINE: '1', VGM2MIDI_NATIVE_CACHE: path.join(directory, 'cache'),
      VGM2MIDI_LIBVGM_SOURCE: source, VGM2MIDI_NATIVE_BUILD: path.join(directory, 'build'),
    }, encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /source cache is absent in offline mode/);
  assert.equal(fs.existsSync(marker), false, 'offline mode must not attempt git clone/fetch');
});

test('native offline build reports an uncached pin without attempting fetch', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgm2midi-native-pin-'));
  const fakeBin = path.join(directory, 'bin'); const calls = path.join(directory, 'git-calls');
  const source = path.join(directory, 'cached-source'); fs.mkdirSync(path.join(source, '.git'), { recursive: true }); fs.mkdirSync(fakeBin);
  const fakeGit = path.join(fakeBin, 'git');
  fs.writeFileSync(fakeGit, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${calls}"\ncase "$*" in *cat-file*) exit 1;; *) exit 99;; esac\n`);
  fs.chmodSync(fakeGit, 0o755);
  const script = path.join(__dirname, '..', 'scripts', 'build-native.sh');
  const result = childProcess.spawnSync('bash', [script], {
    env: {
      ...process.env, PATH: `${fakeBin}:${process.env.PATH}`,
      VGM2MIDI_NATIVE_OFFLINE: '1', VGM2MIDI_NATIVE_CACHE: path.join(directory, 'cache'),
      VGM2MIDI_LIBVGM_SOURCE: source, VGM2MIDI_NATIVE_BUILD: path.join(directory, 'build'),
    }, encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /source cache exists but pin 57585ea is absent in offline mode/);
  const commands = fs.readFileSync(calls, 'utf8');
  assert.match(commands, /cat-file/);
  assert.doesNotMatch(commands, /fetch|clone/);
});

function countSequence(buffer, sequence) {
  const bytes = Buffer.from(sequence);
  let count = 0;
  let offset = 0;
  while ((offset = buffer.indexOf(bytes, offset)) !== -1) {
    count += 1;
    offset += bytes.length;
  }
  return count;
}

function convertYM2612Commands(commands, clock = 7670453, options = {}) {
  const converter = new MidiConverter({
    header: createHeader({ ym2612Clock: clock, ym2151Clock: 0 }),
    commands: [...commands, { type: 'end' }],
  }, options);
  const MidiWriter = require('midi-writer-js');
  const tracks = converter.convert();
  const midi = Buffer.from(new MidiWriter.Writer(tracks).buildFile());
  return { converter, midi, tracks };
}

function convertOPNCommands(chip, commands, clock, options = {}) {
  const clockField = chip === 'YM2203' ? 'ym2203Clock' : 'ym2608Clock';
  const converter = new MidiConverter({
    header: createHeader({ [clockField]: clock, ym2151Clock: 0 }),
    commands: [...commands, { type: 'end' }],
  }, options);
  const MidiWriter = require('midi-writer-js');
  const tracks = converter.convert();
  const midi = Buffer.from(new MidiWriter.Writer(tracks).buildFile());
  return { converter, midi, tracks };
}

function convertOPLCommands(chip, commands, clock = 3579545, options = {}) {
  const clockField = chip === 'YM3812' ? 'ym3812Clock' : chip === 'YM3526' ? 'ym3526Clock' : 'y8950Clock';
  const converter = new MidiConverter({
    header: createHeader({ [clockField]: clock, ym2151Clock: 0 }),
    commands: [...commands, { type: 'end' }],
  }, options);
  const MidiWriter = require('midi-writer-js');
  const tracks = converter.convert();
  const midi = Buffer.from(new MidiWriter.Writer(tracks).buildFile());
  return { converter, midi, tracks };
}

function oplWrite(chip, register, data, instance = 0) {
  return { type: 'chip_write', chip, instance, port: 0, register, data };
}

function opnCh3SpecialHit(chip, instance, blocks, fnum = 0x269) {
  const frequencyRegisters = [
    [0xAD, 0xA9], // Op1
    [0xAE, 0xAA], // Op2
    [0xAC, 0xA8], // Op3
    [0xA6, 0xA2], // Op4
  ];
  const write = (register, data) => ({
    type: 'chip_write', chip, instance, port: 0, register, data,
  });
  const commands = [write(0x27, 0x40)];
  for (let operator = 0; operator < 4; operator++) {
    const [highRegister, lowRegister] = frequencyRegisters[operator];
    commands.push(
      write(highRegister, (blocks[operator] << 3) | ((fnum >> 8) & 0x07)),
      write(lowRegister, fnum & 0xFF),
    );
  }
  commands.push(write(0x28, 0xF2), { type: 'wait', samples: 4410 }, write(0x28, 0x02));
  return commands;
}

function convertYM2413Commands(commands, clock = 3579545) {
  const converter = new MidiConverter({
    header: createHeader({ ym2413Clock: clock, ym2151Clock: 0 }),
    commands: [...commands, { type: 'end' }],
  });
  const MidiWriter = require('midi-writer-js');
  const midi = Buffer.from(new MidiWriter.Writer(converter.convert()).buildFile());
  return { converter, midi };
}

function convertGBDMGCommands(commands, clock = 4194304) {
  const converter = new MidiConverter({
    header: createHeader({ gbDmgClock: clock, ym2151Clock: 0 }),
    commands: [...commands, { type: 'end' }],
  });
  const MidiWriter = require('midi-writer-js');
  const midi = Buffer.from(new MidiWriter.Writer(converter.convert()).buildFile());
  return { converter, midi };
}

function readLeftPcmSamples(wavPath) {
  const wav = fs.readFileSync(wavPath);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt16LE(22), 2);
  assert.equal(wav.readUInt32LE(24), 44100);
  assert.equal(wav.readUInt16LE(34), 16);
  const samples = [];
  for (let offset = 44; offset < wav.length; offset += 4) {
    samples.push(wav.readInt16LE(offset));
  }
  return samples;
}

test('noise renderer omits the WAV when no hardware-noise voice becomes audible', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgm2midi-no-noise-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'noise.wav');
  const result = renderNoiseWav({
    header: createHeader({ sn76489Clock: 3579545, ym2151Clock: 0 }),
    commands: [{ type: 'wait', samples: 100 }, { type: 'end' }],
  }, 100, output);

  assert.deepEqual(result, { framesWritten: 0, voicesFound: 0 });
  assert.equal(fs.existsSync(output), false);
});

test('SN76489 periodic NF=0 uses the expected 6991Hz LFSR shift rate', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgm2midi-sn-rate-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'noise.wav');
  const totalSamples = 44100;
  const result = renderNoiseWav({
    header: createHeader({ sn76489Clock: 3579545, sn76489Flags: 0, ym2151Clock: 0 }),
    commands: [
      { type: 'psg_write', data: 0xE0 }, // Periodic noise, NF=0; resets the LFSR.
      { type: 'psg_write', data: 0xF0 }, // Noise volume 0 (loudest).
      { type: 'wait', samples: totalSamples },
      { type: 'end' },
    ],
  }, totalSamples, output);

  assert.deepEqual(result, { framesWritten: totalSamples, voicesFound: 1 });
  const samples = readLeftPcmSamples(output);
  let positiveRuns = 0;
  for (let index = 0; index < samples.length; index++) {
    if (samples[index] > 0 && (index === 0 || samples[index - 1] <= 0)) positiveRuns++;
  }
  // 3579545 / (32 * 0x10) = 6991.3 LFSR shifts/sec. Periodic mode emits one
  // positive run per 16 shifts, i.e. about 437 runs/sec. This catches x2/x0.5 errors.
  assert.ok(positiveRuns >= 436 && positiveRuns <= 438, `positiveRuns=${positiveRuns}`);
});

test('SN76489 noise-control writes reset repeated attacks byte-for-byte', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgm2midi-sn-reset-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'noise.wav');
  const attackFrames = 512;
  const silenceFrames = 100;
  renderNoiseWav({
    header: createHeader({ sn76489Clock: 3579545, ym2151Clock: 0 }),
    commands: [
      { type: 'psg_write', data: 0xE4 },
      { type: 'psg_write', data: 0xF0 },
      { type: 'wait', samples: attackFrames },
      { type: 'psg_write', data: 0xFF },
      { type: 'wait', samples: silenceFrames },
      { type: 'psg_write', data: 0xE4 },
      { type: 'psg_write', data: 0xF0 },
      { type: 'wait', samples: attackFrames },
      { type: 'end' },
    ],
  }, (attackFrames * 2) + silenceFrames, output);

  const samples = readLeftPcmSamples(output);
  assert.deepEqual(
    samples.slice(0, attackFrames),
    samples.slice(attackFrames + silenceFrames)
  );
});

test('HuC6280 renderer supports channels 4-5 on both chip instances', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgm2midi-huc-noise-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'noise.wav');
  const commands = [];
  for (const [instance, channel, rate] of [[0, 4, 0x00], [1, 5, 0x1f]]) {
    commands.push(
      { type: 'chip_write', chip: 'HuC6280', instance, register: 0x00, data: channel },
      { type: 'chip_write', chip: 'HuC6280', instance, register: 0x04, data: 0x9f },
      { type: 'chip_write', chip: 'HuC6280', instance, register: 0x07, data: 0x80 | rate },
    );
  }
  commands.push({ type: 'wait', samples: 1000 }, { type: 'end' });

  const result = renderNoiseWav({
    header: createHeader({ huc6280Clock: 7159090, ym2151Clock: 0 }),
    commands,
  }, 1000, output);
  const samples = readLeftPcmSamples(output);

  assert.deepEqual(result, { framesWritten: 1000, voicesFound: 2 });
  assert.ok(samples.some(sample => sample !== 0));
});

test('suppressHardwareNoise removes only SN76489/HuC6280 percussion notes', () => {
  const converter = new MidiConverter({
    header: createHeader({ sn76489Clock: 3579545, huc6280Clock: 7159090, ym2151Clock: 0 }),
    commands: [
      { type: 'psg_write', data: 0xE4 },
      { type: 'psg_write', data: 0xF0 },
      { type: 'chip_write', chip: 'HuC6280', instance: 0, register: 0x00, data: 4 },
      { type: 'chip_write', chip: 'HuC6280', instance: 0, register: 0x02, data: 0x40 },
      { type: 'chip_write', chip: 'HuC6280', instance: 0, register: 0x03, data: 0x01 },
      { type: 'chip_write', chip: 'HuC6280', instance: 0, register: 0x04, data: 0x9f },
      { type: 'wait', samples: 100 },
      { type: 'chip_write', chip: 'HuC6280', instance: 0, register: 0x07, data: 0x9f },
      { type: 'wait', samples: 100 },
      { type: 'end' },
    ],
  }, { suppressHardwareNoise: true });

  const tracks = converter.convert();
  assert.equal(converter.generatedNoteCount, 1);
  assert.equal(tracks.length, 1);
  assert.ok(tracks[0].events.some(event => event.name === 'NoteOnEvent'));
});

test('parser preserves command boundaries and unsupported VGM write operands', () => {
  const parser = new VGMParser(createVgmBuffer([
    0x31, 0xAA,             // Unsupported two-byte command.
    0xC1, 0x01, 0x02, 0x03, // Unsupported four-byte command.
    0x54, 0x28, 0x4A,       // YM2151 channel 0, A4 key code.
    0x61, 0x44, 0xAC,       // Wait 44100 samples.
    0x66,
  ]));

  const parsed = parser.parse();
  assert.deepEqual(parsed.commands, [
    { type: 'unsupported_write', chip: 'RF5C68', instance: 0, command: 0xC1, operands: [0x01, 0x02, 0x03], data: 0x03 },
    { type: 'chip_write', chip: 'YM2151', port: 0, register: 0x28, data: 0x4A },
    { type: 'wait', samples: 44100 },
    { type: 'end' },
  ]);
});

test('parser preserves YM2612 DAC seek and stream timing commands', () => {
  const parser = new VGMParser(createVgmBuffer([
    0xE0, 0x34, 0x12, 0x00, 0x00,
    0x82,
    0x80,
    0x61, 0x64, 0x00,
    0x66,
  ]));

  const parsed = parser.parse();
  assert.deepEqual(parsed.commands, [
    { type: 'pcm_seek', chip: 'YM2612', address: 0x1234 },
    { type: 'pcm_write', chip: 'YM2612', samples: 2 },
    { type: 'pcm_write', chip: 'YM2612', samples: 0 },
    { type: 'wait', samples: 100 },
    { type: 'end' },
  ]);
});

test('parser captures YM2612 PCM data blocks (type 0x00) and concatenates them in file order', () => {
  const parser = new VGMParser(createVgmBuffer([
    0x67, 0x66, 0x00, 0x03, 0x00, 0x00, 0x00, 0x10, 0x20, 0x30, // data block type 0x00, 3 bytes.
    0x67, 0x66, 0x01, 0x02, 0x00, 0x00, 0x00, 0xAA, 0xBB, // Different block type; must not be captured.
    0x67, 0x66, 0x00, 0x02, 0x00, 0x00, 0x00, 0x40, 0x50, // Second type 0x00 block, appended after the first.
    0x66,
  ]));

  const parsed = parser.parse();
  assert.deepEqual(parsed.commands, [
    { type: 'data_block', data: 0x00 },
    { type: 'data_block', data: 0x01 },
    { type: 'data_block', data: 0x00 },
    { type: 'end' },
  ]);
  assert.deepEqual([...parsed.ym2612PcmData], [0x10, 0x20, 0x30, 0x40, 0x50]);
  assert.deepEqual(parsed.dataBlocks.map(block => [block.type, block.blockId, block.size, [...block.payload]]), [
    [0x00, 0, 3, [0x10, 0x20, 0x30]],
    [0x01, 0, 2, [0xAA, 0xBB]],
    [0x00, 1, 2, [0x40, 0x50]],
  ]);
});

test('parser leaves ym2612PcmData undefined when no type 0x00 data block is present', () => {
  const parser = new VGMParser(createVgmBuffer([
    0x67, 0x66, 0x01, 0x01, 0x00, 0x00, 0x00, 0xAA,
    0x66,
  ]));

  assert.equal(parser.parse().ym2612PcmData, undefined);
});

test('parser expands compressed data banks and keeps $67 size bit31 as the second-bank instance', () => {
  // 0x44 is compressed bank 0x04.  The header is: bit-pack, output=4, 8-bit
  // values made from 2 packed bits, copy subtype, base=0; 00 01 10 11 -> 0..3.
  const parsed = new VGMParser(createVgmBuffer([
    0x67, 0x66, 0x44, 0x0B, 0x00, 0x00, 0x80, 0x00, 0x04, 0x00, 0x00, 0x00, 0x08, 0x02, 0x00, 0x00, 0x00, 0x1B,
    // A dual ROM/RAM block is not a stream bank, but must neither consume bit31
    // as payload length nor lose the device instance while preserving its bytes.
    0x67, 0x66, 0x80, 0x02, 0x00, 0x00, 0x80, 0xAA, 0xBB,
    0x66,
  ])).parse();
  assert.deepEqual(parsed.dataBlocks.map(block => [block.type, block.blockId, block.instance, block.originalType, [...block.payload]]), [
    [0x04, 0, 1, 0x44, [0, 1, 2, 3]],
    [0x80, 0, 1, 0x80, [0xAA, 0xBB]],
  ]);
});

test('parser rejects malformed compressed data blocks before they can desynchronise commands', () => {
  assert.throws(() => new VGMParser(createVgmBuffer([
    // Declares four 8-bit values from 2 packed bits but supplies no packed bytes.
    0x67, 0x66, 0x44, 0x0A, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x08, 0x02, 0x00, 0x00, 0x00,
    0x66,
  ])).parse(), /Invalid compressed VGM data block/);
});

test('parser preserves DAC stream step base, length mode and fast block ID with the data-bank payloads', () => {
  const parsed = new VGMParser(createVgmBuffer([
    0x67, 0x66, 0x04, 0x08, 0x00, 0x00, 0x00, ...new Array(8).fill(0x11),
    0x67, 0x66, 0x04, 0x10, 0x00, 0x00, 0x00, ...new Array(16).fill(0x22),
    0x90, 0x00, 0x17, 0xB7, 0x00,
    0x91, 0x00, 0x04, 0x02, 0x01,
    0x93, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1F, 0x28, 0x00, 0x00, 0x00,
    0x95, 0x00, 0x01, 0x00, 0x11,
    0x66,
  ])).parse();
  assert.deepEqual(parsed.dataBlocks.map(block => [block.type, block.blockId, block.size]), [[4, 0, 8], [4, 1, 16]]);
  assert.deepEqual(parsed.commands.slice(2, 6), [
    { type: 'stream_setup', streamId: 0, data: 0x17, port: 0xB7, register: 0x00, targetChip: 'MSM6258', targetInstance: 0, command: 0x90 },
    { type: 'stream_data', streamId: 0, bankId: 4, stepSize: 2, stepBase: 1, command: 0x91 },
    { type: 'stream_start', streamId: 0, address: 0, data: 0x1F, length: 40, lengthMode: 0x0F, command: 0x93 },
    { type: 'stream_start_fast', streamId: 0, address: 1, blockId: 1, data: 0x11, command: 0x95 },
  ]);
});

test('header fields overlapped by an early VGM 1.51 data stream are zero', () => {
  const buffer = Buffer.alloc(0x80);
  buffer.write('Vgm ', 0, 'ascii');
  buffer.writeUInt32LE(buffer.length - 4, 0x04);
  buffer.writeUInt32LE(0x0151, 0x08);
  buffer.writeUInt32LE(0, 0x34); // Default data offset 0x40.
  buffer.writeUInt32LE(0x6E45796F, 0x74); // Command bytes, not an AY8910 clock.

  const header = new VGMParser(buffer).parseHeader();
  assert.equal(header.vgmDataOffset, 0x40);
  assert.equal(header.ym2203Clock, 0);
  assert.equal(header.ay8910Clock, 0);
  assert.equal(header.ay8910Type, 0);
  assert.equal(header.ay8910Flags, 0);
  assert.equal(header.ym2203AyFlags, 0);
});

test('header exposes SegaPCM and C140 clocks when their fields precede VGM data', () => {
  const buffer = createVgmBuffer([0x66], 0x0161, 0xC0);
  buffer.writeUInt32LE(4000000, 0x38);
  buffer.writeUInt32LE(12, 0x3C);
  buffer.writeUInt32LE(12288000, 0xA8);

  const header = new VGMParser(buffer).parseHeader();
  assert.equal(header.segaPCMClock, 4000000);
  assert.equal(header.segaPCMInterface, 12);
  assert.equal(header.c140Clock, 12288000);
});

test('header exposes SN76489 flags and discriminates the legacy VGM 1.01 FM clock', () => {
  const modernBuffer = createVgmBuffer([0x66], 0x0151, 0x100);
  modernBuffer.writeUInt8(0x09, 0x2B);
  assert.equal(new VGMParser(modernBuffer).parseHeader().sn76489Flags, 0x09);

  const legacyBuffer = Buffer.alloc(0x47);
  legacyBuffer.write('Vgm ', 0, 'ascii');
  legacyBuffer.writeUInt32LE(legacyBuffer.length - 4, 0x04);
  legacyBuffer.writeUInt32LE(0x0101, 0x08);
  legacyBuffer.writeUInt32LE(4000000, 0x10);
  legacyBuffer[0x40] = 0x62; legacyBuffer[0x41] = 0x40; legacyBuffer[0x42] = 0x00; legacyBuffer[0x43] = 0x52; legacyBuffer[0x44] = 0x22; legacyBuffer[0x45] = 0x33; legacyBuffer[0x46] = 0x66;
  const legacyHeader = new VGMParser(legacyBuffer).parseHeader();
  assert.equal(legacyHeader.ym2612Clock, 4000000);
  assert.equal(legacyHeader.ym2151Clock, 0);
});

test('legacy FM clock follows first YM2413/YM2612/YM2151 command through waits and unknown boundaries', () => {
  for (const [command, expected] of [[0x51, 'ym2413Clock'], [0x52, 'ym2612Clock'], [0x54, 'ym2151Clock']]) {
    const buffer = createVgmBuffer([0x62, 0x40, 0xAA, command, 0x00, 0x00, 0x66], 0x0101, 0x40);
    buffer.writeUInt32LE(4000000, 0x10);
    assert.equal(new VGMParser(buffer).parseHeader()[expected], 4000000);
  }
});

test('parser extracts AY8910 and HuC6280 second-chip bits from the register byte', () => {
  const parser = new VGMParser(createVgmBuffer([
    0xA0, 0x82, 0x34,
    0xB9, 0x83, 0x05,
    0x66,
  ]));

  assert.deepEqual(parser.parse().commands, [
    { type: 'chip_write', chip: 'AY8910', instance: 1, port: 0, register: 0x02, data: 0x34 },
    { type: 'chip_write', chip: 'HuC6280', instance: 1, port: 0, register: 0x03, data: 0x05 },
    { type: 'end' },
  ]);
});

test('header exposes the YM2203 clock and integrated SSG flags', () => {
  const buffer = createVgmBuffer([0x66], 0x0151, 0x100);
  buffer.writeUInt32LE(0x40000000 + 4000000, 0x44);
  buffer.writeUInt8(0x03, 0x7A);

  const header = new VGMParser(buffer).parseHeader();
  assert.equal(header.ym2203Clock, 0x40000000 + 4000000);
  assert.equal(header.ym2203AyFlags, 0x03);
});

test('parser preserves primary and second YM2203 register writes', () => {
  const parser = new VGMParser(createVgmBuffer([
    0x55, 0xA4, 0x1A,
    0xA5, 0x08, 0x0F,
    0x66,
  ]));

  assert.deepEqual(parser.parse().commands, [
    { type: 'chip_write', chip: 'YM2203', instance: 0, port: 0, register: 0xA4, data: 0x1A },
    { type: 'chip_write', chip: 'YM2203', instance: 1, port: 0, register: 0x08, data: 0x0F },
    { type: 'end' },
  ]);
});

test('header exposes the YM2608 clock and integrated SSG flags', () => {
  const buffer = createVgmBuffer([0x66], 0x0151, 0x100);
  buffer.writeUInt32LE(0x40000000 + 8000000, 0x48);
  buffer.writeUInt8(0x05, 0x7B);

  const header = new VGMParser(buffer).parseHeader();
  assert.equal(header.ym2608Clock, 0x40000000 + 8000000);
  assert.equal(header.ym2608AyFlags, 0x05);
});

test('parser preserves both ports and both YM2608 chip instances', () => {
  const parser = new VGMParser(createVgmBuffer([
    0x56, 0xA4, 0x1A,
    0x57, 0xA0, 0x69,
    0xA6, 0x10, 0x01,
    0xA7, 0x00, 0x80,
    0x66,
  ]));

  assert.deepEqual(parser.parse().commands, [
    { type: 'chip_write', chip: 'YM2608', instance: 0, port: 0, register: 0xA4, data: 0x1A },
    { type: 'chip_write', chip: 'YM2608', instance: 0, port: 1, register: 0xA0, data: 0x69 },
    { type: 'chip_write', chip: 'YM2608', instance: 1, port: 0, register: 0x10, data: 0x01 },
    { type: 'chip_write', chip: 'YM2608', instance: 1, port: 1, register: 0x00, data: 0x80 },
    { type: 'end' },
  ]);
});

test('parser resolves the relative VGM loop offset to a command index', () => {
  const dataOffset = 0x100;
  const commandBytes = [
    0x54, 0x28, 0x4A,
    0x61, 0x64, 0x00,
    0x54, 0x08, 0x78,
    0x61, 0xC8, 0x00,
    0x66,
  ];
  const buffer = createVgmBuffer(commandBytes, 0x0161, dataOffset);
  const loopDataOffset = dataOffset + 6;
  buffer.writeUInt32LE(loopDataOffset - 0x1C, 0x1C);
  buffer.writeUInt32LE(200, 0x20);

  const parsed = new VGMParser(buffer).parse();
  assert.equal(parsed.header.loopDataOffset, loopDataOffset);
  assert.equal(parsed.loopCommandIndex, 2);
});

test('loop count repeats only the loop section and preserves the intro once', () => {
  const playback = prepareVGMPlayback({
    header: createHeader({ totalSamples: 300, loopOffset: 1, loopSamples: 200 }),
    loopCommandIndex: 2,
    commands: [
      { type: 'chip_write', chip: 'YM2151', register: 0x28, data: 0x4A },
      { type: 'wait', samples: 100 },
      { type: 'chip_write', chip: 'YM2151', register: 0x08, data: 0x78 },
      { type: 'wait', samples: 200 },
      { type: 'end' },
    ],
  }, { loopCount: 3 });

  assert.equal(playback.sourceSamples, 300);
  assert.equal(playback.introSamples, 100);
  assert.equal(playback.loopSamples, 200);
  assert.equal(playback.totalSamples, 700);
  assert.deepEqual(
    playback.data.commands.filter(command => command.type === 'wait').map(command => command.samples),
    [100, 200, 200, 200]
  );
  assert.equal(playback.data.commands.filter(command => command.type === 'end').length, 1);
});

test('loop expansion supports real-world command arrays beyond the spread argument limit', () => {
  const loopCommands = Array.from({ length: 150000 }, () => ({ type: 'data_block' }));
  loopCommands.push({ type: 'wait', samples: 1 });
  const playback = prepareVGMPlayback({
    header: createHeader({ totalSamples: 1, loopOffset: 1, loopSamples: 1 }),
    loopCommandIndex: 0,
    commands: [...loopCommands, { type: 'end' }],
  }, { loopCount: 2 });

  assert.equal(playback.data.commands.length, (loopCommands.length * 2) + 1);
  assert.equal(playback.totalSamples, 2);
});

test('duration repeats the loop and clips the final wait at the requested sample', () => {
  const playback = prepareVGMPlayback({
    header: createHeader({ totalSamples: 300, loopOffset: 1, loopSamples: 200 }),
    loopCommandIndex: 2,
    commands: [
      { type: 'chip_write', chip: 'YM2151', register: 0x28, data: 0x4A },
      { type: 'wait', samples: 100 },
      { type: 'chip_write', chip: 'YM2151', register: 0x08, data: 0x78 },
      { type: 'wait', samples: 200 },
      { type: 'end' },
    ],
  }, { durationSeconds: 450 / 44100 });

  assert.equal(playback.totalSamples, 450);
  assert.deepEqual(
    playback.data.commands.filter(command => command.type === 'wait').map(command => command.samples),
    [100, 200, 150]
  );
});

test('playback duration counts and clips waits embedded in YM2612 DAC writes', () => {
  const playback = prepareVGMPlayback({
    header: createHeader({ totalSamples: 10, loopOffset: 0, loopSamples: 0 }),
    commands: [
      { type: 'pcm_write', chip: 'YM2612', samples: 6 },
      { type: 'wait', samples: 4 },
      { type: 'end' },
    ],
  }, { durationSeconds: 8 / 44100 });

  assert.equal(playback.sourceSamples, 10);
  assert.equal(playback.totalSamples, 8);
  assert.deepEqual(playback.data.commands, [
    { type: 'pcm_write', chip: 'YM2612', samples: 6 },
    { type: 'wait', samples: 2 },
    { type: 'end' },
  ]);
});

test('duration truncation keeps a zero-wait pcm_write instead of dropping the DAC trigger', () => {
  const playback = prepareVGMPlayback({
    header: createHeader({ totalSamples: 8, loopOffset: 0, loopSamples: 0 }),
    commands: [
      { type: 'pcm_write', chip: 'YM2612', samples: 0 },
      { type: 'wait', samples: 4 },
      { type: 'pcm_write', chip: 'YM2612', samples: 0 },
      { type: 'wait', samples: 4 },
      { type: 'end' },
    ],
  }, { durationSeconds: 8 / 44100 });

  const pcmWrites = playback.data.commands.filter(command => command.type === 'pcm_write');
  assert.equal(pcmWrites.length, 2);
});

test('playback rejects repetition beyond EOF when the VGM has no loop point', () => {
  const data = {
    header: createHeader({ totalSamples: 100, loopOffset: 0, loopSamples: 0 }),
    commands: [
      { type: 'wait', samples: 100 },
      { type: 'end' },
    ],
  };

  assert.throws(() => prepareVGMPlayback(data, { loopCount: 2 }), /does not define a loop point/);
  assert.throws(() => prepareVGMPlayback(data, { durationSeconds: 200 / 44100 }), /does not define a loop point/);
});

test('parser preserves SegaPCM and C140 memory writes', () => {
  const parser = new VGMParser(createVgmBuffer([
    0xC0, 0x86, 0x00, 0xC6,
    0xD4, 0x01, 0x25, 0xD0,
    0x66,
  ]));

  const parsed = parser.parse();
  assert.deepEqual(parsed.commands, [
    { type: 'chip_write', chip: 'SegaPCM', port: 0, register: 0x0086, data: 0xC6 },
    { type: 'chip_write', chip: 'C140', port: 0, register: 0x0125, data: 0xD0 },
    { type: 'end' },
  ]);
});

test('YM2151 key code and key-on writes produce a playable MIDI track', () => {
  const converter = new MidiConverter({
    header: createHeader(),
    commands: [
      { type: 'chip_write', chip: 'YM2151', port: 0, register: 0x28, data: 0x4A },
      { type: 'chip_write', chip: 'YM2151', port: 0, register: 0x30, data: 0x00 },
      { type: 'chip_write', chip: 'YM2151', port: 0, register: 0x08, data: 0x78 },
      { type: 'wait', samples: 44100 },
      { type: 'chip_write', chip: 'YM2151', port: 0, register: 0x08, data: 0x00 },
      { type: 'end' },
    ],
  });

  const tracks = converter.convert();
  assert.equal(tracks.length, 1);

  const MidiWriter = require('midi-writer-js');
  const midi = Buffer.from(new MidiWriter.Writer(tracks).buildFile());
  assert.equal(midi.subarray(0, 4).toString('ascii'), 'MThd');
  assert.equal(midi.readUInt16BE(10), 1);
  assert.notEqual(midi.indexOf(Buffer.from([0x90, 69])), -1);
});

test('OPN CSM turns Timer A overflows into Ch3 Special MIDI attacks and stops with Load A', () => {
  const write = (register, data) => ({
    type: 'chip_write', chip: 'YM2612', port: 0, register, data,
  });
  const { converter, tracks } = convertYM2612Commands([
    // Ch3 Special's four independent frequencies must be set before CSM starts.
    write(0xAD, 0x22), write(0xA9, 0x69),
    write(0xAE, 0x22), write(0xAA, 0x69),
    write(0xAC, 0x22), write(0xA8, 0x69),
    write(0xA6, 0x22), write(0xA2, 0x69),
    write(0x24, 0x00), write(0x25, 0x00),
    write(0x27, 0x81), // Mode 10 (CSM) + Timer A Load.
    { type: 'wait', samples: 1300 },
    write(0x27, 0x80), // Keep CSM selected but stop Timer A.
    { type: 'wait', samples: 1300 },
  ]);

  const noteOns = tracks.flatMap(track => track.events).filter(event => event.name === 'NoteOnEvent');
  assert.equal(converter.generatedNoteCount, 12, 'three Timer A overflows × four Ch3 operators');
  assert.equal(noteOns.length, 12);
});

test('YM2203 and YM2608 apply their own Timer A clocks to OPN CSM', () => {
  for (const [chip, clock] of [['YM2203', 4000000], ['YM2608', 7987200]]) {
    const write = (register, data) => ({ type: 'chip_write', chip, port: 0, register, data });
    const { converter } = convertOPNCommands(chip, [
      write(0xAD, 0x22), write(0xA9, 0x69), write(0xAE, 0x22), write(0xAA, 0x69),
      write(0xAC, 0x22), write(0xA8, 0x69), write(0xA6, 0x22), write(0xA2, 0x69),
      write(0x24, 0x00), write(0x25, 0x00), write(0x27, 0x81),
      { type: 'wait', samples: 1700 },
    ], clock);
    assert.ok(converter.generatedNoteCount >= 8, `${chip} must emit at least two four-operator CSM attacks`);
  }
});

test('OPM CSM turns Timer A overflows into one-tick attacks on all eight channels', () => {
  const converter = new MidiConverter({
    header: createHeader(),
    commands: [
      ...Array.from({ length: 8 }, (_, channel) => ({
        type: 'chip_write', chip: 'YM2151', register: 0x28 + channel, data: 0x4A,
      })),
      { type: 'chip_write', chip: 'YM2151', register: 0x10, data: 0x00 },
      { type: 'chip_write', chip: 'YM2151', register: 0x11, data: 0x00 },
      { type: 'chip_write', chip: 'YM2151', register: 0x14, data: 0x81 }, // CSM + Timer A start.
      { type: 'wait', samples: 900 },
      { type: 'chip_write', chip: 'YM2151', register: 0x14, data: 0x80 }, // Stop Timer A.
      { type: 'wait', samples: 1700 },
      { type: 'end' },
    ],
  });

  const tracks = converter.convert();
  const noteOns = tracks.flatMap(track => track.events).filter(event => event.name === 'NoteOnEvent');
  assert.equal(converter.generatedNoteCount, 8);
  assert.equal(noteOns.length, 8, 'CSM enables all eight YM2151 channels at one overflow');
});

test('YM2151 key-code and key-fraction changes remain pitch bends inside one key-on', () => {
  const converter = new MidiConverter({
    header: createHeader(),
    commands: [
      { type: 'chip_write', chip: 'YM2151', port: 0, register: 0x28, data: 0x4A },
      { type: 'chip_write', chip: 'YM2151', port: 0, register: 0x30, data: 0x00 },
      { type: 'chip_write', chip: 'YM2151', port: 0, register: 0x08, data: 0x78 },
      { type: 'wait', samples: 2205 },
      { type: 'chip_write', chip: 'YM2151', port: 0, register: 0x28, data: 0x32 },
      { type: 'chip_write', chip: 'YM2151', port: 0, register: 0x30, data: 0x64 },
      { type: 'wait', samples: 2205 },
      { type: 'chip_write', chip: 'YM2151', port: 0, register: 0x08, data: 0x00 },
      { type: 'end' },
    ],
  });

  const tracks = converter.convert();
  const noteOns = tracks[0].events.filter(event => event.name === 'NoteOnEvent');
  const noteOffs = tracks[0].events.filter(event => event.name === 'NoteOffEvent');
  const pitchBends = tracks[0].events.filter(event => event.name === 'PitchBendEvent');
  const rangeEntry = tracks[0].events.find(event =>
    event.name === 'ControllerChangeEvent' && event.controllerNumber === 6
  );

  assert.equal(converter.generatedNoteCount, 1);
  assert.equal(noteOns.length, 1);
  assert.equal(noteOffs.length, 1);
  assert.equal(pitchBends.length, 3); // Initial tuning plus the active KC and KF writes.
  assert.equal(rangeEntry.controllerValue, 96);
});

test('YM2151 normalizes key and TL slots before carrier velocity and CC11', () => {
  const velocityForM1 = totalLevel => {
    const converter = new MidiConverter({
      header: createHeader(),
      commands: [
        { type: 'chip_write', chip: 'YM2151', register: 0x20, data: 0xC7 }, // alg 7
        { type: 'chip_write', chip: 'YM2151', register: 0x28, data: 0x4A },
        { type: 'chip_write', chip: 'YM2151', register: 0x60, data: totalLevel }, // M1 TL
        { type: 'chip_write', chip: 'YM2151', register: 0x08, data: 0x08 }, // M1 only
        { type: 'end' },
      ],
    });
    return converter.convert().flatMap(track => track.events)
      .find(event => event.name === 'NoteOnEvent').velocity;
  };

  // Algorithm 7 exposes M1 directly. Before raw $08 normalization both cases fell back
  // to the same neutral velocity because mask $08 was compared with logical mask $01.
  assert.ok(velocityForM1(0) > velocityForM1(96));

  const converter = new MidiConverter({
    header: createHeader(),
    commands: [
      { type: 'chip_write', chip: 'YM2151', register: 0x20, data: 0xC4 }, // alg 4
      { type: 'chip_write', chip: 'YM2151', register: 0x28, data: 0x4A },
      { type: 'chip_write', chip: 'YM2151', register: 0x70, data: 0x00 }, // C1 physical slot
      { type: 'chip_write', chip: 'YM2151', register: 0x08, data: 0x10 }, // C1 only
      { type: 'wait', samples: 100 },
      { type: 'chip_write', chip: 'YM2151', register: 0x70, data: 0x60 },
      { type: 'end' },
    ],
  });
  const events = converter.convert().flatMap(track => track.events);
  const expression = events.find(event =>
    event.name === 'ControllerChangeEvent' && event.controllerNumber === 11
  );
  assert.equal(converter.generatedNoteCount, 1);
  assert.ok(expression.controllerValue < 127);
});

test('YM2612 DAC seeks retrigger stable sample-identity percussion tracks', () => {
  const converter = new MidiConverter({
    header: createHeader({ ym2612Clock: 7670453, ym2151Clock: 0 }),
    commands: [
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x2B, data: 0x80 },
      { type: 'pcm_seek', chip: 'YM2612', address: 0x1234 },
      { type: 'pcm_write', chip: 'YM2612', samples: 10 },
      { type: 'pcm_seek', chip: 'YM2612', address: 0x5678 },
      { type: 'pcm_write', chip: 'YM2612', samples: 10 },
      { type: 'pcm_seek', chip: 'YM2612', address: 0x1234 },
      { type: 'pcm_write', chip: 'YM2612', samples: 10 },
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x2B, data: 0x00 },
      { type: 'end' },
    ],
  });

  const tracks = converter.convert();
  const MidiWriter = require('midi-writer-js');
  const midi = Buffer.from(new MidiWriter.Writer(tracks).buildFile());
  assert.equal(tracks.length, 2);
  assert.notEqual(midi.indexOf(Buffer.from('YM2612 DAC Sample 0x001234')), -1);
  assert.notEqual(midi.indexOf(Buffer.from('YM2612 DAC Sample 0x005678')), -1);
  assert.equal(countSequence(midi, [0x99, 35]), 2);
  assert.equal(countSequence(midi, [0x89, 35]), 2);
  assert.equal(countSequence(midi, [0x99, 36]), 1);
  assert.equal(countSequence(midi, [0x89, 36]), 1);
});

test('YM2612 direct DAC ($2A) writes are disabled without $2B enable', () => {
  const converter = new MidiConverter({
    header: createHeader({ ym2612Clock: 7670453, ym2151Clock: 0 }),
    commands: [
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x2A, data: 0x80 },
      { type: 'wait', samples: 100 },
      { type: 'end' },
    ],
  });
  assert.throws(
    () => converter.exportToFile(path.join(os.tmpdir(), 'unused.mid')),
    /No MIDI notes were generated/
  );
  assert.equal(converter.generatedNoteCount, 0);
});

test('YM2612 direct DAC ($2A) writes group into one note by elapsed-time gap', () => {
  const commands = [
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x2B, data: 0x80 },
  ];
  for (let i = 0; i < 3; i++) {
    commands.push({ type: 'chip_write', chip: 'YM2612', port: 0, register: 0x2A, data: 0x80 });
    commands.push({ type: 'wait', samples: 5 });
  }
  commands.push({ type: 'wait', samples: 2000 }); // Gap well beyond YM2612_DAC_DIRECT_GAP_SAMPLES.
  for (let i = 0; i < 3; i++) {
    commands.push({ type: 'chip_write', chip: 'YM2612', port: 0, register: 0x2A, data: 0x80 });
    commands.push({ type: 'wait', samples: 5 });
  }
  commands.push({ type: 'end' });

  const converter = new MidiConverter({
    header: createHeader({ ym2612Clock: 7670453, ym2151Clock: 0 }),
    commands,
  });
  const tracks = converter.convert();
  const track = tracks.find(event => event.events.some(e => e.name === 'NoteOnEvent'));
  const noteOns = track.events.filter(e => e.name === 'NoteOnEvent');
  const noteOffs = track.events.filter(e => e.name === 'NoteOffEvent');
  assert.equal(noteOns.length, 2);
  assert.equal(noteOffs.length, 2);

  // Reconstruct absolute ticks from the track's own delta timeline (NoteOnEvent uses a
  // "T<n>" wait string, everything else a numeric delta).
  let tick = 0;
  const ticks = track.events.map(event => {
    const delta = typeof event.wait === 'string'
      ? parseInt(event.wait.replace('T', ''), 10)
      : event.delta;
    tick += delta;
    return tick;
  });
  const firstNoteOffTick = ticks[track.events.indexOf(noteOffs[0])];
  const secondNoteOnTick = ticks[track.events.indexOf(noteOns[1])];
  // The first hit's Note Off must land near its own last write (~10 samples in), not get
  // stretched across the 2000-sample gap up to the second hit's Note On — regression check
  // for closing at the last-write time rather than at the moment the gap is detected.
  assert.ok(secondNoteOnTick - firstNoteOffTick >= 8);
});

test('YM2612 direct DAC ($2A) voice closes at its last write time on EOF, not the trailing silence', () => {
  const converter = new MidiConverter({
    header: createHeader({ ym2612Clock: 7670453, ym2151Clock: 0 }),
    commands: [
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x2B, data: 0x80 },
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x2A, data: 0x80 },
      { type: 'wait', samples: 500 },
      { type: 'wait', samples: 10000 }, // Long trailing silence before EOF.
      { type: 'end' },
    ],
  });
  const tracks = converter.convert();
  const track = tracks.find(event => event.events.some(e => e.name === 'NoteOnEvent'));
  const noteOff = track.events.find(e => e.name === 'NoteOffEvent');
  // Closed at the same tick as the single write (delta 0), not after the 10000-sample
  // trailing silence that precedes end-of-file.
  assert.equal(noteOff.delta, 0);
});

test('YM2612 direct DAC ($2A) voice closes at its last write time on $2B disable', () => {
  const converter = new MidiConverter({
    header: createHeader({ ym2612Clock: 7670453, ym2151Clock: 0 }),
    commands: [
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x2B, data: 0x80 },
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x2A, data: 0x80 },
      { type: 'wait', samples: 500 },
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x2B, data: 0x00 },
      { type: 'wait', samples: 10000 },
      { type: 'end' },
    ],
  });
  const tracks = converter.convert();
  const track = tracks.find(event => event.events.some(e => e.name === 'NoteOnEvent'));
  const noteOff = track.events.find(e => e.name === 'NoteOffEvent');
  assert.equal(noteOff.delta, 0);
});

test('suppressYM2612Dac removes only YM2612 DAC percussion notes', () => {
  const converter = new MidiConverter({
    header: createHeader({ ym2612Clock: 7670453, ym2151Clock: 3579545 }),
    commands: [
      { type: 'chip_write', chip: 'YM2151', port: 0, register: 0x28, data: 0x4A },
      { type: 'chip_write', chip: 'YM2151', port: 0, register: 0x08, data: 0x78 },
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x2B, data: 0x80 },
      { type: 'pcm_seek', chip: 'YM2612', address: 0x1234 },
      { type: 'pcm_write', chip: 'YM2612', samples: 10 },
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x2A, data: 0x80 },
      { type: 'wait', samples: 10 },
      { type: 'end' },
    ],
  }, { suppressYM2612Dac: true });

  const tracks = converter.convert();
  assert.equal(converter.generatedNoteCount, 1);
  assert.equal(tracks.length, 1);
  assert.ok(tracks[0].events.some(event => event.name === 'NoteOnEvent'));
});

test('DAC renderer omits the WAV when the DAC is never enabled', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgm2midi-no-dac-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'dac.wav');

  const result = renderDacWav({
    header: createHeader({ ym2151Clock: 0 }),
    commands: [
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x2A, data: 0xFF }, // $2B never enabled.
      { type: 'wait', samples: 4 },
      { type: 'end' },
    ],
  }, 4, output);

  assert.deepEqual(result, { framesWritten: 0, voicesFound: 0 });
  assert.equal(fs.existsSync(output), false);
});

test('DAC renderer stream mode reads actual PCM bytes from the captured data bank', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgm2midi-dac-stream-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'dac.wav');
  const bank = Buffer.from([0x80, 0xFF, 0x00]); // Silence, max, min.

  const result = renderDacWav({
    header: createHeader({ ym2612Clock: 7670453, ym2151Clock: 0 }),
    ym2612PcmData: bank,
    commands: [
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x2B, data: 0x80 },
      { type: 'pcm_seek', chip: 'YM2612', address: 0 },
      { type: 'pcm_write', chip: 'YM2612', samples: 4 }, // Reads bank[0]=0x80, held for 4 samples.
      { type: 'pcm_write', chip: 'YM2612', samples: 4 }, // Reads bank[1]=0xFF, held for 4 samples.
      { type: 'pcm_write', chip: 'YM2612', samples: 4 }, // Reads bank[2]=0x00, held for 4 samples.
      { type: 'end' },
    ],
  }, 12, output);

  assert.deepEqual(result, { framesWritten: 12, voicesFound: 1 });
  const samples = readLeftPcmSamples(output);
  assert.deepEqual(samples.slice(0, 4), [0, 0, 0, 0]);
  assert.deepEqual(samples.slice(4, 8), [32512, 32512, 32512, 32512]);
  assert.deepEqual(samples.slice(8, 12), [-32768, -32768, -32768, -32768]);
});

test('DAC renderer direct mode ($2A) uses the byte value carried by the write itself, no bank needed', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgm2midi-dac-direct-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'dac.wav');

  const result = renderDacWav({
    header: createHeader({ ym2151Clock: 0 }),
    commands: [
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x2B, data: 0x80 },
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x2A, data: 0xFF },
      { type: 'wait', samples: 4 },
      { type: 'end' },
    ],
  }, 4, output);

  assert.deepEqual(result, { framesWritten: 4, voicesFound: 1 });
  assert.deepEqual(readLeftPcmSamples(output), [32512, 32512, 32512, 32512]);
});

test('DAC renderer resumes the last latched level when re-enabled without a new write', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgm2midi-dac-resume-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'dac.wav');

  const result = renderDacWav({
    header: createHeader({ ym2151Clock: 0 }),
    commands: [
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x2B, data: 0x80 }, // DAC on.
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x2A, data: 0xFF },
      { type: 'wait', samples: 2 },
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x2B, data: 0x00 }, // DAC off; muted.
      { type: 'wait', samples: 2 },
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x2B, data: 0x80 }, // Re-enabled, no new $2A.
      { type: 'wait', samples: 2 },
      { type: 'end' },
    ],
  }, 6, output);

  assert.equal(result.voicesFound, 1);
  const samples = readLeftPcmSamples(output);
  assert.deepEqual(samples.slice(0, 2), [32512, 32512]);
  assert.deepEqual(samples.slice(2, 4), [0, 0]);
  assert.deepEqual(samples.slice(4, 6), [32512, 32512]);
});

test('DAC renderer stays silent when the seek address falls outside the captured PCM bank', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgm2midi-dac-oob-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'dac.wav');

  const result = renderDacWav({
    header: createHeader({ ym2151Clock: 0 }),
    ym2612PcmData: Buffer.from([0x80]),
    commands: [
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x2B, data: 0x80 },
      { type: 'pcm_seek', chip: 'YM2612', address: 100 },
      { type: 'pcm_write', chip: 'YM2612', samples: 4 },
      { type: 'end' },
    ],
  }, 4, output);

  assert.deepEqual(result, { framesWritten: 0, voicesFound: 0 });
  assert.equal(fs.existsSync(output), false);
});

test('YM2612 split F-Number writes do not emit intermediate phantom notes', () => {
  const converter = new MidiConverter({
    header: createHeader({ ym2612Clock: 7670453, ym2151Clock: 0 }),
    commands: [
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA4, data: 0x23 },
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA0, data: 0x05 },
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0xF0 },
      { type: 'wait', samples: 4410 },
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA4, data: 0x22 },
      { type: 'pcm_write', chip: 'YM2612', samples: 3 },
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA0, data: 0xFE },
      { type: 'wait', samples: 4410 },
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0x00 },
      { type: 'end' },
    ],
  });

  converter.convert();
  assert.equal(converter.generatedNoteCount, 1);
});

test('YM2612 common x4 operator multipliers raise the extracted pitch by two octaves', () => {
  const { midi } = convertYM2612Commands([
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xB0, data: 0x04 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x30, data: 0x04 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x34, data: 0x04 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x38, data: 0x04 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x3C, data: 0x04 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA4, data: 0x1A },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA0, data: 0x84 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0xF0 },
    { type: 'wait', samples: 4410 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0x00 },
  ], 0x40000000 + 7670453);

  assert.notEqual(midi.indexOf(Buffer.from([0x94, 84])), -1);
  assert.equal(midi.indexOf(Buffer.from([0x94, 60])), -1);
});

test('YM2612 explicit common MULTI=0 lowers the extracted pitch by one octave', () => {
  const { midi } = convertYM2612Commands([
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xB0, data: 0x07 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x30, data: 0x00 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x34, data: 0x00 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x38, data: 0x00 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x3C, data: 0x00 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA4, data: 0x1A },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA0, data: 0x84 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0xF0 },
    { type: 'wait', samples: 4410 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0x00 },
  ]);

  assert.notEqual(midi.indexOf(Buffer.from([0x94, 48])), -1);
  assert.equal(midi.indexOf(Buffer.from([0x94, 60])), -1);
});

test('YM2612 algorithm and key-on mask limit octave correction to audible operator paths', () => {
  const { midi } = convertYM2612Commands([
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xB0, data: 0x04 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x30, data: 0x01 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x34, data: 0x01 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x38, data: 0x04 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x3C, data: 0x01 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA4, data: 0x1A },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA0, data: 0x84 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0x20 },
    { type: 'wait', samples: 4410 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0x00 },
  ]);

  assert.notEqual(midi.indexOf(Buffer.from([0x94, 84])), -1);
});

test('YM2612 maximum total level excludes an inaudible carrier from octave correction', () => {
  const { midi } = convertYM2612Commands([
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xB0, data: 0x07 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x30, data: 0x01 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x34, data: 0x04 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x38, data: 0x04 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x3C, data: 0x04 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x40, data: 0x7F },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA4, data: 0x1A },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA0, data: 0x84 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0xF0 },
    { type: 'wait', samples: 4410 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0x00 },
  ]);

  assert.notEqual(midi.indexOf(Buffer.from([0x94, 84])), -1);
});

test('YM2612 multipliers without a shared power-of-two factor retain raw pitch', () => {
  const { midi } = convertYM2612Commands([
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xB0, data: 0x07 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x30, data: 0x01 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x34, data: 0x02 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x38, data: 0x02 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x3C, data: 0x02 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA4, data: 0x1A },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA0, data: 0x84 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0xF0 },
    { type: 'wait', samples: 4410 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0x00 },
  ]);

  assert.notEqual(midi.indexOf(Buffer.from([0x94, 60])), -1);
  assert.equal(midi.indexOf(Buffer.from([0x94, 72])), -1);
});

test('YM2612 multiplier changes apply on the next key-on without a transient note', () => {
  const { converter, midi } = convertYM2612Commands([
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xB0, data: 0x07 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x30, data: 0x01 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x34, data: 0x01 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x38, data: 0x01 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x3C, data: 0x01 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA4, data: 0x1A },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA0, data: 0x84 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0xF0 },
    { type: 'wait', samples: 2205 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x30, data: 0x02 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x34, data: 0x02 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x38, data: 0x02 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x3C, data: 0x02 },
    { type: 'wait', samples: 2205 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0x00 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0xF0 },
    { type: 'wait', samples: 2205 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0x00 },
  ]);

  assert.equal(converter.generatedNoteCount, 2);
  assert.notEqual(midi.indexOf(Buffer.from([0x94, 60])), -1);
  assert.notEqual(midi.indexOf(Buffer.from([0x94, 72])), -1);
});

test('YM2612 channel 3 special mode gives each operator an independent note', () => {
  const { converter, midi } = convertYM2612Commands([
    // $27 bits 7-6 = 01 selects Special mode for channel 3.
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x27, data: 0x40 },
    // Op4 keeps using the normal ch3 registers ($A2/$A6, channel index 2): block=3,
    // fnum=0x184 -> note 60, per the existing "multipliers without a shared power-of-two
    // factor retain raw pitch" regression above (same block/fnum values, pitch scale 1).
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA6, data: 0x1A },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA2, data: 0x84 },
    // Op1 ($A9/$AD): same fnum, block=2 -> one octave down (note 48).
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xAD, data: 0x12 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA9, data: 0x84 },
    // Op2 ($AA/$AE): same fnum, block=4 -> one octave up (note 72).
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xAE, data: 0x22 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xAA, data: 0x84 },
    // Op3 ($A8/$AC): same fnum, block=5 -> two octaves up (note 84).
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xAC, data: 0x2A },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA8, data: 0x84 },
    // Key on all four operators (slots) of channel index 2 (D0-D1=2, D2=0) at once.
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0xF2 },
    { type: 'wait', samples: 4410 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0x02 },
  ]);

  assert.equal(converter.generatedNoteCount, 4);
  assert.notEqual(midi.indexOf(Buffer.from([0x96, 60])), -1); // Op4 on ym2612_2 (MIDI ch 7)
  assert.notEqual(midi.indexOf(Buffer.from([0x9A, 48])), -1); // Op1 on ym2612_ch3sp_1 (MIDI ch 11)
  assert.notEqual(midi.indexOf(Buffer.from([0x9B, 72])), -1); // Op2 on ym2612_ch3sp_2 (MIDI ch 12)
  assert.notEqual(midi.indexOf(Buffer.from([0x9C, 84])), -1); // Op3 on ym2612_ch3sp_3 (MIDI ch 13)
});

test('YM2612 channel 3 special frequencies ignore port 1 writes', () => {
  const { converter, midi } = convertYM2612Commands([
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x27, data: 0x40 },
    // Valid port-0 Op1 frequency: note 48.
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xAD, data: 0x12 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA9, data: 0x84 },
    // The same register numbers on port 1 must not overwrite Ch3 Special state.
    { type: 'chip_write', chip: 'YM2612', port: 1, register: 0xAD, data: 0x2A },
    { type: 'chip_write', chip: 'YM2612', port: 1, register: 0xA9, data: 0x84 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0x12 },
    { type: 'wait', samples: 4410 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0x02 },
  ]);

  assert.equal(converter.generatedNoteCount, 1);
  assert.notEqual(midi.indexOf(Buffer.from([0x9A, 48])), -1);
  assert.equal(midi.indexOf(Buffer.from([0x9A, 84])), -1);
});

test('YM2612 channel 3 percussion mode collapses composite hits to GM drum families', () => {
  const commands = [
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x27, data: 0x40 },
  ];
  const frequencyRegisters = [
    [0xAD, 0xA9], // Op1
    [0xAE, 0xAA], // Op2
    [0xAC, 0xA8], // Op3
    [0xA6, 0xA2], // Op4
  ];
  const addHit = (algorithm, frequencies) => {
    commands.push({
      type: 'chip_write', chip: 'YM2612', port: 0, register: 0xB2, data: algorithm,
    });
    for (let operator = 0; operator < 4; operator++) {
      const [block, fnum] = frequencies[operator];
      const [highRegister, lowRegister] = frequencyRegisters[operator];
      commands.push(
        {
          type: 'chip_write', chip: 'YM2612', port: 0, register: highRegister,
          data: (block << 3) | ((fnum >> 8) & 0x07),
        },
        {
          type: 'chip_write', chip: 'YM2612', port: 0, register: lowRegister,
          data: fnum & 0xFF,
        },
      );
    }
    commands.push(
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0xF2 },
      { type: 'wait', samples: 441 },
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0x02 },
      { type: 'wait', samples: 441 },
    );
  };

  // Register snapshots are representative of Outride a Crisis's Ch3 drum patches:
  // low carriers -> kick, mid carriers -> snare, very high carriers -> hi-hat,
  // high carrier -> crash, and a tuned mid/high carrier -> tom.
  addHit(4, new Array(4).fill([1, 823]));
  addHit(5, [[2, 692], [2, 998], [2, 1090], [2, 1176]]);
  addHit(5, [[7, 979], [7, 1463], [7, 979], [7, 1463]]);
  addHit(2, [[5, 1217], [5, 733], [5, 733], [5, 1217]]);
  addHit(3, new Array(4).fill([4, 872]));

  const { converter, midi } = convertYM2612Commands(
    commands,
    7670453,
    { ym2612Ch3SpecialPercussion: true },
  );

  assert.equal(converter.generatedNoteCount, 5);
  for (const note of [36, 38, 42, 49, 47]) {
    assert.notEqual(midi.indexOf(Buffer.from([0x99, note])), -1, `missing GM note ${note}`);
  }
  assert.equal(midi.indexOf(Buffer.from([0x9A])), -1); // no independent Op1 track
  assert.equal(midi.indexOf(Buffer.from([0x9B])), -1); // no independent Op2 track
  assert.equal(midi.indexOf(Buffer.from([0x9C])), -1); // no independent Op3 track
  assert.notEqual(midi.indexOf(Buffer.from('YM2612 Ch3 Special Bass Drum (GM 36)')), -1);
});

test('YM2612 channel 3 mode switch closes an active special-mode voice before returning to normal', () => {
  const { converter } = convertYM2612Commands([
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x27, data: 0x40 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xAD, data: 0x1A },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA9, data: 0x84 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0x12 }, // key on ch3's Op1 only
    { type: 'wait', samples: 2205 },
    // Switch back to Normal mode mid-note, with no explicit key-off first.
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x27, data: 0x00 },
  ]);

  assert.equal(converter.channels.get('ym2612_ch3sp_1').active, false);
});

test('YM2612 channel 3 percussion retriggers cleanly after leaving and re-entering special mode', () => {
  const { converter } = convertYM2612Commands([
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA6, data: 0x09 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA2, data: 0x37 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x27, data: 0x40 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0xF2 },
    { type: 'wait', samples: 441 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x27, data: 0x00 },
    { type: 'wait', samples: 441 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x27, data: 0x40 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0xF2 },
    { type: 'wait', samples: 441 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0x02 },
  ], 7670453, { ym2612Ch3SpecialPercussion: true });

  assert.equal(converter.generatedNoteCount, 2);
});

test('YM2612 channel 3 special mode is off by default, leaving normal ch3 key-on unchanged', () => {
  const { converter, midi } = convertYM2612Commands([
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA6, data: 0x1A },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA2, data: 0x84 },
    // These special-mode-only registers must have no effect while special mode is off.
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xAD, data: 0x2A },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA9, data: 0x00 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0x22 }, // key on ch3's op2 (bit1) only
    { type: 'wait', samples: 4410 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0x02 },
  ]);

  assert.equal(converter.generatedNoteCount, 1);
  assert.notEqual(midi.indexOf(Buffer.from([0x96, 60])), -1); // ym2612_2 (MIDI ch 7), unaffected
});

test('YM2612 channel 6 avoids General MIDI percussion channel 10', () => {
  const { midi } = convertYM2612Commands([
    { type: 'chip_write', chip: 'YM2612', port: 1, register: 0xA6, data: 0x1A },
    { type: 'chip_write', chip: 'YM2612', port: 1, register: 0xA2, data: 0x84 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0xF6 },
    { type: 'wait', samples: 4410 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0x06 },
  ]);

  assert.notEqual(midi.indexOf(Buffer.from([0x9D, 60])), -1); // MIDI channel 14
  assert.equal(midi.indexOf(Buffer.from([0x99, 60])), -1); // never GM percussion channel 10
});

test('YM2612 carrier Total Level derives note-on velocity', () => {
  function noteOnVelocityForTL(tl) {
    const converter = new MidiConverter({
      header: createHeader({ ym2612Clock: 7670453, ym2151Clock: 0 }),
      commands: [
        // Algorithm 0: single carrier path, carrier = O4 (register 0x4C's operator).
        { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xB0, data: 0x00 },
        { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x4C, data: tl },
        { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA4, data: 0x22 },
        { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA0, data: 0x69 },
        { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0xF0 },
        { type: 'wait', samples: 4410 },
        { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0x00 },
        { type: 'end' },
      ],
    });
    const tracks = converter.convert();
    return tracks[0].events.find(event => event.name === 'NoteOnEvent').velocity;
  }

  assert.equal(noteOnVelocityForTL(0x00), 100); // Loudest (TL=0) -> full velocity.
  assert.equal(noteOnVelocityForTL(0x10), 79);  // Normal patch TL stays near the former neutral 80.
  // TL=0x7F silences the only carrier, so no reachable carrier is found and the
  // converter falls back to the previous neutral velocity (also confirms YM2612 no
  // longer falls through to the unrelated 40-fixed branch that regressed here before).
  assert.equal(noteOnVelocityForTL(0x7F), 80);
});

test('YM2612 carrier TL uses relative CC11 mid-note and resets it at the next key-on', () => {
  const converter = new MidiConverter({
    header: createHeader({ ym2612Clock: 7670453, ym2151Clock: 0 }),
    commands: [
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xB0, data: 0x00 },
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x4C, data: 0x00 },
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA4, data: 0x22 },
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA0, data: 0x69 },
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0xF0 },
      { type: 'wait', samples: 2205 },
      // The sounding note keeps its velocity and expresses this change through CC11.
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x4C, data: 0x20 },
      { type: 'wait', samples: 2205 },
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0x00 },
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0xF0 },
      { type: 'wait', samples: 2205 },
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0x00 },
      { type: 'end' },
    ],
  });

  const tracks = converter.convert();
  const noteOnVelocities = tracks[0].events
    .filter(event => event.name === 'NoteOnEvent')
    .map(event => event.velocity);
  const expressionValues = tracks[0].events
    .filter(event => event.name === 'ControllerChangeEvent' && event.controllerNumber === 11)
    .map(event => event.controllerValue);

  assert.equal(noteOnVelocities.length, 2);
  assert.equal(noteOnVelocities[0], 100); // First note: latched with TL=0.
  assert.ok(noteOnVelocities[1] < 100);    // Second note: picks up the new TL=0x20.
  assert.ok(expressionValues[0] < 127);    // Mid-note TL change is relative to its key-on.
  assert.equal(expressionValues.at(-1), 127); // The next note is not double-attenuated.
});

test('GM Program Change keeps PSG neutral and derives OPN/OPM programs from the initial algorithm', () => {
  function programForCommands(commands) {
    const converter = new MidiConverter({
      header: createHeader({
        sn76489Clock: 3579545, ym2612Clock: 7670453, ym2151Clock: 3579545, huc6280Clock: 1789773,
      }),
      commands: [...commands, { type: 'end' }],
    });
    const tracks = converter.convert();
    const track = tracks.find(t => t.events.some(e => e.name === 'NoteOnEvent'));
    return track.events.find(e => e.name === 'ProgramChangeEvent').instrument;
  }

  // PSG and wave-table tracks have no trustworthy timbre model, so they retain the
  // neutral square lead rather than selecting a preset with unrelated modulation.
  assert.equal(programForCommands([
    { type: 'psg_write', chip: 'SN76489', data: 0x80 | 5 },
    { type: 'psg_write', chip: 'SN76489', data: 0x00 },
    { type: 'psg_write', chip: 'SN76489', data: 0x90 },
  ]), 80);

  // HuC6280 previously selected Ocarina here, which added audible preset modulation.
  assert.equal(programForCommands([
    { type: 'chip_write', chip: 'HuC6280', register: 0x00, data: 0x00 },
    { type: 'chip_write', chip: 'HuC6280', register: 0x02, data: 0x50 },
    { type: 'chip_write', chip: 'HuC6280', register: 0x03, data: 0x01 },
    { type: 'chip_write', chip: 'HuC6280', register: 0x04, data: 0x9F },
  ]), 80);

  // OPN/OPM share the algorithm-to-program mapping.  This is only an initial GM
  // suggestion; the sidecar retains the chip state needed to explain the choice.
  assert.equal(programForCommands([
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xB0, data: 0x00 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA4, data: 0x22 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA0, data: 0x69 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0xF0 },
  ]), 81);

  assert.equal(programForCommands([
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xB0, data: 0x05 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA4, data: 0x22 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA0, data: 0x69 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0xF0 },
  ]), 62);

  assert.equal(programForCommands([
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xB0, data: 0x07 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA4, data: 0x22 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA0, data: 0x69 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0xF0 },
  ]), 16);

  // YM2151 uses the same OPN-style algorithm numbering for this purpose.
  assert.equal(programForCommands([
    { type: 'chip_write', chip: 'YM2151', port: 0, register: 0x20, data: 0x00 },
    { type: 'chip_write', chip: 'YM2151', port: 0, register: 0x28, data: 0x4A },
    { type: 'chip_write', chip: 'YM2151', port: 0, register: 0x08, data: 0x40 },
  ]), 81);
});

test('FM track metadata snapshots the first-note timbre state without changing notes', () => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgm2midi-fm-metadata-test-'));
  const metadataPath = path.join(tempDirectory, 'fm.libvgm.json');
  const { converter, tracks } = convertYM2612Commands([
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xB0, data: 0x05 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x30, data: 0x01 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x3C, data: 0x02 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x40, data: 0x04 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x4C, data: 0x0C },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA4, data: 0x22 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA0, data: 0x69 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0xF0 },
    { type: 'wait', samples: 4410 },
    { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0x00 },
  ]);

  const noteEvents = tracks[0].events.filter(event => event.name === 'NoteOnEvent' || event.name === 'NoteOffEvent');
  assert.equal(noteEvents.length, 2);
  converter.exportTrackMetadata(metadataPath, 4410);
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  const fm = metadata.tracks.find(entry => entry.descriptor.chip === 'YM2612').fm;
  assert.equal(metadata.version, 1); // Existing miditrack readers remain compatible.
  assert.equal(fm.model, 'opn');
  assert.equal(fm.suggestedProgram, 62);
  assert.equal(fm.algorithm, 5);
  assert.deepEqual(fm.carrierOperators, [1, 2, 3]);
  assert.deepEqual(fm.operatorMultipliers, [1, 0, 0, 2]);
  assert.deepEqual(fm.operatorTotalLevels, [4, 0, 0, 12]);
  assert.equal(fm.keyOnMask, 15);
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});

test('YM2413 patch selects an initial GM candidate and records active timbre changes', () => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgm2midi-ym2413-metadata-test-'));
  const metadataPath = path.join(tempDirectory, 'ym2413.libvgm.json');
  const converter = new MidiConverter({
    header: createHeader({ ym2413Clock: 3579545, ym2151Clock: 0 }),
    commands: [
      { type: 'chip_write', chip: 'YM2413', register: 0x30, data: 0x10 }, // Patch 1: Violin.
      { type: 'chip_write', chip: 'YM2413', register: 0x10, data: 0x69 },
      { type: 'chip_write', chip: 'YM2413', register: 0x20, data: 0x14 },
      { type: 'wait', samples: 100 },
      { type: 'chip_write', chip: 'YM2413', register: 0x30, data: 0x80 }, // Patch 8: Organ.
      { type: 'wait', samples: 100 },
      { type: 'chip_write', chip: 'YM2413', register: 0x30, data: 0x00 }, // Patch 0: user patch.
      { type: 'chip_write', chip: 'YM2413', register: 0x01, data: 0x04 }, // User carrier MULTI=4.
      { type: 'wait', samples: 100 },
      { type: 'chip_write', chip: 'YM2413', register: 0x20, data: 0x04 },
      { type: 'end' },
    ],
  });

  const tracks = converter.convert();
  converter.exportTrackMetadata(metadataPath, 300);
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  const entry = metadata.tracks.find(track => track.descriptor.sourceKey === 'ym2413_0');

  assert.equal(tracks[0].events.filter(event => event.name === 'NoteOnEvent').length, 1);
  assert.equal(entry.fm.ym2413Instrument, 1);
  assert.equal(entry.fm.suggestedProgram, 40);
  assert.deepEqual(entry.fmEvents.map(event => [event.sampleTime, event.source, event.timbre.suggestedProgram]), [
    [100, 'ym2413-patch', 16],
    [200, 'ym2413-patch', 80],
    [200, 'ym2413-custom-patch', 80],
  ]);
  assert.equal(entry.fmEvents[2].timbre.ym2413CarrierMultiple, 4);
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});

test('OPN, OPM, and OPL record active timbre changes and expose Ch3 Special state', () => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgm2midi-fm-event-metadata-test-'));

  const ym2612Path = path.join(tempDirectory, 'ym2612.json');
  const ym2612 = new MidiConverter({
    header: createHeader({ ym2612Clock: 7670453, ym2151Clock: 0 }),
    commands: [
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x27, data: 0x81 },
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xB2, data: 0x05 },
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA6, data: 0x1A },
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA2, data: 0x84 },
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xAD, data: 0x1A },
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA9, data: 0x84 },
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xAE, data: 0x1A },
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xAA, data: 0x84 },
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xAC, data: 0x1A },
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA8, data: 0x84 },
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0xF2 },
      { type: 'wait', samples: 100 },
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x42, data: 0x20 },
      { type: 'wait', samples: 100 },
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0x02 },
      { type: 'end' },
    ],
  });
  ym2612.convert();
  ym2612.exportTrackMetadata(ym2612Path, 200);
  const ym2612Metadata = JSON.parse(fs.readFileSync(ym2612Path, 'utf8'));
  const ym2612SpecialTracks = ym2612Metadata.tracks.filter(track => track.descriptor.chip === 'YM2612');
  assert.equal(ym2612SpecialTracks.length, 4);
  assert.ok(ym2612SpecialTracks.every(track => track.fm.opnCh3Mode === 'special-csm'));
  assert.ok(ym2612SpecialTracks.every(track => track.fmEvents.length === 1));
  assert.deepEqual(ym2612SpecialTracks.map(track => [track.fmEvents[0].sampleTime, track.fmEvents[0].source]), [
    [100, 'opn-timbre'],
    [100, 'opn-timbre'],
    [100, 'opn-timbre'],
    [100, 'opn-timbre'],
  ]);

  const ym2151Path = path.join(tempDirectory, 'ym2151.json');
  const ym2151 = new MidiConverter({
    header: createHeader(),
    commands: [
      { type: 'chip_write', chip: 'YM2151', register: 0x28, data: 0x4A },
      { type: 'chip_write', chip: 'YM2151', register: 0x08, data: 0x78 },
      { type: 'wait', samples: 100 },
      { type: 'chip_write', chip: 'YM2151', register: 0x40, data: 0x03 },
      { type: 'wait', samples: 100 },
      { type: 'chip_write', chip: 'YM2151', register: 0x60, data: 0x20 },
      { type: 'wait', samples: 100 },
      { type: 'chip_write', chip: 'YM2151', register: 0x20, data: 0x05 },
      { type: 'end' },
    ],
  });
  ym2151.convert();
  ym2151.exportTrackMetadata(ym2151Path, 300);
  const ym2151Entry = JSON.parse(fs.readFileSync(ym2151Path, 'utf8')).tracks.find(
    track => track.descriptor.sourceKey === 'ym2151_0'
  );
  assert.deepEqual(ym2151Entry.fmEvents.map(event => [event.sampleTime, event.source]), [
    [100, 'opm-timbre'],
    [200, 'opm-timbre'],
    [300, 'opm-timbre'],
  ]);
  assert.equal(ym2151Entry.fmEvents[0].timbre.operatorMultipliers[0], 3);
  assert.equal(ym2151Entry.fmEvents[1].timbre.operatorTotalLevels[0], 0x20);
  assert.equal(ym2151Entry.fmEvents[2].timbre.algorithm, 5);

  const oplPath = path.join(tempDirectory, 'opl.json');
  const opl = new MidiConverter({
    header: createHeader({ ym3812Clock: 3579545, ym2151Clock: 0 }),
    commands: [
      oplWrite('YM3812', 0xA0, 0x98),
      oplWrite('YM3812', 0xB0, 0x31),
      { type: 'wait', samples: 100 },
      oplWrite('YM3812', 0x20, 0x02),
      { type: 'wait', samples: 100 },
      oplWrite('YM3812', 0x40, 0x10),
      { type: 'wait', samples: 100 },
      oplWrite('YM3812', 0xC0, 0x01),
      { type: 'end' },
    ],
  });
  opl.convert();
  opl.exportTrackMetadata(oplPath, 300);
  const oplEntry = JSON.parse(fs.readFileSync(oplPath, 'utf8')).tracks.find(
    track => track.descriptor.sourceKey === 'ym3812_0_fm_0'
  );
  assert.deepEqual(oplEntry.fmEvents.map(event => [event.sampleTime, event.source]), [
    [100, 'opl-timbre'],
    [200, 'opl-timbre'],
    [300, 'opl-timbre'],
  ]);
  assert.equal(oplEntry.fmEvents[0].timbre.operatorMultipliers[0], 2);
  assert.equal(oplEntry.fmEvents[1].timbre.operatorTotalLevels[0], 0x10);
  assert.equal(oplEntry.fmEvents[2].timbre.algorithm, 1);
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});

test('YM2151 channel 7 noise operator maps to percussion without a phantom FM note', () => {
  const converter = new MidiConverter({
    header: createHeader(),
    commands: [
      { type: 'chip_write', chip: 'YM2151', port: 0, register: 0x28, data: 0x4A },
      { type: 'chip_write', chip: 'YM2151', port: 0, register: 0x0F, data: 0x80 },
      { type: 'chip_write', chip: 'YM2151', port: 0, register: 0x08, data: 0x47 },
      { type: 'wait', samples: 44100 },
      { type: 'chip_write', chip: 'YM2151', port: 0, register: 0x08, data: 0x07 },
      { type: 'end' },
    ],
  });

  const tracks = converter.convert();
  assert.equal(tracks.length, 1);

  const MidiWriter = require('midi-writer-js');
  const midi = Buffer.from(new MidiWriter.Writer(tracks).buildFile());
  assert.notEqual(midi.indexOf(Buffer.from('YM2151 Noise 7')), -1);
  assert.equal(midi.indexOf(Buffer.from('YM2151 FM 7')), -1);
  assert.notEqual(midi.indexOf(Buffer.from([0x99, 42])), -1);
  assert.notEqual(midi.indexOf(Buffer.from([0x89, 42])), -1);
  assert.equal(tracks[0].events.some(event =>
    event.name === 'ControllerChangeEvent' && event.controllerNumber === 6
  ), false);
});

test('YM2151 noise frequency (NFRQ) selects a GM drum band, inverted from other chips', () => {
  function noteForNFRQ(nfrq) {
    const converter = new MidiConverter({
      header: createHeader(),
      commands: [
        { type: 'chip_write', chip: 'YM2151', port: 0, register: 0x0F, data: 0x80 | nfrq },
        { type: 'chip_write', chip: 'YM2151', port: 0, register: 0x08, data: 0x47 },
        { type: 'wait', samples: 100 },
        { type: 'end' },
      ],
    });
    const tracks = converter.convert();
    return tracks.flatMap(t => t.events).find(e => e.name === 'NoteOnEvent').pitch;
  }

  // Unlike SN76489/AY/HuC6280, a LARGER NFRQ means a LOWER pitch on real hardware
  // (ymfm_opm.cpp: the noise counter compares against NFRQ, so a larger NFRQ delays the
  // LFSR update) — confirm the direction is not accidentally mirrored.
  assert.equal(noteForNFRQ(0x00), 42);
  assert.equal(noteForNFRQ(0x1F), 45);
});

test('YM2151 NFRQ change re-evaluates an already-sounding noise note', () => {
  const converter = new MidiConverter({
    header: createHeader(),
    commands: [
      { type: 'chip_write', chip: 'YM2151', port: 0, register: 0x0F, data: 0x80 | 0x00 },
      { type: 'chip_write', chip: 'YM2151', port: 0, register: 0x08, data: 0x47 },
      { type: 'wait', samples: 100 },
      // NFRQ changes while noise is still active (no intervening key-off/on) must still
      // retrigger once the drum band actually changes.
      { type: 'chip_write', chip: 'YM2151', port: 0, register: 0x0F, data: 0x80 | 0x1F },
      { type: 'wait', samples: 100 },
      { type: 'end' },
    ],
  });

  const tracks = converter.convert();
  const noiseTrack = tracks.find(t => t.events.some(e => e.name === 'TrackNameEvent'));
  const notes = noiseTrack.events.filter(e => e.name === 'NoteOnEvent').map(e => e.pitch);
  assert.deepEqual(notes, [42, 45]);
});

test('SN76489 dual-chip/T6W28 header flag bits do not distort tone pitch', () => {
  function noteForClock(clock) {
    const converter = new MidiConverter({
      header: createHeader({ sn76489Clock: clock, ym2151Clock: 0 }),
      commands: [
        { type: 'psg_write', chip: 'SN76489', data: 0x80 | (100 & 0x0F) },
        { type: 'psg_write', chip: 'SN76489', data: (100 >> 4) & 0x3F },
        { type: 'psg_write', chip: 'SN76489', data: 0x90 },
        { type: 'wait', samples: 4410 },
        { type: 'end' },
      ],
    });
    const noteOn = converter.convert()[0].events.find(event => event.name === 'NoteOnEvent');
    return noteOn.pitch;
  }

  // Header bit 30 (dual-chip) / bit 31 (T6W28) are flags, not part of the clock value;
  // an unmasked read inflates the effective clock and pushes every note to the ceiling.
  assert.equal(noteForClock(3579545), noteForClock(3579545 | 0x40000000));
});

test('SN76489 variant flags control period zero and the input clock divider', () => {
  function noteForPeriod(period, flags) {
    const converter = new MidiConverter({
      header: createHeader({ sn76489Clock: 3579545, sn76489Flags: flags, ym2151Clock: 0 }),
      commands: [
        { type: 'psg_write', chip: 'SN76489', data: 0x80 | (period & 0x0F) },
        { type: 'psg_write', chip: 'SN76489', data: (period >> 4) & 0x3F },
        { type: 'psg_write', chip: 'SN76489', data: 0x90 },
        { type: 'wait', samples: 4410 },
        { type: 'end' },
      ],
    });
    return converter.convert()[0].events.find(event => event.name === 'NoteOnEvent').pitch;
  }

  assert.equal(noteForPeriod(0, 0x01), 45);
  assert.equal(noteForPeriod(100, 0x08) - noteForPeriod(100, 0x00), 36);
});

test('SN76489 channel 2 uses the declared wide bend range instead of retriggering', () => {
  const converter = new MidiConverter({
    header: createHeader({ sn76489Clock: 3579545, ym2151Clock: 0 }),
    commands: [
      { type: 'psg_write', chip: 'SN76489', data: 0xC0 | (100 & 0x0F) },
      { type: 'psg_write', chip: 'SN76489', data: (100 >> 4) & 0x3F },
      { type: 'psg_write', chip: 'SN76489', data: 0xD0 },
      { type: 'wait', samples: 100 },
      { type: 'psg_write', chip: 'SN76489', data: 0xC0 | (89 & 0x0F) },
      { type: 'psg_write', chip: 'SN76489', data: (89 >> 4) & 0x3F },
      { type: 'wait', samples: 100 },
      { type: 'end' },
    ],
  });

  const noteOns = converter.convert()[0].events.filter(event => event.name === 'NoteOnEvent');
  assert.equal(noteOns.length, 1);
});

test('melodic note-on pitch bend preserves sub-semitone source tuning', () => {
  const converter = new MidiConverter({
    header: createHeader({ sn76489Clock: 3579545, ym2151Clock: 0 }),
    commands: [
      { type: 'psg_write', chip: 'SN76489', data: 0x80 | (100 & 0x0F) },
      { type: 'psg_write', chip: 'SN76489', data: (100 >> 4) & 0x3F },
      { type: 'psg_write', chip: 'SN76489', data: 0x90 },
      { type: 'wait', samples: 100 },
      { type: 'end' },
    ],
  });

  const pitchBend = converter.convert()[0].events.find(event => event.name === 'PitchBendEvent');
  assert.notDeepEqual(pitchBend.data.slice(-2), [0, 64]);
});

test('SN76489 noise-only rhythm exports a non-empty percussion MIDI', () => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgm2midi-noise-test-'));
  const outputPath = path.join(tempDirectory, 'sn76489-noise.mid');
  const converter = new MidiConverter({
    header: createHeader({ sn76489Clock: 3579545, ym2151Clock: 0 }),
    commands: [
      { type: 'psg_write', chip: 'SN76489', data: 0xE4 },
      { type: 'psg_write', chip: 'SN76489', data: 0xF0 },
      { type: 'wait', samples: 22050 },
      { type: 'psg_write', chip: 'SN76489', data: 0xE5 },
      { type: 'wait', samples: 22050 },
      { type: 'psg_write', chip: 'SN76489', data: 0xFF },
      { type: 'end' },
    ],
  });

  converter.exportToFile(outputPath);
  const metadataPath = path.join(tempDirectory, 'sn76489-noise.libvgm.json');
  converter.exportTrackMetadata(metadataPath, 44100);
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  assert.equal(metadata.sampleCount, 44100);
  assert.equal(metadata.tracks[0].trackIndex, 0);
  assert.deepEqual(metadata.tracks[0].libvgm, {
    deviceType: 0, instance: 0, mainMask: 8, linkedMask: 0,
    groupId: '0:0:8:0', suggestedForHardwareMix: true,
  });
  const midi = fs.readFileSync(outputPath);
  assert.ok(midi.length > 14);
  assert.notEqual(midi.indexOf(Buffer.from('SN76489 Noise 3')), -1);
  assert.notEqual(midi.indexOf(Buffer.from([0x99, 42, 127])), -1);
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});

test('SN76489 white-noise rate selects a GM drum band by NF', () => {
  function noteForControl(nf, fb) {
    const converter = new MidiConverter({
      header: createHeader({ sn76489Clock: 3579545, ym2151Clock: 0 }),
      commands: [
        { type: 'psg_write', chip: 'SN76489', data: 0xE0 | (fb << 2) | nf },
        { type: 'psg_write', chip: 'SN76489', data: 0xF0 },
        { type: 'wait', samples: 100 },
        { type: 'end' },
      ],
    });
    const tracks = converter.convert();
    return tracks.flatMap(t => t.events).find(e => e.name === 'NoteOnEvent').pitch;
  }

  assert.equal(noteForControl(0, 1), 42); // White noise, NF0 (fastest) -> Closed Hi-Hat.
  assert.equal(noteForControl(1, 1), 38); // White noise, NF1 (mid) -> Acoustic Snare.
  assert.equal(noteForControl(2, 1), 45); // White noise, NF2 (slowest fixed rate) -> Low Tom.
  assert.equal(noteForControl(0, 0), 37); // Periodic/tonal noise, high -> Side Stick.
  assert.equal(noteForControl(2, 0), 35); // Periodic/tonal noise, low -> Bass Drum.
});

test('SN76489 NF=3 noise pitch follows channel 2 tone frequency, including retrigger on change', () => {
  const converter = new MidiConverter({
    header: createHeader({ sn76489Clock: 3579545, ym2151Clock: 0 }),
    commands: [
      // Latch channel 2 to a low tone frequency (large period -> low Hz) before enabling
      // NF=3 noise, so the noise starts in the low drum band.
      { type: 'psg_write', chip: 'SN76489', data: 0xC0 | 0x0F }, // Ch2 tone latch, low nibble.
      { type: 'psg_write', chip: 'SN76489', data: 0x3F },        // Ch2 tone data, upper 6 bits (period=0x3FF, low Hz).
      { type: 'psg_write', chip: 'SN76489', data: 0xE0 | 0x07 }, // Ch3 noise control: FB=1 (white), NF=3.
      { type: 'psg_write', chip: 'SN76489', data: 0xF0 },        // Ch3 volume=0 (loudest) -> triggers Note On.
      { type: 'wait', samples: 100 },
      // Now retune channel 2 to a high tone frequency (small period) while noise is
      // still sounding — the noise band should move without any write to channel 3.
      { type: 'psg_write', chip: 'SN76489', data: 0xC0 | 0x02 },
      { type: 'psg_write', chip: 'SN76489', data: 0x00 },
      { type: 'wait', samples: 100 },
      { type: 'end' },
    ],
  });

  const tracks = converter.convert();
  const noiseTrack = tracks.find(t => t.events.some(e => e.name === 'TrackNameEvent'));
  const notes = noiseTrack.events.filter(e => e.name === 'NoteOnEvent').map(e => e.pitch);
  assert.equal(notes.length, 2);
  assert.notEqual(notes[0], notes[1]); // Retuning channel 2 alone must retrigger the noise note.
});

test('AY-3-8910 mixer routes a noise-only channel to percussion', () => {
  const converter = new MidiConverter({
    header: createHeader({ ym2151Clock: 0, ay8910Clock: 1789773 }),
    commands: [
      { type: 'chip_write', chip: 'AY8910', register: 0x06, data: 0x04 },
      { type: 'chip_write', chip: 'AY8910', register: 0x07, data: 0x37 },
      { type: 'chip_write', chip: 'AY8910', register: 0x08, data: 0x0F },
      { type: 'wait', samples: 44100 },
      { type: 'chip_write', chip: 'AY8910', register: 0x08, data: 0x00 },
      { type: 'end' },
    ],
  });

  const tracks = converter.convert();
  assert.equal(tracks.length, 1);

  const MidiWriter = require('midi-writer-js');
  const midi = Buffer.from(new MidiWriter.Writer(tracks).buildFile());
  assert.notEqual(midi.indexOf(Buffer.from('AY-3-8910 Noise 0')), -1);
  assert.equal(midi.indexOf(Buffer.from('AY-3-8910 0')), -1);
  assert.notEqual(midi.indexOf(Buffer.from([0x99, 42, 127])), -1);
  assert.notEqual(midi.indexOf(Buffer.from([0x89, 42])), -1);
});

test('AY-3-8910 noise period (reg 6) selects a GM drum band', () => {
  function noteForPeriod(period) {
    const converter = new MidiConverter({
      header: createHeader({ ym2151Clock: 0, ay8910Clock: 1789773 }),
      commands: [
        { type: 'chip_write', chip: 'AY8910', register: 0x06, data: period },
        { type: 'chip_write', chip: 'AY8910', register: 0x07, data: 0x36 },
        { type: 'chip_write', chip: 'AY8910', register: 0x08, data: 0x0F },
        { type: 'wait', samples: 100 },
        { type: 'end' },
      ],
    });
    const tracks = converter.convert();
    return tracks.flatMap(t => t.events).find(e => e.name === 'NoteOnEvent').pitch;
  }

  assert.equal(noteForPeriod(1), 42);    // Smallest period (fastest) -> Closed Hi-Hat.
  assert.equal(noteForPeriod(15), 38);   // Mid period -> Acoustic Snare.
  assert.equal(noteForPeriod(0x1F), 45); // Largest period (slowest) -> Low Tom.
});

test('AY-3-8910 noise period change re-evaluates every currently-sounding noise channel', () => {
  const converter = new MidiConverter({
    header: createHeader({ ym2151Clock: 0, ay8910Clock: 1789773 }),
    commands: [
      { type: 'chip_write', chip: 'AY8910', register: 0x06, data: 1 }, // High rate.
      // Mixer: both channel 0 and 1 noise enabled, tone disabled (channel 2 untouched).
      { type: 'chip_write', chip: 'AY8910', register: 0x07, data: 0x27 },
      { type: 'chip_write', chip: 'AY8910', register: 0x08, data: 0x0F },
      { type: 'chip_write', chip: 'AY8910', register: 0x09, data: 0x0F },
      { type: 'wait', samples: 100 },
      // Shared reg 6 change must retrigger noise on BOTH channels, not just the one
      // whose own register happens to be touched next.
      { type: 'chip_write', chip: 'AY8910', register: 0x06, data: 0x1F }, // Low rate.
      { type: 'wait', samples: 100 },
      { type: 'end' },
    ],
  });

  const tracks = converter.convert();
  const noiseTracks = tracks.filter(t => t.events.some(e => e.name === 'TrackNameEvent'));
  assert.equal(noiseTracks.length, 2);
  for (const track of noiseTracks) {
    const notes = track.events.filter(e => e.name === 'NoteOnEvent').map(e => e.pitch);
    assert.deepEqual(notes, [42, 45]);
  }
});

test('AY8910 masks dual-chip clock flags and applies the YM2149 /2 divider', () => {
  function toneNote(clock, flags) {
    const converter = new MidiConverter({
      header: createHeader({ ym2151Clock: 0, ay8910Clock: clock, ay8910Flags: flags }),
      commands: [
        { type: 'chip_write', chip: 'AY8910', instance: 0, register: 0x00, data: 0xFE },
        { type: 'chip_write', chip: 'AY8910', instance: 0, register: 0x01, data: 0x00 },
        { type: 'chip_write', chip: 'AY8910', instance: 0, register: 0x08, data: 0x0F },
        { type: 'wait', samples: 4410 },
        { type: 'end' },
      ],
    });
    return converter.convert()[0].events.find(event => event.name === 'NoteOnEvent').pitch;
  }

  const baseNote = toneNote(1789773, 0);
  assert.equal(toneNote(0x40000000 + 1789773, 0), baseNote);
  assert.equal(toneNote(1789773, 0x10), baseNote - 12);
});

test('second AY8910 instance keeps separate track identity and pitch state', () => {
  const converter = new MidiConverter({
    header: createHeader({ ym2151Clock: 0, ay8910Clock: 0x40000000 + 1789773 }),
    commands: [
      { type: 'chip_write', chip: 'AY8910', instance: 1, register: 0x00, data: 0xFE },
      { type: 'chip_write', chip: 'AY8910', instance: 1, register: 0x01, data: 0x00 },
      { type: 'chip_write', chip: 'AY8910', instance: 1, register: 0x08, data: 0x0F },
      { type: 'wait', samples: 4410 },
      { type: 'end' },
    ],
  });

  const MidiWriter = require('midi-writer-js');
  const midi = Buffer.from(new MidiWriter.Writer(converter.convert()).buildFile());
  assert.notEqual(midi.indexOf(Buffer.from('AY-3-8910 #2 0')), -1);
  assert.notEqual(midi.indexOf(Buffer.from([0x9D, 69])), -1);
});

test('YM2203 converts a normal FM channel with the OPN clock divisor', () => {
  const converter = new MidiConverter({
    header: createHeader({ ym2203Clock: 4000000, ym2151Clock: 0 }),
    commands: [
      { type: 'chip_write', chip: 'YM2203', instance: 0, port: 0, register: 0xA4, data: 0x22 },
      { type: 'chip_write', chip: 'YM2203', instance: 0, port: 0, register: 0xA0, data: 0x69 },
      { type: 'chip_write', chip: 'YM2203', instance: 0, port: 0, register: 0x28, data: 0xF0 },
      { type: 'wait', samples: 4410 },
      { type: 'chip_write', chip: 'YM2203', instance: 0, port: 0, register: 0x28, data: 0x00 },
      { type: 'end' },
    ],
  });

  const MidiWriter = require('midi-writer-js');
  const midi = Buffer.from(new MidiWriter.Writer(converter.convert()).buildFile());
  assert.notEqual(midi.indexOf(Buffer.from('YM2203 FM 0')), -1);
  assert.notEqual(midi.indexOf(Buffer.from([0x90, 60])), -1);
  assert.notEqual(midi.indexOf(Buffer.from([0x80, 60])), -1);
});

test('YM2203 channel 3 special mode exposes four operator pitches by default', () => {
  const { converter, midi } = convertOPNCommands(
    'YM2203',
    opnCh3SpecialHit('YM2203', 0, [3, 5, 6, 4]),
    4000000,
  );

  assert.equal(converter.generatedNoteCount, 4);
  assert.notEqual(midi.indexOf(Buffer.from([0x92, 60])), -1); // Op4 reuses FM ch3/MIDI ch3.
  assert.notEqual(midi.indexOf(Buffer.from([0x9D, 48])), -1); // Op1 uses MIDI ch14.
  assert.notEqual(midi.indexOf(Buffer.from([0x9E, 72])), -1); // Op2 uses MIDI ch15.
  assert.notEqual(midi.indexOf(Buffer.from([0x9F, 84])), -1); // Op3 uses MIDI ch16.
  assert.notEqual(midi.indexOf(Buffer.from('YM2203 Ch3 Special Op1')), -1);
});

test('YM2203 channel 3 percussion option collapses a composite hit to one GM drum', () => {
  const { converter, midi } = convertOPNCommands(
    'YM2203',
    opnCh3SpecialHit('YM2203', 0, [1, 1, 1, 1], 823),
    4000000,
    { opnCh3SpecialPercussion: true },
  );

  assert.equal(converter.generatedNoteCount, 1);
  assert.notEqual(midi.indexOf(Buffer.from([0x99, 36])), -1);
  assert.notEqual(midi.indexOf(Buffer.from('YM2203 Ch3 Special Bass Drum (GM 36)')), -1);
  assert.equal(midi.indexOf(Buffer.from('YM2203 Ch3 Special Op1')), -1);
});

test('YM2203 channel 3 mode switch closes an active operator voice', () => {
  const write = (register, data) => ({
    type: 'chip_write', chip: 'YM2203', instance: 0, port: 0, register, data,
  });
  const { converter } = convertOPNCommands('YM2203', [
    write(0x27, 0x40),
    write(0xAD, 0x1A),
    write(0xA9, 0x69),
    write(0x28, 0x12),
    { type: 'wait', samples: 2205 },
    write(0x27, 0x00),
  ], 4000000);

  assert.equal(converter.channels.get('ym2203_0_ch3sp_1').active, false);
});

test('YM2203 repeated unchanged key-on writes do not retrigger the FM envelope', () => {
  const converter = new MidiConverter({
    header: createHeader({ ym2203Clock: 4000000, ym2151Clock: 0 }),
    commands: [
      { type: 'chip_write', chip: 'YM2203', register: 0xA4, data: 0x22 },
      { type: 'chip_write', chip: 'YM2203', register: 0xA0, data: 0x69 },
      { type: 'chip_write', chip: 'YM2203', register: 0x28, data: 0xF0 },
      { type: 'wait', samples: 2205 },
      { type: 'chip_write', chip: 'YM2203', register: 0x28, data: 0xF0 },
      { type: 'wait', samples: 2205 },
      { type: 'chip_write', chip: 'YM2203', register: 0x28, data: 0x00 },
      { type: 'end' },
    ],
  });

  const tracks = converter.convert();
  const noteOff = tracks[0].events.find(event => event.name === 'NoteOffEvent');
  assert.equal(converter.generatedNoteCount, 1);
  assert.equal(noteOff.delta, 192);
});

test('YM2203 split F-Number writes bend within one hardware key-on', () => {
  const converter = new MidiConverter({
    header: createHeader({ ym2203Clock: 4000000, ym2151Clock: 0 }),
    commands: [
      { type: 'chip_write', chip: 'YM2203', register: 0xA4, data: 0x22 },
      { type: 'chip_write', chip: 'YM2203', register: 0xA0, data: 0x69 },
      { type: 'chip_write', chip: 'YM2203', register: 0x28, data: 0xF0 },
      { type: 'wait', samples: 2205 },
      { type: 'chip_write', chip: 'YM2203', register: 0xA4, data: 0x1A },
      { type: 'chip_write', chip: 'YM2203', register: 0xA0, data: 0x69 },
      { type: 'wait', samples: 2205 },
      { type: 'chip_write', chip: 'YM2203', register: 0x28, data: 0x00 },
      { type: 'end' },
    ],
  });

  const tracks = converter.convert();
  const MidiWriter = require('midi-writer-js');
  const midi = Buffer.from(new MidiWriter.Writer(tracks).buildFile());
  const pitchBends = tracks[0].events.filter(event => event.name === 'PitchBendEvent');
  const rangeEntry = tracks[0].events.find(event =>
    event.name === 'ControllerChangeEvent' && event.controllerNumber === 6
  );

  assert.equal(converter.generatedNoteCount, 1);
  assert.equal(pitchBends.length, 2); // Initial center plus the active F-Number update.
  assert.notEqual(midi.indexOf(Buffer.from([0x90, 60])), -1);
  assert.equal(midi.indexOf(Buffer.from([0x90, 48])), -1);
  assert.notEqual(midi.indexOf(Buffer.from([0x80, 60])), -1);
  assert.equal(rangeEntry.controllerValue, 96);
});

test('YM2203 integrated SSG converts tone pitch and noise rhythm separately', () => {
  const converter = new MidiConverter({
    header: createHeader({ ym2203Clock: 4000000, ym2151Clock: 0 }),
    commands: [
      { type: 'chip_write', chip: 'YM2203', instance: 0, register: 0x00, data: 0x8E },
      { type: 'chip_write', chip: 'YM2203', instance: 0, register: 0x01, data: 0x00 },
      { type: 'chip_write', chip: 'YM2203', instance: 0, register: 0x07, data: 0x36 },
      { type: 'chip_write', chip: 'YM2203', instance: 0, register: 0x08, data: 0x0F },
      { type: 'wait', samples: 4410 },
      { type: 'chip_write', chip: 'YM2203', instance: 0, register: 0x07, data: 0x37 },
      { type: 'wait', samples: 4410 },
      { type: 'chip_write', chip: 'YM2203', instance: 0, register: 0x08, data: 0x00 },
      { type: 'end' },
    ],
  });

  const MidiWriter = require('midi-writer-js');
  const midi = Buffer.from(new MidiWriter.Writer(converter.convert()).buildFile());
  assert.notEqual(midi.indexOf(Buffer.from('YM2203 SSG 0')), -1);
  assert.notEqual(midi.indexOf(Buffer.from('YM2203 SSG Noise 0')), -1);
  assert.notEqual(midi.indexOf(Buffer.from([0x93, 69])), -1);
  assert.notEqual(midi.indexOf(Buffer.from([0x99, 42])), -1);
});

test('YM2203 integrated SSG applies the YM2149-compatible /2 clock flag', () => {
  function toneNote(flags) {
    const converter = new MidiConverter({
      header: createHeader({ ym2203Clock: 4000000, ym2203AyFlags: flags, ym2151Clock: 0 }),
      commands: [
        { type: 'chip_write', chip: 'YM2203', register: 0x00, data: 0x8E },
        { type: 'chip_write', chip: 'YM2203', register: 0x01, data: 0x00 },
        { type: 'chip_write', chip: 'YM2203', register: 0x08, data: 0x0F },
        { type: 'wait', samples: 4410 },
        { type: 'end' },
      ],
    });
    return converter.convert()[0].events.find(event => event.name === 'NoteOnEvent').pitch;
  }

  assert.equal(toneNote(0x10), toneNote(0) - 12);
});

test('YM2203 integrated SSG split period writes do not emit an intermediate phantom note', () => {
  const converter = new MidiConverter({
    header: createHeader({ ym2203Clock: 4000000, ym2151Clock: 0 }),
    commands: [
      { type: 'chip_write', chip: 'YM2203', instance: 0, register: 0x00, data: 0x8E },
      { type: 'chip_write', chip: 'YM2203', instance: 0, register: 0x01, data: 0x00 },
      { type: 'chip_write', chip: 'YM2203', instance: 0, register: 0x08, data: 0x0F },
      { type: 'wait', samples: 2205 },
      // MSB lands first here, so an unguarded read after only this write would combine
      // it with the still-stale LSB and briefly see a period far from either the old
      // or the final value.
      { type: 'chip_write', chip: 'YM2203', instance: 0, register: 0x01, data: 0x03 },
      { type: 'chip_write', chip: 'YM2203', instance: 0, register: 0x00, data: 0x00 },
      { type: 'wait', samples: 2205 },
      { type: 'chip_write', chip: 'YM2203', instance: 0, register: 0x08, data: 0x00 },
      { type: 'end' },
    ],
  });

  const tracks = converter.convert();
  const noteOnPitches = tracks[0].events
    .filter(event => event.name === 'NoteOnEvent')
    .map(event => event.pitch);

  // Without the split-write guard, the intermediate MSB-only state briefly reads as
  // note 37 and retriggers a spurious extra Note On/Off pair before the real one.
  assert.deepEqual(noteOnPitches, [69]);
  assert.equal(converter.generatedNoteCount, 1);
});

test('YM2203 prescaler changes retune the integrated SSG by one octave', () => {
  const converter = new MidiConverter({
    header: createHeader({ ym2203Clock: 4000000, ym2151Clock: 0 }),
    commands: [
      { type: 'chip_write', chip: 'YM2203', instance: 0, register: 0x00, data: 0x8E },
      { type: 'chip_write', chip: 'YM2203', instance: 0, register: 0x01, data: 0x00 },
      { type: 'chip_write', chip: 'YM2203', instance: 0, register: 0x08, data: 0x0F },
      { type: 'wait', samples: 4410 },
      { type: 'chip_write', chip: 'YM2203', instance: 0, register: 0x08, data: 0x00 },
      { type: 'chip_write', chip: 'YM2203', instance: 0, register: 0x2E, data: 0x00 },
      { type: 'chip_write', chip: 'YM2203', instance: 0, register: 0x08, data: 0x0F },
      { type: 'wait', samples: 4410 },
      { type: 'chip_write', chip: 'YM2203', instance: 0, register: 0x08, data: 0x00 },
      { type: 'end' },
    ],
  });

  const MidiWriter = require('midi-writer-js');
  const midi = Buffer.from(new MidiWriter.Writer(converter.convert()).buildFile());
  assert.notEqual(midi.indexOf(Buffer.from([0x93, 69])), -1);
  assert.notEqual(midi.indexOf(Buffer.from([0x93, 81])), -1);
});

test('YM2203 prescaler changes retune an active channel 3 special operator', () => {
  const write = (register, data) => ({
    type: 'chip_write', chip: 'YM2203', instance: 0, port: 0, register, data,
  });
  const { converter, midi } = convertOPNCommands('YM2203', [
    write(0x27, 0x40),
    write(0xAD, 0x1A),
    write(0xA9, 0x69),
    write(0x28, 0x12),
    { type: 'wait', samples: 2205 },
    write(0x2E, 0x00),
    { type: 'wait', samples: 2205 },
    write(0x28, 0x02),
  ], 4000000);

  assert.equal(converter.generatedNoteCount, 2);
  assert.notEqual(midi.indexOf(Buffer.from([0x9D, 48])), -1);
  assert.notEqual(midi.indexOf(Buffer.from([0x9D, 60])), -1);
});

test('second YM2203 uses separate FM and SSG track identities', () => {
  const converter = new MidiConverter({
    header: createHeader({ ym2203Clock: 0x40000000 + 4000000, ym2151Clock: 0 }),
    commands: [
      { type: 'chip_write', chip: 'YM2203', instance: 1, register: 0x00, data: 0x8E },
      { type: 'chip_write', chip: 'YM2203', instance: 1, register: 0x01, data: 0x00 },
      { type: 'chip_write', chip: 'YM2203', instance: 1, register: 0x08, data: 0x0F },
      { type: 'wait', samples: 4410 },
      { type: 'chip_write', chip: 'YM2203', instance: 1, register: 0x08, data: 0x00 },
      { type: 'end' },
    ],
  });

  const MidiWriter = require('midi-writer-js');
  const midi = Buffer.from(new MidiWriter.Writer(converter.convert()).buildFile());
  assert.notEqual(midi.indexOf(Buffer.from('YM2203 #2 SSG 0')), -1);
  assert.notEqual(midi.indexOf(Buffer.from([0x9A, 69])), -1);
});

test('YM2608 converts all six FM channels and keeps F-Number changes inside one key-on', () => {
  const converter = new MidiConverter({
    header: createHeader({ ym2608Clock: 8000000, ym2151Clock: 0 }),
    commands: [
      { type: 'chip_write', chip: 'YM2608', port: 1, register: 0xA4, data: 0x1A },
      { type: 'chip_write', chip: 'YM2608', port: 1, register: 0xA0, data: 0x69 },
      { type: 'chip_write', chip: 'YM2608', port: 0, register: 0x28, data: 0xF4 },
      { type: 'wait', samples: 2205 },
      { type: 'chip_write', chip: 'YM2608', port: 1, register: 0xA4, data: 0x22 },
      { type: 'chip_write', chip: 'YM2608', port: 1, register: 0xA0, data: 0x69 },
      { type: 'wait', samples: 2205 },
      { type: 'chip_write', chip: 'YM2608', port: 0, register: 0x28, data: 0x04 },
      { type: 'end' },
    ],
  });

  const tracks = converter.convert();
  const MidiWriter = require('midi-writer-js');
  const midi = Buffer.from(new MidiWriter.Writer(tracks).buildFile());
  const pitchBends = tracks[0].events.filter(event => event.name === 'PitchBendEvent');
  const rangeEntry = tracks[0].events.find(event =>
    event.name === 'ControllerChangeEvent' && event.controllerNumber === 6
  );

  assert.equal(converter.generatedNoteCount, 1);
  assert.equal(pitchBends.length, 2);
  assert.equal(rangeEntry.controllerValue, 96);
  assert.notEqual(midi.indexOf(Buffer.from('YM2608 FM 3')), -1);
  assert.notEqual(midi.indexOf(Buffer.from([0x93, 60])), -1);
});

test('YM2608 channel 3 special mode exposes four operator pitches by default', () => {
  const { converter, midi } = convertOPNCommands(
    'YM2608',
    opnCh3SpecialHit('YM2608', 0, [2, 4, 5, 3]),
    8000000,
  );

  assert.equal(converter.generatedNoteCount, 4);
  assert.notEqual(midi.indexOf(Buffer.from([0x92, 60])), -1);
  assert.notEqual(midi.indexOf(Buffer.from([0x9D, 48])), -1);
  assert.notEqual(midi.indexOf(Buffer.from([0x9E, 72])), -1);
  assert.notEqual(midi.indexOf(Buffer.from([0x9F, 84])), -1);
  assert.notEqual(midi.indexOf(Buffer.from('YM2608 Ch3 Special Op1')), -1);
});

test('YM2608 channel 3 percussion option collapses a composite hit to one GM drum', () => {
  const { converter, midi } = convertOPNCommands(
    'YM2608',
    opnCh3SpecialHit('YM2608', 0, [1, 1, 1, 1], 823),
    8000000,
    { opnCh3SpecialPercussion: true },
  );

  assert.equal(converter.generatedNoteCount, 1);
  assert.notEqual(midi.indexOf(Buffer.from([0x99, 36])), -1);
  assert.notEqual(midi.indexOf(Buffer.from('YM2608 Ch3 Special Bass Drum (GM 36)')), -1);
  assert.equal(midi.indexOf(Buffer.from('YM2608 Ch3 Special Op1')), -1);
});

test('dual YM2608 chips keep channel 3 special-mode state independent', () => {
  const write = (instance, register, data) => ({
    type: 'chip_write', chip: 'YM2608', instance, port: 0, register, data,
  });
  const { converter, midi, tracks } = convertOPNCommands('YM2608', [
    write(0, 0x27, 0x40),
    write(1, 0x27, 0x40),
    write(1, 0xAD, 0x12),
    write(1, 0xA9, 0x69),
    write(1, 0x28, 0x12),
    { type: 'wait', samples: 2205 },
    write(0, 0x27, 0x00),
    { type: 'wait', samples: 2205 },
    write(1, 0x28, 0x02),
  ], 0x40000000 + 8000000);

  const noteTrack = tracks.find(track =>
    track.events.some(event => event.name === 'NoteOnEvent')
  );
  const noteOff = noteTrack.events.find(event => event.name === 'NoteOffEvent');
  assert.equal(converter.generatedNoteCount, 1);
  assert.equal(noteOff.delta, 192);
  assert.notEqual(midi.indexOf(Buffer.from('YM2608 #2 Ch3 Special Op1')), -1);
});

test('YM2608 integrated SSG converts tone and noise to separate tracks', () => {
  const converter = new MidiConverter({
    header: createHeader({ ym2608Clock: 8000000, ym2151Clock: 0 }),
    commands: [
      { type: 'chip_write', chip: 'YM2608', port: 0, register: 0x00, data: 0x1C },
      { type: 'chip_write', chip: 'YM2608', port: 0, register: 0x01, data: 0x01 },
      { type: 'chip_write', chip: 'YM2608', port: 0, register: 0x06, data: 0x04 },
      { type: 'chip_write', chip: 'YM2608', port: 0, register: 0x07, data: 0x36 },
      { type: 'chip_write', chip: 'YM2608', port: 0, register: 0x08, data: 0x0F },
      { type: 'wait', samples: 4410 },
      { type: 'chip_write', chip: 'YM2608', port: 0, register: 0x08, data: 0x00 },
      { type: 'end' },
    ],
  });

  const MidiWriter = require('midi-writer-js');
  const midi = Buffer.from(new MidiWriter.Writer(converter.convert()).buildFile());
  assert.notEqual(midi.indexOf(Buffer.from('YM2608 SSG 0')), -1);
  assert.notEqual(midi.indexOf(Buffer.from('YM2608 SSG Noise 0')), -1);
  assert.notEqual(midi.indexOf(Buffer.from([0x96, 69])), -1);
  assert.notEqual(midi.indexOf(Buffer.from([0x99, 42])), -1);
});

test('YM2608 rhythm key-on mask retriggers named General MIDI drums', () => {
  const converter = new MidiConverter({
    header: createHeader({ ym2608Clock: 8000000, ym2151Clock: 0 }),
    commands: [
      { type: 'chip_write', chip: 'YM2608', port: 0, register: 0x11, data: 0x3F },
      { type: 'chip_write', chip: 'YM2608', port: 0, register: 0x18, data: 0xDF },
      { type: 'chip_write', chip: 'YM2608', port: 0, register: 0x1B, data: 0xDF },
      { type: 'chip_write', chip: 'YM2608', port: 0, register: 0x10, data: 0x09 },
      { type: 'wait', samples: 2205 },
      { type: 'chip_write', chip: 'YM2608', port: 0, register: 0x10, data: 0x08 },
      { type: 'wait', samples: 2205 },
      { type: 'chip_write', chip: 'YM2608', port: 0, register: 0x10, data: 0x89 },
      { type: 'end' },
    ],
  });

  const tracks = converter.convert();
  const MidiWriter = require('midi-writer-js');
  const midi = Buffer.from(new MidiWriter.Writer(tracks).buildFile());
  assert.equal(converter.generatedNoteCount, 3);
  assert.notEqual(midi.indexOf(Buffer.from('YM2608 Rhythm Bass Drum')), -1);
  assert.notEqual(midi.indexOf(Buffer.from('YM2608 Rhythm Hi-Hat')), -1);
  assert.equal(tracks[0].events.filter(event => event.name === 'NoteOnEvent').length, 1);
  assert.equal(tracks[1].events.filter(event => event.name === 'NoteOnEvent').length, 2);
  assert.equal(tracks[0].events.find(event => event.name === 'NoteOnEvent').pitch, 36);
  assert.equal(tracks[1].events.find(event => event.name === 'NoteOnEvent').pitch, 42);
});

test('YM2608 ADPCM-B starts and retriggers a stable sample-identity track', () => {
  const converter = new MidiConverter({
    header: createHeader({ ym2608Clock: 8000000, ym2151Clock: 0 }),
    commands: [
      { type: 'chip_write', chip: 'YM2608', port: 1, register: 0x02, data: 0x34 },
      { type: 'chip_write', chip: 'YM2608', port: 1, register: 0x03, data: 0x12 },
      { type: 'chip_write', chip: 'YM2608', port: 1, register: 0x0B, data: 0xCC },
      { type: 'chip_write', chip: 'YM2608', port: 1, register: 0x00, data: 0x80 },
      { type: 'wait', samples: 2205 },
      { type: 'chip_write', chip: 'YM2608', port: 1, register: 0x00, data: 0x80 },
      { type: 'wait', samples: 2205 },
      { type: 'chip_write', chip: 'YM2608', port: 1, register: 0x00, data: 0x01 },
      { type: 'end' },
    ],
  });

  const tracks = converter.convert();
  const MidiWriter = require('midi-writer-js');
  const midi = Buffer.from(new MidiWriter.Writer(tracks).buildFile());
  assert.equal(converter.generatedNoteCount, 2);
  assert.notEqual(midi.indexOf(Buffer.from('YM2608 ADPCM-B Sample 0x1234')), -1);
  assert.equal(tracks[0].events.filter(event => event.name === 'NoteOnEvent').length, 2);
  assert.equal(tracks[0].events.filter(event => event.name === 'NoteOffEvent').length, 2);
  assert.equal(tracks[0].events.find(event => event.name === 'NoteOnEvent').pitch, 35);
});

test('SegaPCM repeated enabled control writes retrigger a sample percussion track', () => {
  const converter = new MidiConverter({
    header: createHeader({ ym2151Clock: 0, segaPCMClock: 4000000, segaPCMInterface: 12 }),
    commands: [
      { type: 'chip_write', chip: 'SegaPCM', register: 0x02, data: 0x40 },
      { type: 'chip_write', chip: 'SegaPCM', register: 0x03, data: 0x40 },
      { type: 'chip_write', chip: 'SegaPCM', register: 0x84, data: 0x2F },
      { type: 'chip_write', chip: 'SegaPCM', register: 0x85, data: 0x30 },
      { type: 'chip_write', chip: 'SegaPCM', register: 0x86, data: 0xC6 },
      { type: 'wait', samples: 4410 },
      { type: 'chip_write', chip: 'SegaPCM', register: 0x86, data: 0xC6 },
      { type: 'wait', samples: 4410 },
      { type: 'chip_write', chip: 'SegaPCM', register: 0x86, data: 0xC7 },
      { type: 'end' },
    ],
  });

  const tracks = converter.convert();
  const MidiWriter = require('midi-writer-js');
  const midi = Buffer.from(new MidiWriter.Writer(tracks).buildFile());
  assert.equal(tracks.length, 1);
  assert.notEqual(midi.indexOf(Buffer.from('SegaPCM Sample 0x')), -1);
  assert.equal(countSequence(midi, [0x99, 35]), 2);
  assert.equal(countSequence(midi, [0x89, 35]), 2);
});

test('SegaPCM pan is a single shared channel-10 state resent when a panned-away voice retriggers', () => {
  const converter = new MidiConverter({
    header: createHeader({ ym2151Clock: 0, segaPCMClock: 4000000, segaPCMInterface: 12 }),
    commands: [
      // Voice 0: fully left.
      { type: 'chip_write', chip: 'SegaPCM', register: 2, data: 0x7F },
      { type: 'chip_write', chip: 'SegaPCM', register: 3, data: 0x00 },
      { type: 'chip_write', chip: 'SegaPCM', register: 0x84, data: 0x00 },
      { type: 'chip_write', chip: 'SegaPCM', register: 0x85, data: 0x00 },
      { type: 'chip_write', chip: 'SegaPCM', register: 0x86, data: 0x00 },
      { type: 'wait', samples: 100 },
      // Voice 1: fully right, different sample address.
      { type: 'chip_write', chip: 'SegaPCM', register: 8 + 2, data: 0x00 },
      { type: 'chip_write', chip: 'SegaPCM', register: 8 + 3, data: 0x7F },
      { type: 'chip_write', chip: 'SegaPCM', register: 8 + 0x84, data: 0x10 },
      { type: 'chip_write', chip: 'SegaPCM', register: 8 + 0x85, data: 0x00 },
      { type: 'chip_write', chip: 'SegaPCM', register: 8 + 0x86, data: 0x00 },
      { type: 'wait', samples: 100 },
      // Voice 0 retriggers (disable then re-enable) without touching its own volume
      // registers — its own last-sent pan (left) hasn't changed from its perspective.
      { type: 'chip_write', chip: 'SegaPCM', register: 0x86, data: 0x01 },
      { type: 'chip_write', chip: 'SegaPCM', register: 0x86, data: 0x00 },
      { type: 'wait', samples: 100 },
      { type: 'end' },
    ],
  });

  const tracks = converter.convert();
  const voice0Track = tracks.find(t => t.events.filter(e => e.name === 'NoteOnEvent').length === 2);
  const secondNoteOnIndex = voice0Track.events.map(e => e.name).lastIndexOf('NoteOnEvent');
  // The event immediately before voice 0's second Note On must resend CC10=0 (full
  // left). Without shared per-channel state, a per-track "pan unchanged" cache would
  // have skipped this — channel 10 itself was repointed right by voice 1 in between,
  // even though voice 0's own pan value never changed.
  const precedingEvent = voice0Track.events[secondNoteOnIndex - 1];
  assert.equal(precedingEvent.name, 'ControllerChangeEvent');
  assert.equal(precedingEvent.controllerNumber, 10);
  assert.equal(precedingEvent.controllerValue, 0);
});

test('C140 mode key-on maps a sample identity to GM percussion', () => {
  const converter = new MidiConverter({
    header: createHeader({ ym2151Clock: 0, c140Clock: 12288000 }),
    commands: [
      { type: 'chip_write', chip: 'C140', register: 0x00, data: 0x40 },
      { type: 'chip_write', chip: 'C140', register: 0x01, data: 0x40 },
      { type: 'chip_write', chip: 'C140', register: 0x04, data: 0x12 },
      { type: 'chip_write', chip: 'C140', register: 0x06, data: 0x34 },
      { type: 'chip_write', chip: 'C140', register: 0x07, data: 0x56 },
      { type: 'chip_write', chip: 'C140', register: 0x05, data: 0x80 },
      { type: 'wait', samples: 4410 },
      { type: 'chip_write', chip: 'C140', register: 0x05, data: 0x00 },
      { type: 'end' },
    ],
  });

  const tracks = converter.convert();
  const MidiWriter = require('midi-writer-js');
  const midi = Buffer.from(new MidiWriter.Writer(tracks).buildFile());
  assert.equal(tracks.length, 1);
  assert.notEqual(midi.indexOf(Buffer.from('C140 Sample 0x123456')), -1);
  assert.equal(countSequence(midi, [0x99, 35]), 1);
  assert.equal(countSequence(midi, [0x89, 35]), 1);
});

test('C140 pan follows register 0=right / register 1=left, per MAME c140.cpp', () => {
  const converter = new MidiConverter({
    header: createHeader({ ym2151Clock: 0, c140Clock: 12288000 }),
    commands: [
      { type: 'chip_write', chip: 'C140', register: 0x00, data: 0x7F }, // Right volume = max.
      { type: 'chip_write', chip: 'C140', register: 0x01, data: 0x00 }, // Left volume = 0.
      { type: 'chip_write', chip: 'C140', register: 0x04, data: 0x12 },
      { type: 'chip_write', chip: 'C140', register: 0x06, data: 0x34 },
      { type: 'chip_write', chip: 'C140', register: 0x07, data: 0x56 },
      { type: 'chip_write', chip: 'C140', register: 0x05, data: 0x80 },
      { type: 'wait', samples: 100 },
      { type: 'end' },
    ],
  });

  const tracks = converter.convert();
  const pan = tracks[0].events.find(e => e.name === 'ControllerChangeEvent');
  assert.equal(pan.controllerNumber, 10);
  assert.equal(pan.controllerValue, 127); // Full right.
});

test('export refuses to create a 14-byte MIDI when no notes were generated', () => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgm2midi-test-'));
  const outputPath = path.join(tempDirectory, 'empty.mid');
  const converter = new MidiConverter({
    header: createHeader({ sn76489Clock: 3579545, ym2151Clock: 0 }),
    commands: [
      // Volume writes create controller state, but no tone period means no note.
      { type: 'psg_write', chip: 'SN76489', data: 0x9E },
      { type: 'psg_write', chip: 'SN76489', data: 0x9D },
      { type: 'end' },
    ],
  });

  assert.throws(
    () => converter.exportToFile(outputPath),
    /No MIDI notes were generated/
  );
  assert.equal(fs.existsSync(outputPath), false);
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});

test('HuC6280 volume zero does not create phantom notes', () => {
  const converter = new MidiConverter({
    header: createHeader({ ym2151Clock: 0, huc6280Clock: 3579545 }),
    commands: [
      { type: 'chip_write', chip: 'HuC6280', register: 0x00, data: 0x05 },
      { type: 'chip_write', chip: 'HuC6280', register: 0x02, data: 0x57 },
      { type: 'chip_write', chip: 'HuC6280', register: 0x03, data: 0x03 },
      { type: 'chip_write', chip: 'HuC6280', register: 0x04, data: 0x80 },
      { type: 'wait', samples: 44100 },
      { type: 'chip_write', chip: 'HuC6280', register: 0x04, data: 0x00 },
      { type: 'end' },
    ],
  });

  assert.equal(converter.convert().length, 0);
});

test('HuC6280 masks the dual-chip flag and keeps the second chip independent', () => {
  function toneTrack(clock, instance) {
    const converter = new MidiConverter({
      header: createHeader({ ym2151Clock: 0, huc6280Clock: clock }),
      commands: [
        { type: 'chip_write', chip: 'HuC6280', instance, register: 0x00, data: 0x00 },
        { type: 'chip_write', chip: 'HuC6280', instance, register: 0x02, data: 0xFE },
        { type: 'chip_write', chip: 'HuC6280', instance, register: 0x03, data: 0x00 },
        { type: 'chip_write', chip: 'HuC6280', instance, register: 0x04, data: 0x9F },
        { type: 'wait', samples: 4410 },
        { type: 'end' },
      ],
    });
    return converter.convert()[0];
  }

  const primaryNote = toneTrack(3579545, 0).events.find(event => event.name === 'NoteOnEvent').pitch;
  const flaggedNote = toneTrack(0x40000000 + 3579545, 0).events.find(event => event.name === 'NoteOnEvent').pitch;
  assert.equal(flaggedNote, primaryNote);

  const secondTrack = toneTrack(0x40000000 + 3579545, 1);
  const trackName = secondTrack.events.find(event => event.name === 'TrackNameEvent').text;
  assert.equal(trackName, 'HuC6280 #2 PSG 0');
});

test('HuC6280 coalesces one-frame split writes but not unrelated later writes', () => {
  function noteOnCount(splitWait) {
    const converter = new MidiConverter({
      header: createHeader({ ym2151Clock: 0, huc6280Clock: 3579545 }),
      commands: [
        { type: 'chip_write', chip: 'HuC6280', register: 0x00, data: 0x00 },
        { type: 'chip_write', chip: 'HuC6280', register: 0x02, data: 0x50 },
        { type: 'chip_write', chip: 'HuC6280', register: 0x03, data: 0x01 },
        { type: 'chip_write', chip: 'HuC6280', register: 0x04, data: 0x9F },
        { type: 'wait', samples: 100 },
        { type: 'chip_write', chip: 'HuC6280', register: 0x03, data: 0x02 },
        { type: 'wait', samples: splitWait },
        { type: 'chip_write', chip: 'HuC6280', register: 0x02, data: 0x80 },
        { type: 'wait', samples: 100 },
        { type: 'end' },
      ],
    });
    converter.convert();
    return converter.generatedNoteCount;
  }

  assert.equal(noteOnCount(735), 1);
  assert.equal(noteOnCount(883), 1);
});

test('HuC6280 noise mode maps to GM percussion across channel enable writes', () => {
  const converter = new MidiConverter({
    header: createHeader({ ym2151Clock: 0, huc6280Clock: 3579545 }),
    commands: [
      { type: 'chip_write', chip: 'HuC6280', register: 0x00, data: 0x04 },
      { type: 'chip_write', chip: 'HuC6280', register: 0x02, data: 0x57 },
      { type: 'chip_write', chip: 'HuC6280', register: 0x03, data: 0x03 },
      { type: 'chip_write', chip: 'HuC6280', register: 0x07, data: 0x80 },
      { type: 'chip_write', chip: 'HuC6280', register: 0x04, data: 0x9F },
      { type: 'wait', samples: 44100 },
      { type: 'chip_write', chip: 'HuC6280', register: 0x04, data: 0x00 },
      { type: 'chip_write', chip: 'HuC6280', register: 0x04, data: 0x9F },
      { type: 'end' },
    ],
  });

  const tracks = converter.convert();
  assert.equal(tracks.length, 1);

  const MidiWriter = require('midi-writer-js');
  const midi = Buffer.from(new MidiWriter.Writer(tracks).buildFile());
  assert.notEqual(midi.indexOf(Buffer.from('HuC6280 Noise 4')), -1);
  // reg $07 = 0x80 leaves the 5-bit rate field at 0 (lowest rate on real hardware),
  // which maps to the low drum band (45 Low Tom) rather than the old fixed 42.
  assert.notEqual(midi.indexOf(Buffer.from([0x99, 45, 127])), -1);
  assert.notEqual(midi.indexOf(Buffer.from([0x89, 45])), -1);
});

test('HuC6280 noise retriggers on an envelope reset but not a small volume rise', () => {
  const converter = new MidiConverter({
    header: createHeader({ ym2151Clock: 0, huc6280Clock: 3579545 }),
    commands: [
      { type: 'chip_write', chip: 'HuC6280', register: 0x00, data: 0x04 },
      { type: 'chip_write', chip: 'HuC6280', register: 0x07, data: 0x80 },
      { type: 'chip_write', chip: 'HuC6280', register: 0x04, data: 0x89 },
      { type: 'wait', samples: 4410 },
      { type: 'chip_write', chip: 'HuC6280', register: 0x04, data: 0x8C },
      { type: 'wait', samples: 4410 },
      { type: 'chip_write', chip: 'HuC6280', register: 0x04, data: 0x89 },
      { type: 'wait', samples: 4410 },
      { type: 'chip_write', chip: 'HuC6280', register: 0x04, data: 0x9D },
      { type: 'wait', samples: 4410 },
      { type: 'chip_write', chip: 'HuC6280', register: 0x04, data: 0x00 },
      { type: 'end' },
    ],
  });

  const tracks = converter.convert();
  assert.equal(tracks.length, 1);

  const MidiWriter = require('midi-writer-js');
  const midi = Buffer.from(new MidiWriter.Writer(tracks).buildFile());
  // reg $07 = 0x80 leaves the rate field at 0, mapping to 45 (Low Tom) rather than 42.
  assert.equal(countSequence(midi, [0x99, 45]), 2);
  assert.equal(countSequence(midi, [0x89, 45]), 2);
});

test('HuC6280 noise rate change re-evaluates an already-sounding noise note', () => {
  const converter = new MidiConverter({
    header: createHeader({ ym2151Clock: 0, huc6280Clock: 3579545 }),
    commands: [
      { type: 'chip_write', chip: 'HuC6280', register: 0x00, data: 0x04 },
      { type: 'chip_write', chip: 'HuC6280', register: 0x07, data: 0x80 }, // Rate 0 (slowest) -> 45.
      { type: 'chip_write', chip: 'HuC6280', register: 0x04, data: 0x9F }, // Enable + volume 31 -> trigger.
      { type: 'wait', samples: 4410 },
      // Rate changes while noise is still active (no intervening $04 off/on) must still
      // retrigger once the drum band actually changes.
      { type: 'chip_write', chip: 'HuC6280', register: 0x07, data: 0x80 | 0x1F }, // Rate 31 (fastest) -> 42.
      { type: 'wait', samples: 4410 },
      { type: 'end' },
    ],
  });

  const tracks = converter.convert();
  const noiseTrack = tracks.find(t => t.events.some(e => e.name === 'TrackNameEvent'));
  const notes = noiseTrack.events.filter(e => e.name === 'NoteOnEvent').map(e => e.pitch);
  assert.deepEqual(notes, [45, 42]);
});

test('YM3812 converts OPL F-Number, block and carrier TL to note and velocity', () => {
  const { converter, tracks } = convertOPLCommands('YM3812', [
    oplWrite('YM3812', 0x43, 0x10),
    oplWrite('YM3812', 0xA0, 0x44),
    oplWrite('YM3812', 0xB0, 0x32),
    { type: 'wait', samples: 4410 },
    oplWrite('YM3812', 0xB0, 0x12),
  ]);
  const noteOn = tracks[0].events.find(event => event.name === 'NoteOnEvent');
  const trackName = tracks[0].events.find(event => event.name === 'TrackNameEvent');
  assert.equal(converter.generatedNoteCount, 1);
  assert.equal(noteOn.pitch, 69);
  assert.equal(noteOn.velocity, 79);
  assert.equal(trackName.text, 'YM3812 FM 0');
});

test('OPL repeated key-on writes bend pitch without retriggering', () => {
  const { converter, tracks } = convertOPLCommands('YM3812', [
    oplWrite('YM3812', 0xA0, 0x44),
    oplWrite('YM3812', 0xB0, 0x32),
    { type: 'wait', samples: 100 },
    oplWrite('YM3812', 0xB0, 0x33),
  ]);
  const pitchBends = tracks[0].events.filter(event => event.name === 'PitchBendEvent');
  assert.equal(converter.generatedNoteCount, 1);
  assert.ok(pitchBends.length >= 2);
});

test('OPL key-before-LSB order defers Note On until the complete F-Number', () => {
  const { converter, midi } = convertOPLCommands('YM3812', [
    oplWrite('YM3812', 0xB0, 0x32),
    oplWrite('YM3812', 0xA0, 0x44),
  ]);
  assert.equal(converter.generatedNoteCount, 1);
  assert.notEqual(midi.indexOf(Buffer.from([0x90, 69])), -1);
  assert.equal(midi.indexOf(Buffer.from([0x90, 67])), -1);
});

test('OPL LSB-high split writes emit one final pitch bend without an intermediate jump', () => {
  const { tracks } = convertOPLCommands('YM3812', [
    oplWrite('YM3812', 0xA0, 0x44),
    oplWrite('YM3812', 0xB0, 0x32),
    { type: 'wait', samples: 100 },
    oplWrite('YM3812', 0xA0, 0x45),
    oplWrite('YM3812', 0xB0, 0x32),
  ]);
  assert.equal(tracks[0].events.filter(event => event.name === 'PitchBendEvent').length, 2);
});

test('OPL carrier TL changes update expression while a note is active', () => {
  const { converter, tracks } = convertOPLCommands('YM3812', [
    oplWrite('YM3812', 0x43, 0x00),
    oplWrite('YM3812', 0xA0, 0x44),
    oplWrite('YM3812', 0xB0, 0x32),
    { type: 'wait', samples: 100 },
    oplWrite('YM3812', 0x43, 0x20),
  ]);
  const expression = tracks[0].events.find(event =>
    event.name === 'ControllerChangeEvent' && event.controllerNumber === 11
  );
  assert.equal(converter.generatedNoteCount, 1);
  assert.ok(expression.controllerValue < 127);
});

test('OPL CNT=1 exposes both carriers when deriving velocity', () => {
  const velocityForConnection = connection => convertOPLCommands('YM3812', [
    oplWrite('YM3812', 0x40, 0x00),
    oplWrite('YM3812', 0x43, 0x20),
    oplWrite('YM3812', 0xC0, connection),
    oplWrite('YM3812', 0xA0, 0x44),
    oplWrite('YM3812', 0xB0, 0x32),
  ]).tracks.flatMap(track => track.events).find(event => event.name === 'NoteOnEvent').velocity;
  assert.ok(velocityForConnection(1) > velocityForConnection(0));
});

test('OPL rhythm mode maps all five voices to General MIDI percussion', () => {
  const { converter, midi } = convertOPLCommands('YM3812', [oplWrite('YM3812', 0xBD, 0x3F)]);
  assert.equal(converter.generatedNoteCount, 5);
  for (const note of [36, 42, 38, 45, 49]) {
    assert.notEqual(midi.indexOf(Buffer.from([0x99, note])), -1, `missing GM rhythm note ${note}`);
  }
  assert.notEqual(midi.indexOf(Buffer.from('YM3812 Rhythm Bass Drum')), -1);
});

test('OPL rhythm mode entry closes melodic channels 6-8', () => {
  const { tracks } = convertOPLCommands('YM3812', [
    oplWrite('YM3812', 0xA6, 0x44),
    oplWrite('YM3812', 0xB6, 0x32),
    { type: 'wait', samples: 100 },
    oplWrite('YM3812', 0xBD, 0x20),
  ]);
  const melodic = tracks.find(track =>
    track.events.some(event => event.name === 'TrackNameEvent' && event.text === 'YM3812 FM 6')
  );
  assert.equal(melodic.events.filter(event => event.name === 'NoteOffEvent').length, 1);
});

test('OPL rhythm mode exit closes active percussion voices', () => {
  const { tracks } = convertOPLCommands('YM3812', [
    oplWrite('YM3812', 0xBD, 0x30),
    { type: 'wait', samples: 100 },
    oplWrite('YM3812', 0xBD, 0x00),
  ]);
  const rhythm = tracks.find(track =>
    track.events.some(event => event.name === 'TrackNameEvent' && event.text === 'YM3812 Rhythm Bass Drum')
  );
  assert.equal(rhythm.events.filter(event => event.name === 'NoteOffEvent').length, 1);
});

test('OPL melodic key-on is ignored for channels 6-8 during rhythm mode', () => {
  const { converter } = convertOPLCommands('YM3812', [
    oplWrite('YM3812', 0xBD, 0x20),
    oplWrite('YM3812', 0xA6, 0x44),
    oplWrite('YM3812', 0xB6, 0x32),
  ]);
  assert.equal(converter.generatedNoteCount, 0);
});

test('OPL repeated rhythm bits do not retrigger percussion', () => {
  const { converter } = convertOPLCommands('YM3812', [
    oplWrite('YM3812', 0xBD, 0x30),
    { type: 'wait', samples: 100 },
    oplWrite('YM3812', 0xBD, 0x30),
  ]);
  assert.equal(converter.generatedNoteCount, 1);
});

test('YM3526 and Y8950 use independent OPL track identities', () => {
  for (const chip of ['YM3526', 'Y8950']) {
    const { tracks } = convertOPLCommands(chip, [
      oplWrite(chip, 0xA0, 0x44),
      oplWrite(chip, 0xB0, 0x32),
    ]);
    assert.equal(tracks[0].events.find(event => event.name === 'TrackNameEvent').text, `${chip} FM 0`);
  }
});

test('dual OPL instances keep state separate and route instance two from MIDI channel 11', () => {
  const { converter, midi } = convertOPLCommands('YM3812', [
    oplWrite('YM3812', 0xA0, 0x44, 0),
    oplWrite('YM3812', 0xB0, 0x32, 0),
    oplWrite('YM3812', 0xA0, 0x44, 1),
    oplWrite('YM3812', 0xB0, 0x32, 1),
  ]);
  assert.equal(converter.generatedNoteCount, 2);
  assert.notEqual(midi.indexOf(Buffer.from([0x90, 69])), -1);
  assert.notEqual(midi.indexOf(Buffer.from([0x9A, 69])), -1);
  assert.notEqual(midi.indexOf(Buffer.from('YM3812 #2 FM 0')), -1);
});

test('OPL shared MULTIPLE=2 applies octave-only pitch correction', () => {
  const { midi } = convertOPLCommands('YM3812', [
    oplWrite('YM3812', 0x20, 0x02),
    oplWrite('YM3812', 0x23, 0x02),
    oplWrite('YM3812', 0xA0, 0x44),
    oplWrite('YM3812', 0xB0, 0x32),
  ]);
  assert.notEqual(midi.indexOf(Buffer.from([0x90, 81])), -1);
});

test('OPL MULTIPLE register 11 remains uncorrected because it is not a power of two', () => {
  const { midi } = convertOPLCommands('YM3812', [
    oplWrite('YM3812', 0x20, 0x0B),
    oplWrite('YM3812', 0x23, 0x0B),
    oplWrite('YM3812', 0xA0, 0x44),
    oplWrite('YM3812', 0xB0, 0x32),
  ]);
  assert.notEqual(midi.indexOf(Buffer.from([0x90, 69])), -1);
});

test('YM2413 converts a normal FM channel from fnum/block and 4-bit volume', () => {
  const { converter, midi } = convertYM2413Commands([
    { type: 'chip_write', chip: 'YM2413', port: 0, register: 0x10, data: 0x50 },
    { type: 'chip_write', chip: 'YM2413', port: 0, register: 0x30, data: 0x03 }, // instrument (ignored) + volume=3
    { type: 'chip_write', chip: 'YM2413', port: 0, register: 0x20, data: 0x11 }, // block=0, fnum msb=1, key on
    { type: 'wait', samples: 4410 },
    { type: 'chip_write', chip: 'YM2413', port: 0, register: 0x20, data: 0x01 }, // key off
  ]);

  assert.equal(converter.generatedNoteCount, 1);
  // fnum=0x150(336), block=0, clock=3579545 -> ~31.9Hz -> MIDI note 24. MIDI channel 5
  // (0-based 4, ym2413_0 -> midiChannelForKey() channel 0 < 5 -> 0+5).
  assert.notEqual(midi.indexOf(Buffer.from([0x94, 24])), -1);
});

test('YM2413 split F-Number writes do not emit intermediate phantom notes', () => {
  const { converter } = convertYM2413Commands([
    { type: 'chip_write', chip: 'YM2413', port: 0, register: 0x10, data: 0x50 },
    { type: 'chip_write', chip: 'YM2413', port: 0, register: 0x20, data: 0x11 }, // key on: block=0, msb=1 -> fnum 0x150 (336)
    { type: 'wait', samples: 4410 },
    // Re-send $20 unchanged immediately before $10, exercising the $20->$10 split-write
    // guard without changing the final pitch enough to trigger a retrigger — if the guard
    // failed and $20 alone (still combined with the pre-write freqLSB) briefly produced a
    // spurious intermediate pitch read, that would still show up as an extra note here.
    { type: 'chip_write', chip: 'YM2413', port: 0, register: 0x20, data: 0x11 },
    { type: 'chip_write', chip: 'YM2413', port: 0, register: 0x10, data: 0x55 }, // fnum -> 0x155 (341), a few cents up
    { type: 'wait', samples: 4410 },
    { type: 'chip_write', chip: 'YM2413', port: 0, register: 0x20, data: 0x01 }, // key off
  ]);

  assert.equal(converter.generatedNoteCount, 1);
});

test('YM2413 normal LSB-then-key order commits the complete F-Number', () => {
  const { converter, midi } = convertYM2413Commands([
    { type: 'chip_write', chip: 'YM2413', register: 0x10, data: 0x50 },
    { type: 'chip_write', chip: 'YM2413', register: 0x20, data: 0x11 },
  ]);
  assert.equal(converter.generatedNoteCount, 1);
  assert.notEqual(midi.indexOf(Buffer.from([0x94, 24])), -1);
});

test('YM2413 key-then-LSB order defers Note On until the current LSB is available', () => {
  const { converter, midi } = convertYM2413Commands([
    { type: 'chip_write', chip: 'YM2413', register: 0x10, data: 0x00 }, // stale previous LSB
    { type: 'chip_write', chip: 'YM2413', register: 0x20, data: 0x11 }, // key + MSB first
    { type: 'chip_write', chip: 'YM2413', register: 0x10, data: 0x50 }, // final LSB commits key-on
  ]);
  assert.equal(converter.generatedNoteCount, 1);
  assert.notEqual(midi.indexOf(Buffer.from([0x94, 24])), -1);
  assert.equal(midi.indexOf(Buffer.from([0x94, 20])), -1);
});

test('YM2413 built-in and custom carrier powers of two apply octave-only correction', () => {
  const builtIn = convertYM2413Commands([
    { type: 'chip_write', chip: 'YM2413', register: 0x10, data: 0x50 },
    { type: 'chip_write', chip: 'YM2413', register: 0x30, data: 0x60 }, // built-in patch 6 carrier MULTI=2
    { type: 'chip_write', chip: 'YM2413', register: 0x20, data: 0x11 },
  ]).midi;
  const custom = convertYM2413Commands([
    { type: 'chip_write', chip: 'YM2413', register: 0x01, data: 0x02 }, // custom carrier MULTI=2
    { type: 'chip_write', chip: 'YM2413', register: 0x10, data: 0x50 },
    { type: 'chip_write', chip: 'YM2413', register: 0x30, data: 0x00 }, // select custom patch 0
    { type: 'chip_write', chip: 'YM2413', register: 0x20, data: 0x11 },
  ]).midi;
  assert.notEqual(builtIn.indexOf(Buffer.from([0x94, 36])), -1);
  assert.notEqual(custom.indexOf(Buffer.from([0x94, 36])), -1);
});

test('dual YM2413 instances retain independent patch pitch correction', () => {
  const converter = new MidiConverter({
    header: createHeader({ ym2413Clock: 3579545, ym2151Clock: 0 }),
    commands: [
      { type: 'chip_write', chip: 'YM2413', instance: 0, register: 0x10, data: 0x50 },
      { type: 'chip_write', chip: 'YM2413', instance: 0, register: 0x30, data: 0x00 },
      { type: 'chip_write', chip: 'YM2413', instance: 0, register: 0x20, data: 0x11 },
      { type: 'chip_write', chip: 'YM2413', instance: 1, register: 0x10, data: 0x50 },
      { type: 'chip_write', chip: 'YM2413', instance: 1, register: 0x30, data: 0x60 },
      { type: 'chip_write', chip: 'YM2413', instance: 1, register: 0x20, data: 0x11 }, { type: 'end' },
    ],
  });
  const notes = converter.convert().flatMap(track => track.events.filter(event => event.name === 'NoteOnEvent').map(event => event.pitch));
  assert.deepEqual(notes.sort((left, right) => left - right), [24, 36]);
});

test('YM2413 built-in carrier Multiple table preserves all libvgm preset source bytes', () => {
  assert.deepEqual([...YM2413_BUILTIN_CARRIER_REGISTER_BYTES], [
    0x00, 0x61, 0x41, 0x01, 0x61, 0x21, 0x22, 0x61,
    0x21, 0x61, 0x61, 0x01, 0xC1, 0x50, 0x01, 0x41,
  ]);
  assert.deepEqual([...YM2413_BUILTIN_CARRIER_MULTIPLES], [
    0, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 0, 1, 1,
  ]);
  assert.deepEqual(
    [...YM2413_BUILTIN_CARRIER_MULTIPLES],
    YM2413_BUILTIN_CARRIER_REGISTER_BYTES.map(register => register & 0x0F)
  );
});

test('YM2413 and GBDMG mask every header clock flag without changing pitch', () => {
  const ym2413NoteForClock = clock => {
    const converter = new MidiConverter({
      header: createHeader({ ym2413Clock: clock, ym2151Clock: 0 }),
      commands: [
        { type: 'chip_write', chip: 'YM2413', register: 0x10, data: 0x50 },
        { type: 'chip_write', chip: 'YM2413', register: 0x20, data: 0x11 }, { type: 'end' },
      ],
    });
    return converter.convert().flatMap(track => track.events)
      .find(event => event.name === 'NoteOnEvent').pitch;
  };
  const gbDmgNoteForClock = clock => {
    const converter = new MidiConverter({
      header: createHeader({ gbDmgClock: clock, ym2151Clock: 0 }),
      commands: [
        { type: 'chip_write', chip: 'GBDMG', register: 0x02, data: 0xF8 },
        { type: 'chip_write', chip: 'GBDMG', register: 0x03, data: 0xD6 },
        { type: 'chip_write', chip: 'GBDMG', register: 0x04, data: 0x86 }, { type: 'end' },
      ],
    });
    return converter.convert().flatMap(track => track.events)
      .find(event => event.name === 'NoteOnEvent').pitch;
  };

  for (const flag of [0x40000000, 0x80000000, 0xC0000000]) {
    assert.equal(ym2413NoteForClock(3579545), ym2413NoteForClock(3579545 + flag));
    assert.equal(gbDmgNoteForClock(4194304), gbDmgNoteForClock(4194304 + flag));
  }
});

test('YM2413 second reverse key-on ignores an interleaved primary LSB', () => {
  const converter = new MidiConverter({
    header: createHeader({ ym2413Clock: 3579545, ym2151Clock: 0 }),
    commands: [
      { type: 'chip_write', chip: 'YM2413', instance: 1, register: 0x10, data: 0x50 },
      { type: 'chip_write', chip: 'YM2413', instance: 1, register: 0x20, data: 0x11 },
      // This is the primary chip's LSB, not the pending second chip's companion byte.
      { type: 'chip_write', chip: 'YM2413', instance: 0, register: 0x10, data: 0x22 },
      { type: 'end' },
    ],
  });

  assert.equal(converter.convert().flatMap(track => track.events)
    .filter(event => event.name === 'NoteOnEvent').length, 1);
});

test('interleaved YM2612 and GBDMG frequency pairs emit one post-update pitch bend', () => {
  const ym2612 = new MidiConverter({
    header: createHeader({ ym2612Clock: 7670453, ym2151Clock: 0 }),
    commands: [
      { type: 'chip_write', chip: 'YM2612', instance: 1, port: 0, register: 0xA4, data: 0x22 },
      { type: 'chip_write', chip: 'YM2612', instance: 1, port: 0, register: 0xA0, data: 0x10 },
      { type: 'chip_write', chip: 'YM2612', instance: 1, port: 0, register: 0x28, data: 0xF0 },
      { type: 'wait', samples: 100 },
      { type: 'chip_write', chip: 'YM2612', instance: 1, port: 0, register: 0xA4, data: 0x23 },
      { type: 'chip_write', chip: 'YM2612', instance: 0, port: 0, register: 0xA0, data: 0x44 },
      { type: 'chip_write', chip: 'YM2612', instance: 1, port: 0, register: 0xA0, data: 0x20 },
      { type: 'end' },
    ],
  });
  const gbDmg = new MidiConverter({
    header: createHeader({ gbDmgClock: 4194304, ym2151Clock: 0 }),
    commands: [
      { type: 'chip_write', chip: 'GBDMG', instance: 1, register: 0x02, data: 0xF8 },
      { type: 'chip_write', chip: 'GBDMG', instance: 1, register: 0x03, data: 0xD6 },
      { type: 'chip_write', chip: 'GBDMG', instance: 1, register: 0x04, data: 0x86 },
      { type: 'wait', samples: 100 },
      { type: 'chip_write', chip: 'GBDMG', instance: 1, register: 0x03, data: 0xE6 },
      { type: 'chip_write', chip: 'GBDMG', instance: 0, register: 0x04, data: 0x03 },
      { type: 'chip_write', chip: 'GBDMG', instance: 1, register: 0x04, data: 0x06 },
      { type: 'end' },
    ],
  });

  for (const converter of [ym2612, gbDmg]) {
    const track = converter.convert().find(candidate =>
      candidate.events.some(event => event.name === 'NoteOnEvent')
    );
    assert.equal(track.events.filter(event => event.name === 'PitchBendEvent').length, 2);
  }
});

test('YM2413 rhythm routing ignores reverse-order channel 6 key writes', () => {
  const { converter } = convertYM2413Commands([
    { type: 'chip_write', chip: 'YM2413', register: 0x0E, data: 0x30 }, // rhythm on + BD
    { type: 'chip_write', chip: 'YM2413', register: 0x26, data: 0x11 }, // key/MSB before LSB: still ignored
    { type: 'chip_write', chip: 'YM2413', register: 0x16, data: 0x50 },
  ]);
  assert.equal(converter.generatedNoteCount, 1);
  assert.equal(converter.channels.get('ym2413_6').active, false);
});

test('YM2413 rhythm mode converts all five percussion voices independently', () => {
  const { converter, midi } = convertYM2413Commands([
    { type: 'chip_write', chip: 'YM2413', port: 0, register: 0x36, data: 0x00 },
    { type: 'chip_write', chip: 'YM2413', port: 0, register: 0x37, data: 0x00 },
    { type: 'chip_write', chip: 'YM2413', port: 0, register: 0x38, data: 0x00 },
    { type: 'chip_write', chip: 'YM2413', port: 0, register: 0x0E, data: 0x3F }, // rhythm on + all 5 keys on
    { type: 'wait', samples: 4410 },
    { type: 'chip_write', chip: 'YM2413', port: 0, register: 0x0E, data: 0x20 }, // all keys off
  ]);

  assert.equal(converter.generatedNoteCount, 5);
  // GM_PERCUSSION_CHANNEL=10 -> NoteOnEvent status 0x99 (0x90 | (10-1)).
  assert.notEqual(midi.indexOf(Buffer.from([0x99, 36])), -1); // BD
  assert.notEqual(midi.indexOf(Buffer.from([0x99, 42])), -1); // HH
  assert.notEqual(midi.indexOf(Buffer.from([0x99, 38])), -1); // SD
  assert.notEqual(midi.indexOf(Buffer.from([0x99, 45])), -1); // TOM
  assert.notEqual(midi.indexOf(Buffer.from([0x99, 49])), -1); // CYM
});

test('YM2413 rhythm key bits trigger and release independently', () => {
  const { converter } = convertYM2413Commands([
    { type: 'chip_write', chip: 'YM2413', port: 0, register: 0x0E, data: 0x20 }, // rhythm mode on, no keys
    { type: 'chip_write', chip: 'YM2413', port: 0, register: 0x0E, data: 0x21 }, // HH on only
    { type: 'wait', samples: 2205 },
    { type: 'chip_write', chip: 'YM2413', port: 0, register: 0x0E, data: 0x24 }, // HH off, TOM on
    { type: 'wait', samples: 2205 },
    { type: 'chip_write', chip: 'YM2413', port: 0, register: 0x0E, data: 0x20 }, // TOM off
  ]);

  assert.equal(converter.generatedNoteCount, 2);
});

test('YM2413 mode switch closes an active channel 6 voice before entering rhythm mode', () => {
  const { converter } = convertYM2413Commands([
    { type: 'chip_write', chip: 'YM2413', port: 0, register: 0x16, data: 0x50 },
    { type: 'chip_write', chip: 'YM2413', port: 0, register: 0x26, data: 0x11 }, // key on channel 6
    { type: 'wait', samples: 2205 },
    { type: 'chip_write', chip: 'YM2413', port: 0, register: 0x0E, data: 0x20 }, // enter rhythm mode, no percussion keys
  ]);

  assert.equal(converter.channels.get('ym2413_6').active, false);
});

test('YM2413 channel 6-8 key-on is ignored while rhythm mode is active', () => {
  const { converter } = convertYM2413Commands([
    { type: 'chip_write', chip: 'YM2413', port: 0, register: 0x0E, data: 0x20 }, // rhythm mode on, no percussion keys
    { type: 'chip_write', chip: 'YM2413', port: 0, register: 0x16, data: 0x50 },
    { type: 'chip_write', chip: 'YM2413', port: 0, register: 0x26, data: 0x11 }, // ch6 key-on bit, ignored in rhythm mode
    { type: 'wait', samples: 4410 },
  ]);

  assert.equal(converter.generatedNoteCount, 0);
  assert.equal(converter.channels.get('ym2413_6').active, false);
});

test('YM2413 rhythm volume changes reflect on an already-sounding voice as expression', () => {
  const { converter, midi } = convertYM2413Commands([
    { type: 'chip_write', chip: 'YM2413', port: 0, register: 0x36, data: 0x00 }, // BD volume=0 (loudest)
    { type: 'chip_write', chip: 'YM2413', port: 0, register: 0x0E, data: 0x30 }, // rhythm on, BD key on
    { type: 'wait', samples: 2205 },
    { type: 'chip_write', chip: 'YM2413', port: 0, register: 0x36, data: 0x0F }, // BD volume=15 (quietest) mid-note
    { type: 'wait', samples: 2205 },
  ]);

  assert.equal(converter.generatedNoteCount, 1);
  // ControllerChangeEvent for expression (CC 11) on the percussion channel (0-based 9).
  assert.notEqual(midi.indexOf(Buffer.from([0xB9, 0x0B])), -1);
});

test('GameBoy DMG converts a pulse channel trigger with envelope-derived velocity', () => {
  const { converter, midi } = convertGBDMGCommands([
    { type: 'chip_write', chip: 'GBDMG', port: 0, register: 0x02, data: 0xF8 }, // envelope: initial vol=15, dir=up
    { type: 'chip_write', chip: 'GBDMG', port: 0, register: 0x03, data: 1750 & 0xFF },
    { type: 'chip_write', chip: 'GBDMG', port: 0, register: 0x04, data: 0x80 | ((1750 >> 8) & 0x07) }, // trigger
    { type: 'wait', samples: 4410 },
    { type: 'chip_write', chip: 'GBDMG', port: 0, register: 0x02, data: 0x00 }, // DAC off
  ]);

  assert.equal(converter.generatedNoteCount, 1);
  // period=1750, clock=4194304 -> freq=clock/(32*(2048-1750))=~442Hz -> MIDI note 69 (A4).
  // MIDI channel 1 (0x90, 0-based channel 0).
  assert.notEqual(midi.indexOf(Buffer.from([0x90, 69])), -1);
  assert.equal(converter.channels.get('gbdmg_0').active, false);
});

test('GameBoy DMG DAC-off immediately silences an active pulse voice', () => {
  const { converter, midi } = convertGBDMGCommands([
    { type: 'chip_write', chip: 'GBDMG', port: 0, register: 0x02, data: 0xF8 },
    { type: 'chip_write', chip: 'GBDMG', port: 0, register: 0x03, data: 1750 & 0xFF },
    { type: 'chip_write', chip: 'GBDMG', port: 0, register: 0x04, data: 0x80 | ((1750 >> 8) & 0x07) },
    { type: 'wait', samples: 4410 },
    { type: 'chip_write', chip: 'GBDMG', port: 0, register: 0x02, data: 0x00 }, // envelope upper 5 bits all zero -> DAC off
    { type: 'wait', samples: 4410 },
  ]);

  assert.equal(converter.channels.get('gbdmg_0').active, false);
  assert.notEqual(midi.indexOf(Buffer.from([0x80, 69])), -1); // NoteOffEvent, 0-based channel 0
});

test('GameBoy DMG a trigger while the DAC is disabled produces no note', () => {
  const { converter } = convertGBDMGCommands([
    { type: 'chip_write', chip: 'GBDMG', port: 0, register: 0x02, data: 0x00 }, // vol=0, dir=down -> DAC off
    { type: 'chip_write', chip: 'GBDMG', port: 0, register: 0x03, data: 1750 & 0xFF },
    { type: 'chip_write', chip: 'GBDMG', port: 0, register: 0x04, data: 0x80 | ((1750 >> 8) & 0x07) }, // trigger
    { type: 'wait', samples: 4410 },
  ]);

  assert.equal(converter.generatedNoteCount, 0);
});

test('GameBoy DMG wave channel uses NR30 DAC enable and NR32 output level', () => {
  const { converter, midi } = convertGBDMGCommands([
    { type: 'chip_write', chip: 'GBDMG', port: 0, register: 0x0A, data: 0x80 }, // NR30 DAC on
    { type: 'chip_write', chip: 'GBDMG', port: 0, register: 0x0C, data: 0x20 }, // NR32 output level=1 (100%)
    { type: 'chip_write', chip: 'GBDMG', port: 0, register: 0x0D, data: 1750 & 0xFF },
    { type: 'chip_write', chip: 'GBDMG', port: 0, register: 0x0E, data: 0x80 | ((1750 >> 8) & 0x07) },
    { type: 'wait', samples: 4410 },
    { type: 'chip_write', chip: 'GBDMG', port: 0, register: 0x0A, data: 0x00 }, // NR30 DAC off
  ]);

  assert.equal(converter.generatedNoteCount, 1);
  // The wave channel's period-to-Hz formula halves the pulse channels' rate at the same
  // period, one octave lower -> MIDI note 57 instead of 69. MIDI channel 3 (0x92 = 0x90|2).
  assert.notEqual(midi.indexOf(Buffer.from([0x92, 57])), -1);
  assert.equal(converter.channels.get('gbdmg_2').active, false);
});

test('GameBoy DMG noise channel triggers and re-evaluates rate changes', () => {
  const { converter, midi } = convertGBDMGCommands([
    { type: 'chip_write', chip: 'GBDMG', port: 0, register: 0x11, data: 0xF0 }, // envelope initial vol=15
    { type: 'chip_write', chip: 'GBDMG', port: 0, register: 0x12, data: 0x00 }, // shift=0, r=0(->0.5): highest rate
    { type: 'chip_write', chip: 'GBDMG', port: 0, register: 0x13, data: 0x80 }, // trigger
    { type: 'wait', samples: 2205 },
    { type: 'chip_write', chip: 'GBDMG', port: 0, register: 0x12, data: 0xF7 }, // shift=15, r=7: lowest rate
    { type: 'wait', samples: 2205 },
  ]);

  assert.equal(converter.generatedNoteCount, 2); // initial trigger + retrigger on drum-band change
  // GM_PERCUSSION_CHANNEL=10 -> NoteOnEvent status 0x99 (0x90 | (10-1)).
  assert.notEqual(midi.indexOf(Buffer.from([0x99, 42])), -1); // high band
  assert.notEqual(midi.indexOf(Buffer.from([0x99, 45])), -1); // low band
});

test('GameBoy DMG split frequency writes do not emit intermediate phantom notes', () => {
  const { converter } = convertGBDMGCommands([
    { type: 'chip_write', chip: 'GBDMG', port: 0, register: 0x02, data: 0xF8 },
    { type: 'chip_write', chip: 'GBDMG', port: 0, register: 0x03, data: 1750 & 0xFF },
    { type: 'chip_write', chip: 'GBDMG', port: 0, register: 0x04, data: 0x80 | ((1750 >> 8) & 0x07) }, // trigger
    { type: 'wait', samples: 4410 },
    // Re-send $04 (same MSB, no trigger bit) immediately before $03, exercising the
    // $04->$03 split-write guard without changing the final pitch enough to retrigger.
    { type: 'chip_write', chip: 'GBDMG', port: 0, register: 0x04, data: (1750 >> 8) & 0x07 },
    { type: 'chip_write', chip: 'GBDMG', port: 0, register: 0x03, data: (1750 + 5) & 0xFF }, // tiny LSB change
    { type: 'wait', samples: 4410 },
    { type: 'chip_write', chip: 'GBDMG', port: 0, register: 0x02, data: 0x00 },
  ]);

  assert.equal(converter.generatedNoteCount, 1);
});

test('GameBoy DMG NR52 power-off silences all channels immediately', () => {
  const { converter } = convertGBDMGCommands([
    { type: 'chip_write', chip: 'GBDMG', port: 0, register: 0x02, data: 0xF8 },
    { type: 'chip_write', chip: 'GBDMG', port: 0, register: 0x03, data: 1750 & 0xFF },
    { type: 'chip_write', chip: 'GBDMG', port: 0, register: 0x04, data: 0x80 | ((1750 >> 8) & 0x07) },
    { type: 'chip_write', chip: 'GBDMG', port: 0, register: 0x11, data: 0xF0 },
    { type: 'chip_write', chip: 'GBDMG', port: 0, register: 0x12, data: 0x00 },
    { type: 'chip_write', chip: 'GBDMG', port: 0, register: 0x13, data: 0x80 },
    { type: 'wait', samples: 4410 },
    { type: 'chip_write', chip: 'GBDMG', port: 0, register: 0x16, data: 0x00 }, // power off
  ]);

  assert.equal(converter.channels.get('gbdmg_0').active, false);
});

test('parser diagnostics retain omitted commands without disturbing command boundaries', () => {
  const parsed = new VGMParser(createVgmBuffer([0x31, 0xAA, 0x54, 0x28, 0x4A, 0x66])).parse();
  assert.equal(parsed.diagnostics.unsupportedWriteCount, 1);
  assert.equal(parsed.diagnostics.hasOmittedContent, true);
  assert.equal(parsed.diagnostics.chips.find(chip => chip.chip === 'YM2151').writeCount, 1);
});

test('VGM 1.72 metadata matches the explicit official chip-write command fixture', () => {
  // Specification/libvgm command table, deliberately independent from COMMAND_CHIPS.
  // Rule: p=primary, s=fixed second, b=operand-0 bit 7, h=operand-1 bit 7, x=special parser route.
  const officialWrites = [
    [0x30, 'SN76489', 1, 's'], [0x31, 'AY8910/YM2203 SSG stereo', 1, 'x'], [0x32, 'MSM5205', 1, 'b'], [0x3F, 'SN76489', 1, 's'],
    [0x40, 'Mikey', 2, 'b'], [0x41, 'K007232', 2, 'b'], [0x42, 'K005289', 2, 'b'], [0x43, 'MSM5232', 2, 'b'], [0x44, 'ICS2115', 2, 'b'], [0x4F, 'SN76489', 1, 'p'],
    [0x50, 'SN76489', 1, 'p'], [0x51, 'YM2413', 2, 'p'], [0x52, 'YM2612', 2, 'p'], [0x53, 'YM2612', 2, 'p'], [0x54, 'YM2151', 2, 'p'], [0x55, 'YM2203', 2, 'p'], [0x56, 'YM2608', 2, 'p'], [0x57, 'YM2608', 2, 'p'], [0x58, 'YM2610', 2, 'p'], [0x59, 'YM2610', 2, 'p'], [0x5A, 'YM3812', 2, 'p'], [0x5B, 'YM3526', 2, 'p'], [0x5C, 'Y8950', 2, 'p'], [0x5D, 'YMZ280B', 2, 'p'], [0x5E, 'YMF262', 2, 'p'], [0x5F, 'YMF262', 2, 'p'],
    [0xA0, 'AY8910', 2, 'b'], [0xA1, 'YM2413', 2, 's'], [0xA2, 'YM2612', 2, 's'], [0xA3, 'YM2612', 2, 's'], [0xA4, 'YM2151', 2, 's'], [0xA5, 'YM2203', 2, 's'], [0xA6, 'YM2608', 2, 's'], [0xA7, 'YM2608', 2, 's'], [0xA8, 'YM2610', 2, 's'], [0xA9, 'YM2610', 2, 's'], [0xAA, 'YM3812', 2, 's'], [0xAB, 'YM3526', 2, 's'], [0xAC, 'Y8950', 2, 's'], [0xAD, 'YMZ280B', 2, 's'], [0xAE, 'YMF262', 2, 's'], [0xAF, 'YMF262', 2, 's'],
    [0xB0, 'RF5C68', 2, 'b'], [0xB1, 'RF5C164', 2, 'b'], [0xB2, 'PWM', 2, 'p'], [0xB3, 'GBDMG', 2, 'b'], [0xB4, 'NESAPU', 2, 'b'], [0xB5, 'MultiPCM', 2, 'b'], [0xB6, 'uPD7759', 2, 'b'], [0xB7, 'MSM6258', 2, 'b'], [0xB8, 'MSM6295', 2, 'b'], [0xB9, 'HuC6280', 2, 'b'], [0xBA, 'K053260', 2, 'b'], [0xBB, 'Pokey', 2, 'b'], [0xBC, 'WonderSwan', 2, 'b'], [0xBD, 'SAA1099', 2, 'b'], [0xBE, 'ES5506', 2, 'b'], [0xBF, 'GA20', 2, 'b'],
    [0xC0, 'SegaPCM', 3, 'h'], [0xC1, 'RF5C68', 3, 'b'], [0xC2, 'RF5C164', 3, 'b'], [0xC3, 'MultiPCM', 3, 'b'], [0xC4, 'QSound', 3, 'b'], [0xC5, 'SCSP', 3, 'b'], [0xC6, 'WonderSwan', 3, 'b'], [0xC7, 'VSU', 3, 'b'], [0xC8, 'X1-010', 3, 'b'], [0xC9, 'BSMT2000', 3, 'b'],
    [0xD0, 'YMF278B', 3, 'b'], [0xD1, 'YMF271', 3, 'b'], [0xD2, 'K051649', 3, 'b'], [0xD3, 'K054539', 3, 'b'], [0xD4, 'C140', 3, 'b'], [0xD5, 'ES5503', 3, 'b'], [0xD6, 'ES5506', 3, 'b'], [0xE1, 'C352', 4, 'b'],
  ];
  assert.deepEqual(Object.keys(COMMAND_CHIPS).map(Number).sort((left, right) => left - right), officialWrites.map(([command]) => command));
  for (const [command, chip, width, rule] of officialWrites) {
    const metadata = COMMAND_CHIPS[command];
    assert.equal(metadata.chip, chip, `chip for $${command.toString(16)}`);
    assert.equal(metadata.width, width, `width for $${command.toString(16)}`);
    if (rule === 'b') assert.equal(metadata.instanceOperand, 0, `instance bit for $${command.toString(16)}`);
    if (rule === 'h') assert.equal(metadata.instanceOperand, 1, `instance bit for $${command.toString(16)}`);
    if (rule === 's') assert.equal(metadata.instance, 1, `second chip for $${command.toString(16)}`);
    if (rule === 'p') assert.equal(metadata.instance ?? 0, 0, `primary chip for $${command.toString(16)}`);
  }
});

test('VGM 1.72 extension writes retain operands, instance bits and masked clocks', () => {
  const buffer = createVgmBuffer([
    0x32, 0x80,             // MSM5205: one operand, second instance
    0x41, 0x80, 0x11,       // K007232: two operands, second instance
    0x42, 0x80, 0x12,       // K005289: two operands, second instance
    0x43, 0x80, 0x13,       // MSM5232: two operands, second instance
    0x44, 0x80, 0x14,       // ICS2115: two operands, second instance
    0xC9, 0x80, 0x15, 0x16, // BSMT2000: three operands, second instance
    0x90, 0x01, 0xAA, 0x00, 0x00, // stream device $2A (K007232), second instance
    0x50, 0x9F, 0x66,       // proves every extension command consumed its full width
  ], 0x0172);
  const clocks = { MSM5205: 0xC0005205, K007232: 0x40007232, K005289: 0x80005289, MSM5232: 0xC0005232, BSMT2000: 0x40002000, ICS2115: 0x80002115 };
  const offsets = { K007232: 0xE8, K005289: 0xEC, MSM5205: 0xF0, MSM5232: 0xF4, BSMT2000: 0xF8, ICS2115: 0xFC };
  for (const [chip, offset] of Object.entries(offsets)) buffer.writeUInt32LE(clocks[chip], offset);

  const parsed = new VGMParser(buffer).parse();
  const omitted = parsed.commands.filter(command => command.type === 'unsupported_write');
  assert.deepEqual(omitted.map(command => [command.chip, command.instance, command.command, command.operands]), [
    ['MSM5205', 1, 0x32, [0x80]], ['K007232', 1, 0x41, [0x80, 0x11]], ['K005289', 1, 0x42, [0x80, 0x12]],
    ['MSM5232', 1, 0x43, [0x80, 0x13]], ['ICS2115', 1, 0x44, [0x80, 0x14]], ['BSMT2000', 1, 0xC9, [0x80, 0x15, 0x16]],
  ]);
  assert.equal(parsed.commands.at(-2).type, 'psg_write');
  assert.deepEqual(STREAM_DEVICE_CHIPS.slice(0x29), ['Mikey', 'K007232', 'K005289', 'MSM5205', 'MSM5232', 'BSMT2000', 'ICS2115']);
  assert.deepEqual(parsed.commands.find(command => command.type === 'stream_setup'), {
    type: 'stream_setup', streamId: 1, data: 0xAA, port: 0, register: 0,
    targetChip: 'K007232', targetInstance: 1, command: 0x90,
  });
  for (const chip of Object.keys(clocks)) {
    const diagnostic = parsed.diagnostics.chips.find(entry => entry.chip === chip && entry.instance === 1);
    assert.equal(diagnostic.clock, clocks[chip] & 0x3FFFFFFF, `${chip} masked clock`);
    assert.equal(diagnostic.writeCount, 1, `${chip} write count`);
  }
});

test('parser converts both instances of the OPL family and reports masked clocks', () => {
  const buffer = createVgmBuffer([
    0x5A, 0x20, 0x01, 0xAA, 0x21, 0x02,
    0x5B, 0x22, 0x03, 0xAB, 0x23, 0x04,
    0x5C, 0x24, 0x05, 0xAC, 0x25, 0x06,
    0x66,
  ], 0x0172);
  buffer.writeUInt32LE(0xC0123456, 0x50);
  buffer.writeUInt32LE(0xC0234567, 0x54);
  buffer.writeUInt32LE(0xC0345678, 0x58);

  const parsed = new VGMParser(buffer).parse();
  assert.deepEqual(parsed.commands.slice(0, 6), [
    { type: 'chip_write', chip: 'YM3812', instance: 0, port: 0, register: 0x20, data: 0x01 },
    { type: 'chip_write', chip: 'YM3812', instance: 1, port: 0, register: 0x21, data: 0x02 },
    { type: 'chip_write', chip: 'YM3526', instance: 0, port: 0, register: 0x22, data: 0x03 },
    { type: 'chip_write', chip: 'YM3526', instance: 1, port: 0, register: 0x23, data: 0x04 },
    { type: 'chip_write', chip: 'Y8950', instance: 0, port: 0, register: 0x24, data: 0x05 },
    { type: 'chip_write', chip: 'Y8950', instance: 1, port: 0, register: 0x25, data: 0x06 },
  ]);
  const clocks = { YM3812: 0x00123456, YM3526: 0x00234567, Y8950: 0x00345678 };
  for (const [chip, clock] of Object.entries(clocks)) {
    for (const instance of [0, 1]) {
      const diagnostic = parsed.diagnostics.chips.find(entry => entry.chip === chip && entry.instance === instance);
      assert.equal(diagnostic.clock, clock);
      assert.equal(diagnostic.midiSupport, 'full');
    }
  }
  assert.equal(parsed.diagnostics.hasOmittedContent, false);
});

test('parser leaves only Y8950 ADPCM registers unsupported', () => {
  const parsed = new VGMParser(createVgmBuffer([
    0x5C, 0x07, 0x80,
    0x5C, 0x0F, 0x12,
    0x5C, 0x08, 0x40,
    0x5C, 0x19, 0x01,
    0x66,
  ])).parse();
  assert.deepEqual(parsed.commands.slice(0, 4).map(command => command.type), [
    'unsupported_write', 'unsupported_write', 'chip_write', 'chip_write',
  ]);
  assert.deepEqual(
    parsed.commands.filter(command => command.type === 'unsupported_write').map(command => command.register),
    [undefined, undefined]
  );
  assert.equal(parsed.diagnostics.unsupportedWriteCount, 2);
  assert.equal(parsed.diagnostics.hasOmittedContent, true);
  const diagnostic = parsed.diagnostics.chips.find(entry => entry.chip === 'Y8950');
  assert.equal(diagnostic.midiSupport, 'none');
  assert.equal(diagnostic.writeCount, 4);
});

test('parser retains unsupported FM and PCM writes with masked clocks and chip instances', () => {
  const buffer = createVgmBuffer([
    0x5E, 0x20, 0x01,       // YMF262 (two operands)
    0xC5, 0x80, 0x12, 0x34, // SCSP (three operands, instance bit in operand 0)
    0xD6, 0x80, 0x56, 0x78, // ES5506 (three operands, instance bit in operand 0)
    0xE1, 0x80, 0x01, 0x02, 0x03, // C352 (four operands, instance bit in operand 0)
    0xB7, 0x80, 0x09,       // MSM6258 direct write, second chip
    0x66,
  ], 0x0172);
  buffer.writeUInt32LE(0xC0123456, 0x5C); // YMF262: variant/dual bits must not leak into diagnostics.
  buffer.writeUInt32LE(0x4003D090, 0x90); // MSM6258 second-chip flag + 250000 Hz.

  const parsed = new VGMParser(buffer).parse();
  const omitted = parsed.commands.filter(command => command.type === 'unsupported_write');
  assert.deepEqual(omitted.map(command => [command.chip, command.instance, command.command, command.operands]), [
    ['YMF262', 0, 0x5E, [0x20, 0x01]],
    ['SCSP', 1, 0xC5, [0x80, 0x12, 0x34]],
    ['ES5506', 1, 0xD6, [0x80, 0x56, 0x78]],
    ['C352', 1, 0xE1, [0x80, 0x01, 0x02, 0x03]],
    ['MSM6258', 1, 0xB7, [0x80, 0x09]],
  ]);
  assert.equal(parsed.diagnostics.unsupportedWriteCount, 5);
  assert.equal(parsed.diagnostics.hasOmittedContent, true);
  const ymf262 = parsed.diagnostics.chips.find(chip => chip.chip === 'YMF262');
  const msm6258 = parsed.diagnostics.chips.find(chip => chip.chip === 'MSM6258' && chip.instance === 1);
  assert.deepEqual(ymf262, { chip: 'YMF262', instance: 0, commandCount: 1, writeCount: 1, streamCount: 0, midiSupport: 'none', clock: 0x00123456 });
  assert.equal(msm6258.clock, 0x0003D090);
  assert.equal(msm6258.midiSupport, 'none');
});

test('CLI strict names the omitted chip and fails before creating MIDI output', () => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgm2midi-strict-'));
  const inputPath = path.join(tempDirectory, 'unsupported.vgm');
  const outputPath = path.join(tempDirectory, 'unsupported.mid');
  const fixture = createVgmBuffer([0x5E, 0x20, 0x01, 0x66]);
  fixture.writeUInt32LE(3579545, 0x5C);
  fs.writeFileSync(inputPath, fixture);
  const result = childProcess.spawnSync(process.execPath, [path.join(__dirname, '..', 'dist', 'cli.js'), inputPath, '--output', outputPath, '--strict'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Strict conversion refused: .*YMF262 \(writes 1, streams 0\)/);
  assert.equal(fs.existsSync(outputPath), false);
});

test('CLI converts a synthetic YM3812 VGM in strict split-chip mode', t => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgm2midi-opl-smoke-'));
  t.after(() => fs.rmSync(tempDirectory, { recursive: true, force: true }));
  const inputPath = path.join(tempDirectory, 'opl-smoke.vgm');
  const outputPath = path.join(tempDirectory, 'opl-smoke.mid');
  const fixture = createVgmBuffer([
    0x5A, 0xA0, 0x44,
    0x5A, 0xB0, 0x32,
    0x61, 0x44, 0xAC,
    0x5A, 0xB0, 0x12,
    0x66,
  ]);
  fixture.writeUInt32LE(3579545, 0x50);
  fs.writeFileSync(inputPath, fixture);

  const result = childProcess.spawnSync(process.execPath, [
    path.join(__dirname, '..', 'dist', 'cli.js'),
    inputPath, '--output', outputPath, '--verbose', '--strict', '--split-chips',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /YM3812 OPL2 FM\/Rhythm \(3579545 Hz\)/);
  assert.equal(fs.existsSync(outputPath), true);
  assert.equal(fs.existsSync(path.join(tempDirectory, 'opl-smoke.YM3812.mid')), true);
  assert.doesNotMatch(result.stderr, /unsupported VGM write/);
});

test('DAC stream diagnostics follow setup target and second-chip bit instead of assuming MSM6258', () => {
  const parsed = new VGMParser(createVgmBuffer([
    0x90, 0x03, 0x82, 0x00, 0x2A, // stream 3 -> YM2612 #2
    0x91, 0x03, 0x00, 0x01, 0x00,
    0x92, 0x03, 0x44, 0xAC, 0x00, 0x00,
    0x93, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01, 0x10, 0x00, 0x00, 0x00,
    0x66,
  ])).parse();
  const target = parsed.diagnostics.chips.find(chip => chip.chip === 'YM2612' && chip.instance === 1);
  assert.deepEqual(target, { chip: 'YM2612', instance: 1, commandCount: 4, writeCount: 0, streamCount: 1, midiSupport: 'none', clock: 0 });
  assert.equal(parsed.diagnostics.chips.some(chip => chip.chip === 'MSM6258'), false);
  assert.equal(parsed.diagnostics.unsupportedWriteCount, 1);
});

test('parser diagnostics no longer claim that AY/SSG stereo masks are absent', () => {
  const parsed = new VGMParser(createVgmBuffer([0xA0, 0x00, 0x34, 0x66])).parse();
  assert.equal('stereoUnavailableChips' in parsed.diagnostics, false);
});

test('VGM 1.70 extra header merges clock and volume records for the same chip instance', () => {
  const buffer = Buffer.alloc(0x110);
  buffer.write('Vgm ', 0, 'ascii'); buffer.writeUInt32LE(0x0170, 0x08); buffer.writeUInt32LE(0xDC, 0x34);
  buffer[0x100] = 0x66;
  buffer.writeUInt32LE(4, 0xBC); // extra header starts at $C0
  buffer.writeUInt32LE(8, 0xC4); buffer.writeUInt32LE(20, 0xC8);
  // Clock list: 1 entry, chip id 3 (YM2151), bit7 clear = primary instance.
  buffer[0xCC] = 1; buffer[0xCD] = 3; buffer.writeUInt32LE(3579545, 0xCE);
  // Volume list: 1 entry, same chip id 3 (bit7 clear = same primary instance),
  // flags bit0 set = absolute volume, volume = 0x2345.
  buffer[0xDC] = 1; buffer[0xDD] = 3; buffer[0xDE] = 1; buffer.writeUInt16LE(0x2345, 0xDF);
  const extra = new VGMParser(buffer).parse().extraHeader;
  assert.deepEqual(extra, [
    { chip: 'YM2151', instance: 0, clock: 3579545, volume: 0x2345, isAbsoluteVolume: true },
  ]);
});

test('VGM 1.70 extra header chip-ID bit7 selects the second chip instance for both lists', () => {
  // Regression test: instance used to be hardcoded to 1 for every clock-list
  // entry, and derived from the (wrong) Flags byte for volume-list entries,
  // instead of both reading Chip ID bit7 the same way.
  const buffer = Buffer.alloc(0x110);
  buffer.write('Vgm ', 0, 'ascii'); buffer.writeUInt32LE(0x0170, 0x08); buffer.writeUInt32LE(0xDC, 0x34);
  buffer[0x100] = 0x66;
  buffer.writeUInt32LE(4, 0xBC);
  buffer.writeUInt32LE(8, 0xC4); buffer.writeUInt32LE(20, 0xC8);
  // Clock list: chip id 0x80 (SN76489 id 0 | bit7) = second SN76489 instance.
  buffer[0xCC] = 1; buffer[0xCD] = 0x80; buffer.writeUInt32LE(4000000, 0xCE);
  // Volume list: chip id 0x00 (SN76489, primary instance), absolute, 50%.
  buffer[0xDC] = 1; buffer[0xDD] = 0x00; buffer[0xDE] = 1; buffer.writeUInt16LE(0x0080, 0xDF);
  const extra = new VGMParser(buffer).parse().extraHeader;
  const byInstance = new Map(extra.map((entry) => [entry.instance, entry]));
  assert.equal(byInstance.get(1).clock, 4000000);
  assert.equal(byInstance.get(1).volume, undefined); // clock-only: no volume entry at all
  assert.equal(byInstance.get(0).volume, 0x0080);
  assert.equal(byInstance.get(0).clock, 0); // volume-only: no clock entry at all
});

test('VGM 1.70 extra header does not report volume:0 for a clock-only chip', () => {
  // Regression test for the presence bug: a chip appearing only in the clock
  // list used to get a synthetic `volume: 0` placeholder (indistinguishable
  // from an actual "silence this chip" volume entry).
  const buffer = Buffer.alloc(0x110);
  buffer.write('Vgm ', 0, 'ascii'); buffer.writeUInt32LE(0x0170, 0x08); buffer.writeUInt32LE(0xDC, 0x34);
  buffer[0x100] = 0x66;
  buffer.writeUInt32LE(4, 0xBC);
  buffer.writeUInt32LE(8, 0xC4); buffer.writeUInt32LE(0, 0xC8); // no volume list at all
  buffer[0xCC] = 1; buffer[0xCD] = 2; buffer.writeUInt32LE(7670453, 0xCE); // YM2612 clock only
  const extra = new VGMParser(buffer).parse().extraHeader;
  assert.deepEqual(extra, [{ chip: 'YM2612', instance: 0, clock: 7670453 }]);
  assert.equal('volume' in extra[0], false);
});

test('VGM 1.70 extra header exposes a relative (non-absolute) volume entry as-is', () => {
  const buffer = Buffer.alloc(0x110);
  buffer.write('Vgm ', 0, 'ascii'); buffer.writeUInt32LE(0x0170, 0x08); buffer.writeUInt32LE(0xDC, 0x34);
  buffer[0x100] = 0x66;
  buffer.writeUInt32LE(4, 0xBC);
  buffer.writeUInt32LE(0, 0xC4); buffer.writeUInt32LE(20, 0xC8); // no clock list
  buffer[0xDC] = 1; buffer[0xDD] = 3; buffer[0xDE] = 0; buffer.writeUInt16LE(0x0180, 0xDF); // flags bit0=0
  const extra = new VGMParser(buffer).parse().extraHeader;
  assert.deepEqual(extra, [
    { chip: 'YM2151', instance: 0, clock: 0, volume: 0x0180, isAbsoluteVolume: false },
  ]);
});

test('MidiConverter emits Extra Header absolute chip volume as a leading CC7', () => {
  const converter = new MidiConverter({
    header: createHeader({ ym2612Clock: 7670453, ym2151Clock: 0 }),
    commands: [
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA4, data: 0x22 },
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA0, data: 0x69 },
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0xF0 },
      { type: 'end' },
    ],
    extraHeader: [
      { chip: 'YM2612', instance: 0, clock: 7670453, volume: 0x0080, isAbsoluteVolume: true },
    ],
  });
  const events = converter.convert().flatMap(track => track.events);
  const cc7 = events.find(event => event.name === 'ControllerChangeEvent' && event.controllerNumber === 7);
  assert.ok(cc7, 'expected a leading CC7 event on the YM2612 track');
  assert.equal(cc7.controllerValue, 50); // 0x0080 / 0x0100 * 100 = 50%
});

test('MidiConverter omits CC7 when Extra Header volume is exactly 100%', () => {
  const converter = new MidiConverter({
    header: createHeader({ ym2612Clock: 7670453, ym2151Clock: 0 }),
    commands: [
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA4, data: 0x22 },
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA0, data: 0x69 },
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0xF0 },
      { type: 'end' },
    ],
    extraHeader: [
      { chip: 'YM2612', instance: 0, clock: 7670453, volume: 0x0100, isAbsoluteVolume: true },
    ],
  });
  const events = converter.convert().flatMap(track => track.events);
  assert.equal(events.some(event => event.name === 'ControllerChangeEvent' && event.controllerNumber === 7), false);
});

test('MidiConverter ignores a relative (non-absolute) Extra Header volume', () => {
  const converter = new MidiConverter({
    header: createHeader({ ym2612Clock: 7670453, ym2151Clock: 0 }),
    commands: [
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA4, data: 0x22 },
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA0, data: 0x69 },
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0xF0 },
      { type: 'end' },
    ],
    extraHeader: [
      { chip: 'YM2612', instance: 0, clock: 7670453, volume: 0x0040, isAbsoluteVolume: false },
    ],
  });
  const events = converter.convert().flatMap(track => track.events);
  assert.equal(events.some(event => event.name === 'ControllerChangeEvent' && event.controllerNumber === 7), false);
});

test('MidiConverter matches Extra Header entries by chip AND instance, not by chip alone', () => {
  const converter = new MidiConverter({
    header: createHeader({ ym2612Clock: 7670453, ym2151Clock: 0 }),
    commands: [
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA4, data: 0x22 },
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA0, data: 0x69 },
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0xF0 },
      { type: 'end' },
    ],
    // Only the *second* YM2612 instance has a quiet Extra Header volume; the
    // primary instance actually used here must stay untouched.
    extraHeader: [
      { chip: 'YM2612', instance: 1, clock: 7670453, volume: 0x0020, isAbsoluteVolume: true },
    ],
  });
  const events = converter.convert().flatMap(track => track.events);
  assert.equal(events.some(event => event.name === 'ControllerChangeEvent' && event.controllerNumber === 7), false);
});

test('VGM command $40 keeps its version-dependent operand boundary', () => {
  const oldParsed = new VGMParser(createVgmBuffer([0x40, 0xAA, 0x50, 0x90, 0x66], 0x0160)).parse();
  const newParsed = new VGMParser(createVgmBuffer([0x40, 0xAA, 0xBB, 0x50, 0x90, 0x66], 0x0161)).parse();
  assert.equal(oldParsed.commands.find(command => command.type === 'psg_write').data, 0x90);
  assert.equal(newParsed.commands.find(command => command.type === 'psg_write').data, 0x90);
});

test('MIDI output is 960 PPQ and a converter instance is byte-identical on reuse', () => {
  const converter = new MidiConverter({
    header: createHeader({ sn76489Clock: 3579545, ym2151Clock: 0 }),
    commands: [
      { type: 'psg_write', chip: 'SN76489', data: 0x80 }, { type: 'psg_write', chip: 'SN76489', data: 0x06 },
      { type: 'psg_write', chip: 'SN76489', data: 0x90 }, { type: 'wait', samples: 4410 },
      { type: 'psg_write', chip: 'SN76489', data: 0x9F }, { type: 'end' },
    ],
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgm2midi-repeat-'));
  const first = path.join(directory, 'first.mid'); const second = path.join(directory, 'second.mid');
  converter.exportToFile(first); converter.exportToFile(second);
  assert.equal(fs.readFileSync(first).readUInt16BE(12), 960);
  assert.deepEqual(fs.readFileSync(first), fs.readFileSync(second));
});

test('split-chips keeps normal MIDI and emits an isolated chip sidecar', () => {
  const converter = new MidiConverter({
    header: createHeader({ ym2151Clock: 3579545 }),
    commands: [
      { type: 'chip_write', chip: 'YM2151', register: 0x28, data: 0x4A },
      { type: 'chip_write', chip: 'YM2151', register: 0x08, data: 0x78 }, { type: 'wait', samples: 10 },
      { type: 'chip_write', chip: 'YM2151', register: 0x08, data: 0x00 }, { type: 'end' },
    ],
  }, { splitChips: true });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgm2midi-split-')); const output = path.join(directory, 'song.mid');
  converter.exportToFile(output);
  assert.ok(fs.existsSync(output)); assert.ok(fs.existsSync(path.join(directory, 'song.YM2151.mid')));
});

test('MSM6258 DAC stream becomes a stable editing trigger and closes on stop', () => {
  const converter = new MidiConverter({
    header: createHeader({ ym2151Clock: 0 }),
    commands: [
      { type: 'stream_setup', streamId: 0, data: 0x17 }, { type: 'stream_data', streamId: 0, bankId: 2, stepSize: 1 },
      { type: 'stream_frequency', streamId: 0, frequency: 8000 }, { type: 'stream_start', streamId: 0, address: 0x1234, length: 16, data: 1 },
      { type: 'wait', samples: 100 }, { type: 'stream_stop', streamId: 0 }, { type: 'end' },
    ],
  });
  const tracks = converter.convert();
  assert.equal(converter.generatedNoteCount, 1);
  assert.equal(tracks[0].events.filter(event => event.name === 'NoteOffEvent').length, 1);
});

function createMSM6258StreamConverter(commands, dataBlocks = []) {
  return new MidiConverter({
    header: createHeader({ ym2151Clock: 0, msm6258Clock: 4000000 }),
    commands: [
      { type: 'stream_setup', streamId: 0, data: 0x17, targetChip: 'MSM6258', port: 0xB7, register: 0x00 },
      { type: 'stream_data', streamId: 0, bankId: 4, stepSize: 1, stepBase: 0 },
      { type: 'stream_frequency', streamId: 0, frequency: 1000 },
      ...commands,
      { type: 'end' },
    ],
    dataBlocks,
    diagnostics: { chips: [], unsupportedCommandCount: 0, unsupportedWriteCount: 0, streamCount: 0, hasOmittedContent: false },
  });
}

function streamNoteEvents(converter) {
  const track = converter.convert().find(candidate => candidate.events.some(event => event.name === 'NoteOnEvent'));
  return {
    track,
    noteOn: track.events.find(event => event.name === 'NoteOnEvent'),
    noteOff: track.events.find(event => event.name === 'NoteOffEvent'),
  };
}

test('PCM sidecar preserves more sample IDs than GM percussion notes and records stream boundaries', () => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgm2midi-pcm-metadata-test-'));
  const metadataPath = path.join(tempDirectory, 'pcm.libvgm.json');
  const commands = Array.from({ length: 48 }, (_, address) => [
    {
      type: 'stream_start', streamId: 0, address, length: 1, lengthMode: 1,
      data: address === 0 ? 0x81 : 0x01, // First stream loops; the rest are one-shot.
    },
    { type: 'stream_stop', streamId: 0 },
  ]).flat();
  const converter = createMSM6258StreamConverter(commands, [
    { type: 4, blockId: 0, size: 64, payload: Buffer.alloc(64) },
  ]);

  converter.convert();
  converter.exportTrackMetadata(metadataPath, 0);
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  const pcmTracks = metadata.tracks.filter(entry => entry.pcm?.source === 'msm6258');

  assert.equal(metadata.version, 1, 'existing sidecar readers remain compatible');
  assert.equal(pcmTracks.length, 48);
  assert.equal(pcmTracks[0].pcm.gmNote, pcmTracks[47].pcm.gmNote, 'GM percussion note allocation wraps');
  assert.notEqual(pcmTracks[0].pcm.sampleId, pcmTracks[47].pcm.sampleId, 'sidecar sample IDs stay unique');
  assert.deepEqual(pcmTracks[0].pcm.events, [
    { type: 'start', sampleTime: 0, isLoop: true, dataLengthBytes: 2 },
    { type: 'stop', sampleTime: 0 },
  ]);
  assert.deepEqual(pcmTracks[0].pcm.dataBlock, {
    bankType: 4, bankInstance: 0, blockId: 0, bankOffset: 0, blockOffset: 0, lengthBytes: 2,
  });
  assert.equal(pcmTracks[1].pcm.events[0].durationSamples, 44);
  assert.deepEqual(pcmTracks[1].pcm.dataBlock, {
    bankType: 4, bankInstance: 0, blockId: 0, bankOffset: 1, blockOffset: 1, lengthBytes: 2,
  });
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});

test('YM2612 DAC sidecar resolves a seek address to its VGM PCM data block', () => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgm2midi-dac-bank-metadata-test-'));
  const metadataPath = path.join(tempDirectory, 'dac.libvgm.json');
  const converter = new MidiConverter({
    header: createHeader({ ym2612Clock: 7670453, ym2151Clock: 0 }),
    commands: [
      { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x2B, data: 0x80 },
      { type: 'pcm_seek', chip: 'YM2612', address: 4 },
      { type: 'pcm_write', chip: 'YM2612', samples: 0 },
      { type: 'end' },
    ],
    dataBlocks: [
      { type: 0x00, blockId: 0, size: 3, payload: Buffer.alloc(3) },
      { type: 0x00, blockId: 1, size: 5, payload: Buffer.alloc(5) },
    ],
  });

  converter.convert();
  converter.exportTrackMetadata(metadataPath, 0);
  const entry = JSON.parse(fs.readFileSync(metadataPath, 'utf8')).tracks.find(
    track => track.pcm?.source === 'ym2612-dac'
  );

  assert.equal(entry.pcm.sampleId, '000004');
  assert.deepEqual(entry.pcm.dataBlock, {
    bankType: 0, bankInstance: 0, blockId: 1, bankOffset: 4, blockOffset: 1,
  });
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});

test('PCM ROM triggers resolve YM2608 ADPCM-B, SegaPCM, and C140 data blocks', () => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgm2midi-rom-bank-metadata-test-'));
  const metadataPath = path.join(tempDirectory, 'rom.libvgm.json');
  const createROMBlock = (type, blockId, romSize, romStartAddress, dataLength) => {
    const payload = Buffer.alloc(8 + dataLength);
    payload.writeUInt32LE(romSize, 0);
    payload.writeUInt32LE(romStartAddress, 4);
    return { type, blockId, size: payload.length, payload };
  };
  const converter = new MidiConverter({
    header: createHeader({ ym2608Clock: 7987200, segaPCMClock: 4000000, c140Clock: 2139000, ym2151Clock: 0 }),
    commands: [
      // YM2608 ADPCM-B: ROM mode, start=0x0002/end=0x0003 in 32-byte units.
      { type: 'chip_write', chip: 'YM2608', port: 1, register: 0x01, data: 0x01 },
      { type: 'chip_write', chip: 'YM2608', port: 1, register: 0x02, data: 0x02 },
      { type: 'chip_write', chip: 'YM2608', port: 1, register: 0x03, data: 0x00 },
      { type: 'chip_write', chip: 'YM2608', port: 1, register: 0x04, data: 0x03 },
      { type: 'chip_write', chip: 'YM2608', port: 1, register: 0x05, data: 0x00 },
      { type: 'chip_write', chip: 'YM2608', port: 1, register: 0x00, data: 0x80 },
      // SegaPCM reads a 24-bit ROM address.  The second block must be selected.
      { type: 'chip_write', chip: 'SegaPCM', register: 0x84, data: 0x00 },
      { type: 'chip_write', chip: 'SegaPCM', register: 0x85, data: 0x02 },
      { type: 'chip_write', chip: 'SegaPCM', register: 0x86, data: 0x00 },
      // C140 samples use bank:16-bit start.  A second trigger has no matching block.
      { type: 'chip_write', chip: 'C140', register: 0x04, data: 0x01 },
      { type: 'chip_write', chip: 'C140', register: 0x06, data: 0x00 },
      { type: 'chip_write', chip: 'C140', register: 0x07, data: 0x20 },
      { type: 'chip_write', chip: 'C140', register: 0x05, data: 0x80 },
      { type: 'chip_write', chip: 'C140', register: 0x14, data: 0x02 },
      { type: 'chip_write', chip: 'C140', register: 0x16, data: 0x00 },
      { type: 'chip_write', chip: 'C140', register: 0x17, data: 0x00 },
      { type: 'chip_write', chip: 'C140', register: 0x15, data: 0x80 },
      { type: 'end' },
    ],
    dataBlocks: [
      createROMBlock(0x81, 0, 0x400, 0x40, 0x100),
      createROMBlock(0x80, 0, 0x40000, 0x10000, 0x20),
      createROMBlock(0x80, 1, 0x40000, 0x20000, 0x80),
      createROMBlock(0x8D, 0, 0x40000, 0x10000, 0x80),
    ],
  });

  converter.convert();
  converter.exportTrackMetadata(metadataPath, 0);
  const pcmTracks = JSON.parse(fs.readFileSync(metadataPath, 'utf8')).tracks
    .filter(track => track.pcm);
  const ym2608 = pcmTracks.find(track => track.pcm.source === 'ym2608-adpcm-b');
  const segaPCM = pcmTracks.find(track => track.pcm.source === 'segapcm');
  const c140 = pcmTracks.find(track => track.pcm.source === 'c140' && track.pcm.sampleId === '010020');
  const unmatchedC140 = pcmTracks.find(track => track.pcm.source === 'c140' && track.pcm.sampleId === '020000');

  assert.deepEqual(ym2608.pcm.dataBlock, {
    bankType: 0x81, bankInstance: 0, blockId: 0, bankOffset: 0x40, blockOffset: 0,
    lengthBytes: 0x40, romSizeBytes: 0x400, romStartAddress: 0x40, romDataLengthBytes: 0x100,
  });
  assert.equal(ym2608.pcm.events[0].dataLengthBytes, 0x40);
  assert.deepEqual(segaPCM.pcm.dataBlock, {
    bankType: 0x80, bankInstance: 0, blockId: 1, bankOffset: 0x20000, blockOffset: 0,
    romSizeBytes: 0x40000, romStartAddress: 0x20000, romDataLengthBytes: 0x80,
  });
  assert.deepEqual(c140.pcm.dataBlock, {
    bankType: 0x8D, bankInstance: 0, blockId: 0, bankOffset: 0x10020, blockOffset: 0x20,
    romSizeBytes: 0x40000, romStartAddress: 0x10000, romDataLengthBytes: 0x80,
  });
  assert.equal(unmatchedC140.pcm.dataBlock, undefined);
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});

test('MSM6258 0x93 length modes convert commands, milliseconds, end-of-bank and raw bytes to duration', () => {
  const bank = [{ type: 4, blockId: 0, size: 40, payload: Buffer.alloc(40) }];
  const cases = [
    { name: 'commands', mode: 1, length: 10, expectedTick: 19 },
    { name: 'milliseconds', mode: 2, length: 25, expectedTick: 48 },
    { name: 'to-end', mode: 3, length: 0, expectedTick: 38 },
    { name: 'raw-bytes', mode: 0x0F, length: 40, expectedTick: 38 },
  ];
  for (const testCase of cases) {
    const converter = createMSM6258StreamConverter([
      { type: 'stream_start', streamId: 0, address: 0, data: testCase.mode, lengthMode: testCase.mode, length: testCase.length },
    ], bank);
    const { noteOff } = streamNoteEvents(converter);
    assert.equal(noteOff.delta, testCase.expectedTick, testCase.name);
  }
});

test('MSM6258 DCTRL_LMODE_IGNORE preserves the prior range and $94 replaces a future natural Note Off', () => {
  const converter = createMSM6258StreamConverter([
    { type: 'stream_start', streamId: 0, address: 0, data: 0x0F, lengthMode: 0x0F, length: 2000 },
    { type: 'wait', samples: 100 },
    // Mode 0 is IGNORE: it reuses the previous raw-byte range rather than treating
    // the supplied zero length as an empty/raw range.
    { type: 'stream_start', streamId: 0, address: 0, data: 0x00, lengthMode: 0x00, length: 0 },
    { type: 'wait', samples: 100 }, { type: 'stream_stop', streamId: 0 },
  ], [{ type: 4, blockId: 0, size: 2000, payload: Buffer.alloc(2000) }]);
  const events = converter.convert().flatMap(track => track.events).filter(event => event.name === 'NoteOffEvent');
  // Both explicit replacement points are around 100 VGM samples (= tick 4), not
  // the original non-loop duration near tick 1920.
  assert.deepEqual(events.map(event => event.delta), [4, 5]);
});

test('MSM6258 early $94 shortens a non-loop stream instead of leaving its natural Note Off', () => {
  const converter = createMSM6258StreamConverter([
    { type: 'stream_start', streamId: 0, address: 0, data: 0x0F, lengthMode: 0x0F, length: 2000 },
    { type: 'wait', samples: 100 }, { type: 'stream_stop', streamId: 0 },
  ], [{ type: 4, blockId: 0, size: 2000, payload: Buffer.alloc(2000) }]);
  const { noteOff } = streamNoteEvents(converter);
  assert.equal(noteOff.delta, 4);
});

test('MSM6258 $95 resolves a compressed second-chip bank by normalized type and instance', () => {
  const converter = new MidiConverter({
    header: createHeader({ ym2151Clock: 0, msm6258Clock: 4000000 }),
    commands: [
      { type: 'stream_setup', streamId: 0, data: 0x97, targetChip: 'MSM6258', targetInstance: 1, port: 0xB7, register: 0 },
      { type: 'stream_data', streamId: 0, bankId: 4, stepSize: 1, stepBase: 0 },
      { type: 'stream_frequency', streamId: 0, frequency: 1000 },
      { type: 'stream_start_fast', streamId: 0, blockId: 0, address: 0, data: 0 }, { type: 'end' },
    ],
    dataBlocks: [{ type: 4, originalType: 0x44, isCompressed: true, instance: 1, blockId: 0, size: 4, payload: Buffer.from([0, 1, 2, 3]) }],
    diagnostics: { chips: [], unsupportedCommandCount: 0, unsupportedWriteCount: 0, streamCount: 0, hasOmittedContent: false },
  });
  const { track, noteOff } = streamNoteEvents(converter);
  assert.equal(noteOff.delta, 4);
  assert.match(track.events.find(event => event.name === 'TrackNameEvent').text, /bank4_block0_start0_length4_step1_forward/i);
});

test('MSM6258 0x91 step size and base use the B7 command width for duration and identity', () => {
  const converter = new MidiConverter({
    header: createHeader({ ym2151Clock: 0, msm6258Clock: 4000000 }),
    commands: [
      { type: 'stream_setup', streamId: 0, data: 0x17, targetChip: 'MSM6258', port: 0xB7, register: 0x00 },
      { type: 'stream_data', streamId: 0, bankId: 4, stepSize: 2, stepBase: 1 },
      { type: 'stream_frequency', streamId: 0, frequency: 1000 },
      { type: 'stream_start', streamId: 0, address: 0, data: 0x0F, lengthMode: 0x0F, length: 40 },
      { type: 'end' },
    ],
    dataBlocks: [{ type: 4, blockId: 0, size: 64, payload: Buffer.alloc(64) }],
    diagnostics: { chips: [], unsupportedCommandCount: 0, unsupportedWriteCount: 0, streamCount: 0, hasOmittedContent: false },
  });
  const { track, noteOff } = streamNoteEvents(converter);
  // 40 raw bytes / (B7's 2 data bytes * stepSize 2) = 10 writes = 10ms = 19 ticks.
  assert.equal(noteOff.delta, 19);
  const trackName = track.events.find(event => event.name === 'TrackNameEvent').text;
  assert.match(trackName, /bank4_blockrange_start2_length28_step2_forward/i);
});

test('MSM6258 0x95 resolves bank block identity, reverse flag and natural duration', () => {
  const converter = createMSM6258StreamConverter([
    { type: 'stream_start_fast', streamId: 0, blockId: 1, address: 1, data: 0x10 },
  ], [
    { type: 4, blockId: 0, size: 8, payload: Buffer.alloc(8) },
    { type: 4, blockId: 1, size: 16, payload: Buffer.alloc(16) },
  ]);
  const { track, noteOff } = streamNoteEvents(converter);
  assert.equal(noteOff.delta, 15); // 16 / B7-width 2 writes at 1kHz = 8ms.
  const trackName = track.events.find(event => event.name === 'TrackNameEvent').text;
  assert.match(trackName, /bank4_block1_start8_length10_step1_reverse/i);
});

test('MSM6258 looping streams close on explicit 0x94 or conversion end, never natural duration', () => {
  const blocks = [{ type: 4, blockId: 0, size: 16, payload: Buffer.alloc(16) }];
  const stopConverter = createMSM6258StreamConverter([
    { type: 'stream_start_fast', streamId: 0, blockId: 0, address: 0, data: 0x01 },
    { type: 'wait', samples: 2205 }, { type: 'stream_stop', streamId: 0 },
  ], blocks);
  const endConverter = createMSM6258StreamConverter([
    { type: 'stream_start_fast', streamId: 0, blockId: 0, address: 0, data: 0x01 },
    { type: 'wait', samples: 441 },
  ], blocks);
  assert.equal(streamNoteEvents(stopConverter).noteOff.delta, 96);
  assert.equal(streamNoteEvents(endConverter).noteOff.delta, 19);
});

function assertSecondChipProducesSidecar(chip, header, commands) {
  const converter = new MidiConverter({ header: createHeader({ ym2151Clock: 0, ...header }), commands: [...commands, { type: 'end' }] }, { splitChips: true });
  const tracks = converter.convert();
  assert.ok(tracks.some(track => track.events.some(event => event.name === 'NoteOnEvent')), `${chip} #2 must produce a note`);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `vgm2midi-${chip}-dual-`));
  const output = path.join(directory, 'second.mid');
  converter.exportToFile(output);
  const sidecar = path.join(directory, `second.${chip}-2.mid`);
  assert.ok(fs.existsSync(sidecar), `${chip} #2 sidecar must exist`);
  assert.ok(fs.readFileSync(sidecar).length > 30, `${chip} #2 sidecar must contain MIDI events`);
}

test('dual SN76489 keeps the second latch and tone state in its own sidecar', () => {
  assertSecondChipProducesSidecar('SN76489', { sn76489Clock: 3579545 }, [
    { type: 'psg_write', chip: 'SN76489', instance: 1, data: 0x80 }, { type: 'psg_write', chip: 'SN76489', instance: 1, data: 0x06 },
    { type: 'psg_write', chip: 'SN76489', instance: 1, data: 0x90 }, { type: 'wait', samples: 441 }, { type: 'psg_write', chip: 'SN76489', instance: 1, data: 0x9F },
  ]);
});

test('dual YM2413 keeps the second registers and key state in its own sidecar', () => {
  assertSecondChipProducesSidecar('YM2413', { ym2413Clock: 3579545 }, [
    { type: 'chip_write', chip: 'YM2413', instance: 1, register: 0x10, data: 0x50 },
    { type: 'chip_write', chip: 'YM2413', instance: 1, register: 0x20, data: 0x11 }, { type: 'wait', samples: 441 },
    { type: 'chip_write', chip: 'YM2413', instance: 1, register: 0x20, data: 0x01 },
  ]);
});

test('dual YM2612 keeps the second registers, TL and key state in its own sidecar', () => {
  assertSecondChipProducesSidecar('YM2612', { ym2612Clock: 7670453 }, [
    { type: 'chip_write', chip: 'YM2612', instance: 1, port: 0, register: 0xB4, data: 0xC0 },
    { type: 'chip_write', chip: 'YM2612', instance: 1, port: 0, register: 0x40, data: 0x10 },
    { type: 'chip_write', chip: 'YM2612', instance: 1, port: 0, register: 0xA4, data: 0x22 },
    { type: 'chip_write', chip: 'YM2612', instance: 1, port: 0, register: 0xA0, data: 0x05 },
    { type: 'chip_write', chip: 'YM2612', instance: 1, port: 0, register: 0x28, data: 0xF0 }, { type: 'wait', samples: 441 },
    { type: 'chip_write', chip: 'YM2612', instance: 1, port: 0, register: 0x28, data: 0x00 },
  ]);
});

test('dual YM2151 keeps the second key, TL and pan state in its own sidecar', () => {
  assertSecondChipProducesSidecar('YM2151', { ym2151Clock: 3579545 }, [
    { type: 'chip_write', chip: 'YM2151', instance: 1, register: 0x20, data: 0xC7 }, { type: 'chip_write', chip: 'YM2151', instance: 1, register: 0x60, data: 0x10 },
    { type: 'chip_write', chip: 'YM2151', instance: 1, register: 0x28, data: 0x4A }, { type: 'chip_write', chip: 'YM2151', instance: 1, register: 0x08, data: 0x78 },
    { type: 'wait', samples: 441 }, { type: 'chip_write', chip: 'YM2151', instance: 1, register: 0x08, data: 0x00 },
  ]);
});

test('dual GBDMG keeps the second envelope and trigger state in its own sidecar', () => {
  assertSecondChipProducesSidecar('GBDMG', { gbDmgClock: 4194304 }, [
    { type: 'chip_write', chip: 'GBDMG', instance: 1, register: 0x02, data: 0xF8 }, { type: 'chip_write', chip: 'GBDMG', instance: 1, register: 0x03, data: 0xD6 },
    { type: 'chip_write', chip: 'GBDMG', instance: 1, register: 0x04, data: 0x86 }, { type: 'wait', samples: 441 }, { type: 'chip_write', chip: 'GBDMG', instance: 1, register: 0x02, data: 0x00 },
  ]);
});

test('dual SegaPCM keeps the second PCM registers and voices in its own sidecar', () => {
  assertSecondChipProducesSidecar('SegaPCM', { segaPCMClock: 4000000, segaPCMInterface: 12 }, [
    { type: 'chip_write', chip: 'SegaPCM', instance: 1, register: 0x02, data: 0x40 }, { type: 'chip_write', chip: 'SegaPCM', instance: 1, register: 0x03, data: 0x40 },
    { type: 'chip_write', chip: 'SegaPCM', instance: 1, register: 0x84, data: 0x2F }, { type: 'chip_write', chip: 'SegaPCM', instance: 1, register: 0x85, data: 0x30 },
    { type: 'chip_write', chip: 'SegaPCM', instance: 1, register: 0x86, data: 0xC6 }, { type: 'wait', samples: 441 }, { type: 'chip_write', chip: 'SegaPCM', instance: 1, register: 0x86, data: 0xC7 },
  ]);
});

test('dual C140 keeps the second PCM registers and voices in its own sidecar', () => {
  assertSecondChipProducesSidecar('C140', { c140Clock: 12288000 }, [
    { type: 'chip_write', chip: 'C140', instance: 1, register: 0x00, data: 0x40 }, { type: 'chip_write', chip: 'C140', instance: 1, register: 0x01, data: 0x40 },
    { type: 'chip_write', chip: 'C140', instance: 1, register: 0x04, data: 0x12 }, { type: 'chip_write', chip: 'C140', instance: 1, register: 0x06, data: 0x34 },
    { type: 'chip_write', chip: 'C140', instance: 1, register: 0x07, data: 0x56 }, { type: 'chip_write', chip: 'C140', instance: 1, register: 0x05, data: 0x80 },
    { type: 'wait', samples: 441 }, { type: 'chip_write', chip: 'C140', instance: 1, register: 0x05, data: 0x00 },
  ]);
});

function duplicateChipCommands(commands, instance) {
  return commands.map(command => ({ ...command, instance }));
}

test('descriptor-owned dual tracks keep seven simultaneous primary/second voices separate through EOF', () => {
  const cases = [
    {
      chip: 'SN76489', header: { sn76489Clock: 3579545 }, commands: [
        { type: 'psg_write', chip: 'SN76489', data: 0x80 },
        { type: 'psg_write', chip: 'SN76489', data: 0x06 },
        { type: 'psg_write', chip: 'SN76489', data: 0x90 },
      ],
    },
    {
      chip: 'YM2413', header: { ym2413Clock: 3579545 }, commands: [
        { type: 'chip_write', chip: 'YM2413', register: 0x10, data: 0x50 },
        { type: 'chip_write', chip: 'YM2413', register: 0x20, data: 0x11 },
      ],
    },
    {
      chip: 'YM2612', header: { ym2612Clock: 7670453 }, commands: [
        { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x40, data: 0x10 },
        { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA4, data: 0x22 },
        { type: 'chip_write', chip: 'YM2612', port: 0, register: 0xA0, data: 0x05 },
        { type: 'chip_write', chip: 'YM2612', port: 0, register: 0x28, data: 0xF0 },
      ],
    },
    {
      chip: 'YM2151', header: { ym2151Clock: 3579545 }, commands: [
        { type: 'chip_write', chip: 'YM2151', register: 0x20, data: 0xC7 },
        { type: 'chip_write', chip: 'YM2151', register: 0x60, data: 0x10 },
        { type: 'chip_write', chip: 'YM2151', register: 0x28, data: 0x4A },
        { type: 'chip_write', chip: 'YM2151', register: 0x08, data: 0x78 },
      ],
    },
    {
      chip: 'GBDMG', header: { gbDmgClock: 4194304 }, commands: [
        { type: 'chip_write', chip: 'GBDMG', register: 0x02, data: 0xF8 },
        { type: 'chip_write', chip: 'GBDMG', register: 0x03, data: 0xD6 },
        { type: 'chip_write', chip: 'GBDMG', register: 0x04, data: 0x86 },
      ],
    },
    {
      chip: 'SegaPCM', header: { segaPCMClock: 4000000, segaPCMInterface: 12 }, commands: [
        { type: 'chip_write', chip: 'SegaPCM', register: 0x02, data: 0x40 },
        { type: 'chip_write', chip: 'SegaPCM', register: 0x03, data: 0x40 },
        { type: 'chip_write', chip: 'SegaPCM', register: 0x84, data: 0x2F },
        { type: 'chip_write', chip: 'SegaPCM', register: 0x85, data: 0x30 },
        { type: 'chip_write', chip: 'SegaPCM', register: 0x86, data: 0xC6 },
      ],
    },
    {
      chip: 'C140', header: { c140Clock: 12288000 }, commands: [
        { type: 'chip_write', chip: 'C140', register: 0x00, data: 0x40 },
        { type: 'chip_write', chip: 'C140', register: 0x01, data: 0x40 },
        { type: 'chip_write', chip: 'C140', register: 0x04, data: 0x12 },
        { type: 'chip_write', chip: 'C140', register: 0x06, data: 0x34 },
        { type: 'chip_write', chip: 'C140', register: 0x07, data: 0x56 },
        { type: 'chip_write', chip: 'C140', register: 0x05, data: 0x80 },
      ],
    },
  ];

  for (const testCase of cases) {
    const converter = new MidiConverter({
      header: createHeader({ ym2151Clock: 0, ...testCase.header }),
      commands: [
        ...duplicateChipCommands(testCase.commands, 0),
        ...duplicateChipCommands(testCase.commands, 1),
        { type: 'wait', samples: 441 },
        { type: 'end' },
      ],
    }, { splitChips: true });
    converter.convert();
    const states = [...converter.tracks.values()]
      .filter(state => state.descriptor.chip === testCase.chip && state.track.events.some(event => event.name === 'NoteOnEvent'));
    assert.equal(states.length, 2, `${testCase.chip} must retain one note-bearing descriptor for each instance`);
    assert.deepEqual(states.map(state => state.descriptor.instance).sort(), [0, 1], `${testCase.chip} descriptors must include both instances`);
    assert.equal(new Set(states.map(state => state.descriptor.sourceKey)).size, 1, `${testCase.chip} must distinguish equal source keys by descriptor instance`);
    for (const state of states) {
      assert.equal(state.track.events.filter(event => event.name === 'NoteOnEvent').length, 1, `${testCase.chip} #${state.descriptor.instance + 1} note-on`);
      assert.equal(state.track.events.filter(event => event.name === 'NoteOffEvent').length, 1, `${testCase.chip} #${state.descriptor.instance + 1} EOF note-off`);
    }
    assert.ok(converter.warnings.some(warning => warning.includes('MIDI channel')), `${testCase.chip} simultaneous same-channel descriptors must warn`);

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `vgm2midi-descriptor-${testCase.chip}-`));
    const output = path.join(directory, 'overlap.mid');
    converter.exportToFile(output);
    assert.ok(fs.existsSync(output), `${testCase.chip} retains the combined MIDI`);
    assert.ok(fs.existsSync(path.join(directory, `overlap.${testCase.chip}.mid`)), `${testCase.chip} primary descriptor sidecar`);
    assert.ok(fs.existsSync(path.join(directory, `overlap.${testCase.chip}-2.mid`)), `${testCase.chip} second descriptor sidecar`);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('descriptor overlap warnings ignore non-overlapping use of a shared MIDI channel', () => {
  const converter = new MidiConverter({
    header: createHeader({ sn76489Clock: 3579545, ym2151Clock: 0 }),
    commands: [
      { type: 'psg_write', chip: 'SN76489', instance: 0, data: 0x80 },
      { type: 'psg_write', chip: 'SN76489', instance: 0, data: 0x06 },
      { type: 'psg_write', chip: 'SN76489', instance: 0, data: 0x90 },
      { type: 'wait', samples: 441 },
      { type: 'psg_write', chip: 'SN76489', instance: 0, data: 0x9F },
      { type: 'psg_write', chip: 'SN76489', instance: 1, data: 0x80 },
      { type: 'psg_write', chip: 'SN76489', instance: 1, data: 0x06 },
      { type: 'psg_write', chip: 'SN76489', instance: 1, data: 0x90 },
      { type: 'end' },
    ],
  });
  converter.convert();
  assert.deepEqual(converter.warnings, []);
});

test('GameBoy DMG frame sequencer clocks a length counter across a VGM wait', () => {
  const { converter } = convertGBDMGCommands([
    { type: 'chip_write', chip: 'GBDMG', register: 0x01, data: 0x3F }, // length = 1
    { type: 'chip_write', chip: 'GBDMG', register: 0x02, data: 0xF8 },
    { type: 'chip_write', chip: 'GBDMG', register: 0x03, data: 0xD6 },
    { type: 'chip_write', chip: 'GBDMG', register: 0x04, data: 0xC6 }, // trigger + length enable
    { type: 'wait', samples: 100 }, // crosses the first 512Hz frame tick at 86.13 samples
  ]);
  const events = converter.convert()[0].events;
  assert.equal(events.filter(event => event.name === 'NoteOnEvent').length, 1);
  assert.equal(events.filter(event => event.name === 'NoteOffEvent').length, 1);
  assert.equal(converter.channels.get('gbdmg_0').active, false);
});

test('GameBoy DMG frame sequencer emits envelope CC11 during a sustained note', () => {
  const { converter } = convertGBDMGCommands([
    { type: 'chip_write', chip: 'GBDMG', register: 0x02, data: 0xA9 }, // volume 10, increase, pace 1
    { type: 'chip_write', chip: 'GBDMG', register: 0x03, data: 0xD6 },
    { type: 'chip_write', chip: 'GBDMG', register: 0x04, data: 0x86 },
    { type: 'wait', samples: 700 }, // crosses frame-sequencer step 7 at ~689 samples
  ]);
  const events = converter.convert()[0].events;
  const expression = events.find(event => event.name === 'ControllerChangeEvent' && event.controllerNumber === 11);
  assert.ok(expression);
  assert.equal(expression.controllerValue, 93); // 11 / 15 * 127
  assert.equal(events.filter(event => event.name === 'NoteOnEvent').length, 1);
});

test('GameBoy DMG channel 1 sweep uses a pitch bend after frame-sequencer time advances', () => {
  const { converter } = convertGBDMGCommands([
    { type: 'chip_write', chip: 'GBDMG', register: 0x00, data: 0x11 }, // pace 1, increase, shift 1
    { type: 'chip_write', chip: 'GBDMG', register: 0x02, data: 0xF8 },
    { type: 'chip_write', chip: 'GBDMG', register: 0x03, data: 0xE8 },
    { type: 'chip_write', chip: 'GBDMG', register: 0x04, data: 0x83 }, // period 1000, trigger
    { type: 'wait', samples: 300 }, // frame step 2 clocks the first 128Hz sweep
  ]);
  const events = converter.convert()[0].events;
  assert.equal(events.filter(event => event.name === 'NoteOnEvent').length, 1);
  assert.equal(events.filter(event => event.name === 'PitchBendEvent').length, 2); // tuning + sweep
});

test('GameBoy DMG NR50/NR51 maps left, right and centre routes to CC10', () => {
  const { converter } = convertGBDMGCommands([
    { type: 'chip_write', chip: 'GBDMG', register: 0x14, data: 0x70 }, // left master only
    { type: 'chip_write', chip: 'GBDMG', register: 0x15, data: 0x11 }, // ch1 left + right route
    { type: 'chip_write', chip: 'GBDMG', register: 0x02, data: 0xF8 },
    { type: 'chip_write', chip: 'GBDMG', register: 0x03, data: 0xD6 },
    { type: 'chip_write', chip: 'GBDMG', register: 0x04, data: 0x86 },
    { type: 'wait', samples: 100 },
    { type: 'chip_write', chip: 'GBDMG', register: 0x14, data: 0x07 }, // right master only
    { type: 'wait', samples: 100 },
    { type: 'chip_write', chip: 'GBDMG', register: 0x14, data: 0x77 }, // both masters
  ]);
  const pans = converter.convert()[0].events
    .filter(event => event.name === 'ControllerChangeEvent' && event.controllerNumber === 10)
    .map(event => event.controllerValue);
  assert.deepEqual(pans, [0, 127, 64]);
});

test('parser and converter map Game Gear $4F stereo routing to CC10 left/right/centre', () => {
  const parsed = new VGMParser(createVgmBuffer([0x4F, 0x0F, 0x4F, 0xF0, 0x4F, 0xFF, 0x66])).parse();
  assert.deepEqual(parsed.commands.slice(0, 3).map(command => command.type), ['psg_stereo', 'psg_stereo', 'psg_stereo']);
  const converter = new MidiConverter({ header: createHeader({ ym2151Clock: 0 }), commands: parsed.commands });
  const pans = converter.convert().flatMap(track => track.events)
    .filter(event => event.name === 'ControllerChangeEvent' && event.controllerNumber === 10)
    .map(event => event.controllerValue);
  assert.deepEqual(pans, [0, 127, 64, 0, 127, 64, 0, 127, 64, 0, 127, 64]);
});

test('VGM $3F routes Game Gear stereo to the independent second SN76489 instance', () => {
  const parsed = new VGMParser(createVgmBuffer([0x3F, 0x0F, 0x66], 0x0172)).parse();
  assert.deepEqual(parsed.commands[0], { type: 'psg_stereo', chip: 'SN76489', instance: 1, data: 0x0F, command: 0x3F });
  const converter = new MidiConverter({ header: createHeader({ ym2151Clock: 0 }), commands: parsed.commands });
  const pans = converter.convert().flatMap(track => track.events)
    .filter(event => event.name === 'ControllerChangeEvent' && event.controllerNumber === 10)
    .map(event => event.controllerValue);
  assert.deepEqual(pans, [0, 0, 0, 0]);
  assert.ok([...converter.tracks.values()].some(track => track.descriptor.id === 'SN76489:1:tone:0:psg_0'));
});

test('VGM $31 parses AY/OPN SSG masks with primary and second chip instances', () => {
  const ayPrimary = new VGMParser(createVgmBuffer([0x31, 0x36, 0x66], 0x0172)).parse();
  const aySecond = new VGMParser(createVgmBuffer([0x31, 0xB6, 0x66], 0x0172)).parse();
  const ym2203Buffer = createVgmBuffer([0x31, 0x76, 0x66], 0x0172);
  ym2203Buffer.writeUInt32LE(4000000, 0x44);
  const ym2203 = new VGMParser(ym2203Buffer).parse();
  const ym2608Buffer = createVgmBuffer([0x31, 0xF6, 0x66], 0x0172);
  ym2608Buffer.writeUInt32LE(7987200, 0x48);
  const ym2608 = new VGMParser(ym2608Buffer).parse();
  assert.deepEqual(ayPrimary.commands[0], { type: 'ay_stereo', chip: 'AY8910', data: 0x36, command: 0x31 });
  assert.deepEqual(aySecond.commands[0], { type: 'ay_stereo', chip: 'AY8910', instance: 1, data: 0x36, command: 0x31 });
  assert.deepEqual(ym2203.commands[0], { type: 'ay_stereo', chip: 'YM2203', data: 0x36, command: 0x31 });
  assert.deepEqual(ym2608.commands[0], { type: 'ay_stereo', chip: 'YM2608', instance: 1, data: 0x36, command: 0x31 });
});

test('AY8910, YM2203 and YM2608 SSG masks map each channel to CC10', () => {
  for (const [chip, instance] of [['AY8910', 0], ['AY8910', 1], ['YM2203', 0], ['YM2608', 1]]) {
    const converter = new MidiConverter({
      header: createHeader({ ym2151Clock: 0 }),
      commands: [{ type: 'ay_stereo', chip, instance, data: 0x36 }, { type: 'end' }],
    });
    const pans = converter.convert().flatMap(track => track.events)
      .filter(event => event.name === 'ControllerChangeEvent' && event.controllerNumber === 10)
      .map(event => event.controllerValue);
    assert.deepEqual(pans, [0, 127, 64], `${chip} instance ${instance + 1}`);
  }
});

test('YM2151, YM2612 and YM2608 LR register masks map to CC10', () => {
  const cases = [
    ['YM2151', { ym2151Clock: 3579545 }, 0, 0x20],
    ['YM2612', { ym2612Clock: 7670453 }, 0, 0xB4],
    ['YM2608', { ym2608Clock: 7987200 }, 0, 0xB4],
  ];
  for (const [chip, header, port, register] of cases) {
    const converter = new MidiConverter({ header: createHeader({ ym2151Clock: 0, ...header }), commands: [
      { type: 'chip_write', chip, port, register, data: 0x80 },
      { type: 'chip_write', chip, port, register, data: 0x40 },
      { type: 'chip_write', chip, port, register, data: 0xC0 }, { type: 'end' },
    ] });
    const pans = converter.convert()[0].events.filter(event => event.name === 'ControllerChangeEvent' && event.controllerNumber === 10).map(event => event.controllerValue);
    assert.deepEqual(pans, [0, 127, 64], chip);
  }
});

test('HuC6280 global and per-channel balance combine into CC10 left/right/centre', () => {
  const converter = new MidiConverter({ header: createHeader({ ym2151Clock: 0, huc6280Clock: 3579545 }), commands: [
    { type: 'chip_write', chip: 'HuC6280', register: 0x00, data: 0x00 },
    { type: 'chip_write', chip: 'HuC6280', register: 0x01, data: 0xF0 }, { type: 'chip_write', chip: 'HuC6280', register: 0x05, data: 0xFF },
    { type: 'chip_write', chip: 'HuC6280', register: 0x01, data: 0x0F },
    { type: 'chip_write', chip: 'HuC6280', register: 0x01, data: 0xFF }, { type: 'end' },
  ] });
  const pans = converter.convert()[0].events.filter(event => event.name === 'ControllerChangeEvent' && event.controllerNumber === 10).map(event => event.controllerValue);
  assert.deepEqual(pans, [0, 127, 64]);
});
