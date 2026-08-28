import { VGMParser } from './vgm-parser';

const parser = VGMParser.fromFile('02 Departure.vgm');
const vgmData = parser.parse();

interface NoteEvent {
  channel: number;
  type: 'on' | 'off';
  time: number;
  freq?: number;
  midi?: number;
}

const events: NoteEvent[] = [];
const channels = [
  { frequency: 0, volume: 15 },
  { frequency: 0, volume: 15 },
  { frequency: 0, volume: 15 },
];

let time = 0;
let lastLatchedChannel = 0;

for (const cmd of vgmData.commands) {
  if (cmd.type === 'wait' && cmd.samples) {
    time += cmd.samples;
  } else if (cmd.type === 'psg_write' && cmd.data !== undefined) {
    const data = cmd.data;

    if ((data & 0x80) === 0x80) {
      const channel = (data >> 5) & 0x03;
      const type = (data >> 4) & 0x01;
      const nibble = data & 0x0F;
      lastLatchedChannel = channel;

      if (type === 0 && channel < 3) {
        channels[channel].frequency = (channels[channel].frequency & 0x3F0) | nibble;
      } else if (type === 1 && channel < 3) {
        const oldVolume = channels[channel].volume;
        channels[channel].volume = nibble;

        const wasOff = oldVolume === 0x0F;
        const isOff = nibble === 0x0F;

        if (wasOff && !isOff) {
          events.push({ channel, type: 'on', time });
        } else if (!wasOff && isOff) {
          const freq = 3579545 / (32 * channels[channel].frequency);
          const midi = Math.round(69 + 12 * Math.log2(freq / 440));
          events.push({ channel, type: 'off', time, freq, midi });
        }
      }
    } else {
      const channel = lastLatchedChannel;
      if (channel < 3) {
        const dataBits = data & 0x3F;
        channels[channel].frequency = (dataBits << 4) | (channels[channel].frequency & 0x0F);
      }
    }
  }
}

// Pair note on/off events
const notes: Array<{ channel: number; startTime: number; endTime: number; midi: number; durationSamples: number }> = [];
const activeNotes: Map<number, number> = new Map();

for (const event of events) {
  if (event.type === 'on') {
    activeNotes.set(event.channel, event.time);
  } else if (event.type === 'off' && activeNotes.has(event.channel)) {
    const startTime = activeNotes.get(event.channel)!;
    const durationSamples = event.time - startTime;
    notes.push({
      channel: event.channel,
      startTime,
      endTime: event.time,
      midi: event.midi!,
      durationSamples
    });
    activeNotes.delete(event.channel);
  }
}

// Analyze note durations
console.log('Note Duration Analysis:');
console.log('======================\n');

for (let ch = 0; ch < 3; ch++) {
  const channelNotes = notes.filter(n => n.channel === ch);
  if (channelNotes.length === 0) continue;

  const durations = channelNotes.map(n => n.durationSamples);
  const minDuration = Math.min(...durations);
  const maxDuration = Math.max(...durations);
  const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;

  console.log(`Channel ${ch}:`);
  console.log(`  Total notes: ${channelNotes.length}`);
  console.log(`  Duration range: ${(minDuration / 44100).toFixed(3)}s - ${(maxDuration / 44100).toFixed(3)}s`);
  console.log(`  Average duration: ${(avgDuration / 44100).toFixed(3)}s`);
  console.log(`  MIDI note range: ${Math.min(...channelNotes.map(n => n.midi))} - ${Math.max(...channelNotes.map(n => n.midi))}`);
  console.log('');

  // Show first 10 notes
  console.log('  First 10 notes:');
  channelNotes.slice(0, 10).forEach((n, i) => {
    const durationMs = (n.durationSamples / 44100 * 1000).toFixed(1);
    const startSec = (n.startTime / 44100).toFixed(2);
    console.log(`    ${i + 1}. MIDI ${n.midi} at ${startSec}s, duration ${durationMs}ms`);
  });
  console.log('');
}
