import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** libvgm helper invocation contract for sample-exact chip stem rendering. */
export function renderLibvgmStems(inputPath: string, outputDirectory: string, totalSamples: number): void {
  const helper = process.env.VGM2MIDI_STEMS_HELPER
    ?? path.join(__dirname, '..', 'native', 'bin', 'vgm2midi_stems');
  if (!fs.existsSync(helper)) {
    throw new Error(`--stems requires the native helper; run vgm2midi/scripts/build-native.sh or set VGM2MIDI_STEMS_HELPER (${helper})`);
  }
  fs.mkdirSync(outputDirectory, { recursive: true });
  const base = path.parse(inputPath).name;
  const manifest = path.join(outputDirectory, `${base}.stems.json`);
  const result = childProcess.spawnSync(helper, [inputPath, outputDirectory, String(totalSamples), manifest], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`libvgm stems helper failed: ${result.stderr.trim() || result.stdout.trim()}`);
  if (!fs.existsSync(manifest)) throw new Error('libvgm stems helper completed without a manifest');
}
