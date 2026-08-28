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
  console.log(JSON.stringify({ frames: Object.fromEntries(results.map(([label, manifest]) => [label, manifest.sampleCount])), devices: deviceStems.length, differenceDbfs, escapedManifestPath: escapedManifest.stems[0].path, selectionPath }, null, 2));
}
main();
