#!/usr/bin/env node
/* Verify locally-synced, hash-pinned VGM/VGZ representative cases. */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { MidiConverter } = require('../dist/midi-converter');
const { VGMParser } = require('../dist/vgm-parser');
const { prepareVGMPlayback } = require('../dist/vgm-playback');

const repositoryRoot = path.resolve(__dirname, '../..');
const corpusRoot = process.env.REAL_CORPUS_ROOT || path.join(repositoryRoot, 'testdata', 'real-corpus');
const manifestPath = path.join(repositoryRoot, 'tests', 'real_corpus_cases.json');

function sha256(content) { return crypto.createHash('sha256').update(content).digest('hex'); }

function noteOnCount(tracks) {
  return tracks.reduce((total, track) => total + track.events.filter(event => event.name === 'NoteOnEvent').length, 0);
}

function verifyCase(testCase) {
  const inputPath = path.join(corpusRoot, testCase.destination);
  const content = fs.readFileSync(inputPath);
  if (sha256(content) !== testCase.sha256) throw new Error(`${testCase.id}: SHA-256 mismatch`);
  const playback = prepareVGMPlayback(VGMParser.fromBuffer(content).parse());
  if (testCase.expectedOmittedContent === true && !playback.data.diagnostics.hasOmittedContent) {
    throw new Error(`${testCase.id}: expected unsupported content diagnostic`);
  }
  const diagnostics = new Map(playback.data.diagnostics.chips.map(chip => [chip.chip, chip]));
  for (const [chipName, expectedSupport] of Object.entries(testCase.requiredChips)) {
    const diagnostic = diagnostics.get(chipName);
    if (!diagnostic) throw new Error(`${testCase.id}: missing expected chip ${chipName}`);
    if (diagnostic.midiSupport !== expectedSupport) {
      throw new Error(`${testCase.id}: ${chipName} support is ${diagnostic.midiSupport}, expected ${expectedSupport}`);
    }
  }
  const actualNoteOns = noteOnCount(new MidiConverter(playback.data).convert());
  if (actualNoteOns < testCase.minimumNoteOns) {
    throw new Error(`${testCase.id}: Note On count ${actualNoteOns} is below ${testCase.minimumNoteOns}`);
  }
  console.log(`ok ${testCase.id}: ${Object.keys(testCase.requiredChips).join(', ')} (${actualNoteOns} Note On)`);
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const cases = manifest.cases.filter(testCase => testCase.format === 'vgm');
  if (!fs.existsSync(corpusRoot)) throw new Error(`real corpus is missing: ${corpusRoot}; run scripts/sync_real_corpus.py first`);
  for (const testCase of cases) verifyCase(testCase);
  console.log(`verified ${cases.length} VGM/VGZ real corpus cases`);
}

main();
