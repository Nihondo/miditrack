#!/usr/bin/env node
/* Read-only VGM/VGZ corpus audit. ZIP entries are passed to the parser as Buffers. */
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { MidiConverter } = require('../dist/midi-converter');
const { VGMParser } = require('../dist/vgm-parser');
const { prepareVGMPlayback } = require('../dist/vgm-playback');

const corpusRoot = process.env.VGM2MIDI_CORPUS_ROOT;
const expectedSongs = process.env.VGM2MIDI_EXPECTED_SONGS === undefined
  ? undefined : Number(process.env.VGM2MIDI_EXPECTED_SONGS);
if (!corpusRoot) throw new Error('Set VGM2MIDI_CORPUS_ROOT to a read-only corpus root');
if (expectedSongs !== undefined && (!Number.isInteger(expectedSongs) || expectedSongs < 0)) {
  throw new Error('VGM2MIDI_EXPECTED_SONGS must be a non-negative integer');
}

/** VGM/VGZとして解析対象にするパス名か判定する。 */
function isVgmPath(filePath) { return /\.vg(?:m|z)$/i.test(filePath); }

/** archiveとして数える拡張子か判定する。 */
function isArchivePath(filePath) { return /\.(zip|7z|rar)$/i.test(filePath); }

/** ZIP内のVGM/VGZ entry名を、展開せずに列挙する。 */
function listZipEntries(archivePath) {
  const output = childProcess.execFileSync('unzip', ['-Z1', archivePath], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  return output.split(/\r?\n/).filter(isVgmPath);
}

/** ZIP entryを一時ファイルなしでBufferとして読む。 */
function readZipEntry(archivePath, entryName) {
  return childProcess.execFileSync('unzip', ['-p', archivePath, entryName], {
    encoding: 'buffer', maxBuffer: 512 * 1024 * 1024,
  });
}

/** root配下のdirect VGM/VGZとZIPを読み取り専用で列挙する。 */
function collectInputs(root) {
  const direct = []; const archives = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (isVgmPath(entry.name)) direct.push(fullPath);
      else if (isArchivePath(entry.name)) archives.push(fullPath);
    }
  };
  walk(root);
  return { direct: direct.sort(), archives: archives.sort() };
}

/** diagnostics chip+instance組合せを曲単位で集計する。 */
function addDiagnostics(summary, diagnostics) {
  for (const chip of diagnostics.chips) {
    const key = `${chip.chip}#${chip.instance + 1}`;
    summary.chipInstances[key] = (summary.chipInstances[key] || 0) + 1;
  }
  if (diagnostics.hasOmittedContent) {
    summary.partialSongs += 1;
    summary.unsupportedCommands += diagnostics.unsupportedCommandCount;
    summary.unsupportedWrites += diagnostics.unsupportedWriteCount;
  }
}

/** 変換を出力なしで実行し、zero-noteとMSM trigger候補を数える。 */
function inspectMidiCandidates(summary, data) {
  const tracks = new MidiConverter(data).convert();
  const noteCount = tracks.reduce((total, track) => total + track.events.filter(event => event.name === 'NoteOnEvent').length, 0);
  if (noteCount === 0) summary.zeroNoteSongs += 1;
  const msmStreamIds = new Set(data.commands
    .filter(command => command.type === 'stream_setup' && command.targetChip === 'MSM6258')
    .map(command => command.streamId));
  const hasMsmStream = data.commands.some(command =>
    (command.type === 'stream_start' || command.type === 'stream_start_fast')
      && msmStreamIds.has(command.streamId));
  if (hasMsmStream) summary.msmTriggerCandidates += 1;
  return noteCount;
}

/** 一つのBufferをVGM/VGZとして解析し、playbackとdiagnosticsを監査する。 */
function auditBuffer(summary, source, buffer) {
  try {
    const data = VGMParser.fromBuffer(buffer).parse();
    const playback = prepareVGMPlayback(data);
    addDiagnostics(summary, data.diagnostics);
    const noteCount = inspectMidiCandidates(summary, playback.data);
    summary.parsedSongs += 1;
    summary.totalSamples += playback.totalSamples;
    if (noteCount > 0) summary.noteBearingSongs += 1;
  } catch (error) {
    summary.parseErrors.push({ source, message: error instanceof Error ? error.message : String(error) });
  }
}

function main() {
  const inputs = collectInputs(corpusRoot);
  const summary = {
    root: corpusRoot,
    mutation: 'none',
    directFiles: inputs.direct.length,
    archiveCount: inputs.archives.length,
    zipArchiveCount: 0,
    unsupportedArchiveCount: 0,
    songCount: 0,
    parsedSongs: 0,
    noteBearingSongs: 0,
    zeroNoteSongs: 0,
    msmTriggerCandidates: 0,
    partialSongs: 0,
    unsupportedCommands: 0,
    unsupportedWrites: 0,
    totalSamples: 0,
    chipInstances: {},
    parseErrors: [],
  };

  for (const filePath of inputs.direct) {
    summary.songCount += 1;
    auditBuffer(summary, filePath, fs.readFileSync(filePath));
  }
  for (const archivePath of inputs.archives) {
    if (!/\.zip$/i.test(archivePath)) {
      summary.unsupportedArchiveCount += 1;
      continue;
    }
    summary.zipArchiveCount += 1;
    try {
      for (const entryName of listZipEntries(archivePath)) {
        summary.songCount += 1;
        auditBuffer(summary, `${archivePath}!${entryName}`, readZipEntry(archivePath, entryName));
      }
    } catch (error) {
      summary.parseErrors.push({ source: archivePath, message: error instanceof Error ? error.message : String(error) });
    }
  }
  summary.chipInstances = Object.fromEntries(Object.entries(summary.chipInstances).sort(([left], [right]) => left.localeCompare(right)));
  summary.expectedSongCount = expectedSongs;
  summary.expectedSongCountMatches = expectedSongs === undefined ? undefined : summary.songCount === expectedSongs;
  console.log(JSON.stringify(summary, null, 2));
  if (summary.parseErrors.length > 0 || summary.expectedSongCountMatches === false) process.exitCode = 1;
}

main();
