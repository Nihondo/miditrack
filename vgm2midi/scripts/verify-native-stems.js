#!/usr/bin/env node
/* libvgm stem acceptance: synthetic dual-device source, exact frames, additive RMS. */
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { VGMParser } = require('../dist/vgm-parser');
const { prepareVGMPlayback } = require('../dist/vgm-playback');

/** SN76489+YM2151の最小multi-device VGMを一時領域へ書く。 */
function writeFixture(directory) {
  const commands = Buffer.from([0x50, 0x86, 0x50, 0x00, 0x50, 0x90, 0x54, 0x28, 0x4A, 0x54, 0x08, 0x78, 0x61, 0x44, 0xAC, 0x54, 0x08, 0x00, 0x50, 0x9F, 0x66]);
  const dataOffset = 0x100; const buffer = Buffer.alloc(dataOffset + commands.length);
  buffer.write('Vgm ', 0, 'ascii'); buffer.writeUInt32LE(buffer.length - 4, 4); buffer.writeUInt32LE(0x0161, 8);
  buffer.writeUInt32LE(3579545, 0x0C); buffer.writeUInt32LE(44100, 0x18); buffer.writeUInt32LE(dataOffset - 0x1C, 0x1C); buffer.writeUInt32LE(44100, 0x20);
  buffer.writeUInt32LE(3579545, 0x30); buffer.writeUInt32LE(dataOffset - 0x34, 0x34); commands.copy(buffer, dataOffset);
  const input = path.join(directory, 'native-stems-synthetic.vgm'); fs.writeFileSync(input, buffer); return input;
}

/** S16 stereo WAVをInt16配列として読む。 */
function readSamples(file) { const wav = fs.readFileSync(file); assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); return new Int16Array(wav.buffer, wav.byteOffset + 44, (wav.length - 44) / 2); }
function readFrames(file) { return (fs.statSync(file).size - 44) / 4; }
function measureRms(file) { const samples = readSamples(file); return Math.sqrt(Array.from(samples, value => value * value).reduce((sum, value) => sum + value, 0) / samples.length); }

/** stem和とfull mixとの差分RMSをdBFSで返す。 */
function measureDifference(mix, stems) {
  const master = readSamples(mix); const sources = stems.map(readSamples); let sumSquares = 0;
  for (let index = 0; index < master.length; index++) { const added = sources.reduce((sum, source) => sum + source[index], 0); const difference = master[index] - added; sumSquares += difference * difference; }
  return 20 * Math.log10(Math.sqrt(sumSquares / master.length) / 32768 || Number.MIN_VALUE);
}

/** helper manifestのsampleCount/WAV headerをTypeScript playbackのtotalSamplesと照合する。 */
function verifyMode(helper, input, directory, label, totalSamples) {
  const output = path.join(directory, label); fs.mkdirSync(output); const manifest = path.join(output, `${path.parse(input).name}.stems.json`);
  childProcess.execFileSync(helper, [input, output, String(totalSamples), manifest], { stdio: 'pipe' });
  const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8')); assert.equal(parsed.sampleCount, totalSamples);
  for (const stem of parsed.stems) { assert.equal(stem.sampleCount, totalSamples); assert.equal(readFrames(stem.path), totalSamples); }
  return parsed;
}

/** quote/backslashを含む入力名・出力directoryでもmanifestが正しいJSONか検証する。 */
function verifyEscapedManifest(helper, input, directory, totalSamples) {
  const escapedInput = path.join(directory, 'native "quote" \\ stem.vgm');
  const escapedOutput = path.join(directory, 'output "quote" \\ stems');
  fs.copyFileSync(input, escapedInput); fs.mkdirSync(escapedOutput);
  const manifest = path.join(escapedOutput, 'manifest.json');
  childProcess.execFileSync(helper, [escapedInput, escapedOutput, String(totalSamples), manifest], { stdio: 'pipe' });
  const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const expectedMix = path.join(escapedOutput, `${path.parse(escapedInput).name}.mix.wav`);
  assert.equal(parsed.stems[0].path, expectedMix);
  for (const stem of parsed.stems) assert.ok(fs.existsSync(stem.path), `escaped manifest path must exist: ${stem.path}`);
  return parsed;
}

/** channel selector modeが指定デバイスだけを正確なframe数で描画することを検証する。 */
function verifySelection(helper, input, directory, totalSamples) {
  const output = path.join(directory, 'selected-sn-channel-0.wav');
  childProcess.execFileSync(helper, ['--selection', input, output, String(totalSamples), '0:0:1:0'], { stdio: 'pipe' });
  assert.equal(readFrames(output), totalSamples);
  assert.ok(measureRms(output) > 0, 'selected SN76489 channel must produce non-silent audio');
  return output;
}

/** HuC6280 (PC Engine PSG) MAMEコア（Ootakeコアからの切替後）の最小VGMを書く。
 * HuC6280はSN76489と異なり32段の波形テーブル方式なので、$06への書き込み
 * (channel enable前、indexが自動インクリメントされる間)が無いと無音になる。
 * さらにc6280_mame.cのvolume_table[31]は無音を意味するため、global/channel
 * balanceレジスタ($01/$05)を既定値の0のままにすると音量計算が無音側に
 * クランプされる — 両方とも高い値(0xFFなど)にする必要がある。 */
function writeHuC6280Fixture(directory) {
  const bytes = [0xb9, 0x00, 0x00]; // select channel 0
  for (let i = 0; i < 32; i++) bytes.push(0xb9, 0x06, i < 16 ? 0x1f : 0x00); // 32-step waveform, half max half zero
  bytes.push(
    0xb9, 0x02, 0x00, // freq low (period 0x200 -> ~218Hz @ 3579545Hz clock)
    0xb9, 0x03, 0x02, // freq high
    0xb9, 0x01, 0xff, // global balance: left=right=0xF
    0xb9, 0x05, 0xff, // channel balance: left=right=0xF
    0xb9, 0x04, 0x9f, // enable, channel volume=31 (max)
    0x61, 0x44, 0xac, // wait 44100 samples
    0x66, // end of sound data
  );
  const commands = Buffer.from(bytes);
  const dataOffset = 0x100;
  const buffer = Buffer.alloc(dataOffset + commands.length);
  buffer.write('Vgm ', 0, 'ascii'); buffer.writeUInt32LE(buffer.length - 4, 4); buffer.writeUInt32LE(0x0161, 8);
  buffer.writeUInt32LE(44100, 0x18); buffer.writeUInt32LE(3579545, 0xa4); buffer.writeUInt32LE(dataOffset - 0x34, 0x34);
  commands.copy(buffer, dataOffset);
  const input = path.join(directory, 'huc6280-synthetic.vgm'); fs.writeFileSync(input, buffer); return input;
}

/** HuC6280のMAMEコアが実際に可聴音を、想定周波数どおりに描画することを検証する。 */
function verifyHuC6280(helper, directory) {
  const input = writeHuC6280Fixture(directory);
  const output = path.join(directory, 'huc6280-stems'); fs.mkdirSync(output);
  const manifest = path.join(output, 'huc6280.stems.json');
  childProcess.execFileSync(helper, [input, output, '44100', manifest], { stdio: 'pipe' });
  const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  assert.equal(parsed.stems.length, 2, 'expected mix + exactly one HuC6280 device stem');
  const [, device] = parsed.stems;
  const samples = readSamples(device.path);
  const peak = Math.max(...Array.from(samples, Math.abs));
  assert.ok(peak > 1000, `HuC6280 (MAME core) stem must be clearly audible, got peak=${peak}`);
  let crossings = 0;
  for (let index = 2; index < samples.length; index += 2) {
    if ((samples[index - 2] < 0) !== (samples[index] < 0)) crossings++;
  }
  const frequencyHz = crossings / 2 / ((samples.length / 2) / 44100);
  assert.ok(Math.abs(frequencyHz - 218) < 5, `HuC6280 tone frequency ${frequencyHz.toFixed(1)}Hz should be ~218Hz`);
  return { peak, frequencyHz };
}

function main() {
  const helper = process.env.VGM2MIDI_STEMS_HELPER || '/tmp/vgm2midi-native-build/vgm2midi_stems';
  assert.ok(fs.existsSync(helper), `native helper missing: ${helper}`);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgm2midi-stems-'));
  const input = writeFixture(directory); const data = new VGMParser(fs.readFileSync(input)).parse();
  const modes = [
    ['default', prepareVGMPlayback(data, {})],
    ['loops', prepareVGMPlayback(data, { loopCount: 2 })],
    ['duration', prepareVGMPlayback(data, { durationSeconds: 0.5 })],
  ];
  const results = modes.map(([label, playback]) => [label, verifyMode(helper, input, directory, label, playback.totalSamples)]);
  const defaultManifest = results[0][1]; const mix = defaultManifest.stems[0].path; const deviceStems = defaultManifest.stems.slice(1).map(stem => stem.path);
  assert.ok(deviceStems.length >= 2, 'synthetic fixture must enumerate at least two devices');
  const differenceDbfs = measureDifference(mix, deviceStems); assert.ok(differenceDbfs <= -80, `stem sum difference ${differenceDbfs.toFixed(2)} dBFS exceeds -80 dBFS`);
  const escapedManifest = verifyEscapedManifest(helper, input, directory, results[0][1].sampleCount);
  const selectionPath = verifySelection(helper, input, directory, results[0][1].sampleCount);
  const huc6280 = verifyHuC6280(helper, directory);
  console.log(JSON.stringify({ frames: Object.fromEntries(results.map(([label, manifest]) => [label, manifest.sampleCount])), devices: deviceStems.length, differenceDbfs, escapedManifestPath: escapedManifest.stems[0].path, selectionPath, huc6280 }, null, 2));
}
main();
