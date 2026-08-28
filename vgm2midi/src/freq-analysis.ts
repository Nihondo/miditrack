import { VGMParser } from './vgm-parser';

const parser = VGMParser.fromFile('02 Departure.vgm');
const vgmData = parser.parse();

const channels = [
  { frequency: 0, volume: 15, freqHistory: [] as number[] },
  { frequency: 0, volume: 15, freqHistory: [] as number[] },
  { frequency: 0, volume: 15, freqHistory: [] as number[] },
];

let lastLatchedChannel = 0;

for (const cmd of vgmData.commands.slice(0, 500)) {
  if (cmd.type === 'psg_write' && cmd.data !== undefined) {
    const data = cmd.data;

    if ((data & 0x80) === 0x80) {
      const channel = (data >> 5) & 0x03;
      const type = (data >> 4) & 0x01;
      const nibble = data & 0x0F;
      lastLatchedChannel = channel;

      if (type === 0 && channel < 3) {
        channels[channel].frequency = (channels[channel].frequency & 0x3F0) | nibble;
      } else if (type === 1 && channel < 3) {
        channels[channel].volume = nibble;
      }
    } else {
      const channel = lastLatchedChannel;
      if (channel < 3) {
        const dataBits = data & 0x3F;
        channels[channel].frequency = (dataBits << 4) | (channels[channel].frequency & 0x0F);

        if (channels[channel].volume < 0x0F) {
          channels[channel].freqHistory.push(channels[channel].frequency);
        }
      }
    }
  }
}

for (let ch = 0; ch < 3; ch++) {
  const history = channels[ch].freqHistory;
  if (history.length === 0) continue;

  console.log(`\nChannel ${ch} frequency changes:`);
  console.log(`Total frequency updates: ${history.length}`);

  // Show first 20 changes
  console.log('First 20 frequency values (register):');
  history.slice(0, 20).forEach((freq, i) => {
    const hz = (3579545 / (32 * freq)).toFixed(2);
    const midi = Math.round(69 + 12 * Math.log2(parseFloat(hz) / 440));
    const prevMidi = i > 0 ? Math.round(69 + 12 * Math.log2((3579545 / (32 * history[i-1])) / 440)) : midi;
    const diff = midi - prevMidi;
    console.log(`  ${i}: 0x${freq.toString(16).padStart(3, '0')} = ${hz} Hz = MIDI ${midi} ${diff !== 0 ? `(${diff > 0 ? '+' : ''}${diff} semitones)` : ''}`);
  });
}
