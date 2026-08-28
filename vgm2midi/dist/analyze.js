"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vgm_parser_1 = require("./vgm-parser");
const parser = vgm_parser_1.VGMParser.fromFile('02 Departure.vgm');
const vgmData = parser.parse();
console.log('Analyzing PSG commands in detail:\n');
const channels = [
    { frequency: 0, volume: 15 },
    { frequency: 0, volume: 15 },
    { frequency: 0, volume: 15 },
    { frequency: 0, volume: 15 },
];
let lastLatchedChannel = 0;
let time = 0;
let noteCount = 0;
for (let i = 0; i < Math.min(1000, vgmData.commands.length); i++) {
    const cmd = vgmData.commands[i];
    if (cmd.type === 'wait' && cmd.samples) {
        time += cmd.samples;
    }
    else if (cmd.type === 'psg_write' && cmd.data !== undefined) {
        const data = cmd.data;
        const binary = data.toString(2).padStart(8, '0');
        if ((data & 0x80) === 0x80) {
            // Latch byte
            const channel = (data >> 5) & 0x03;
            const type = (data >> 4) & 0x01;
            const nibble = data & 0x0F;
            lastLatchedChannel = channel;
            if (type === 0) {
                // Tone
                channels[channel].frequency = (channels[channel].frequency & 0x3F0) | nibble;
                console.log(`[${i}] 0x${data.toString(16)} ${binary} - Ch${channel} TONE latch, freq low bits=${nibble.toString(16)}, total freq=0x${channels[channel].frequency.toString(16)}`);
            }
            else {
                // Volume
                const oldVol = channels[channel].volume;
                channels[channel].volume = nibble;
                console.log(`[${i}] 0x${data.toString(16)} ${binary} - Ch${channel} VOLUME ${oldVol}→${nibble} ${nibble === 0x0F ? '(SILENT)' : '(AUDIBLE)'}`);
                if (channel < 3 && nibble < 0x0F && channels[channel].frequency > 0) {
                    const freq = 3579545 / (32 * channels[channel].frequency);
                    const midi = Math.round(69 + 12 * Math.log2(freq / 440));
                    console.log(`  → NOTE ON: Ch${channel}, freq=${channels[channel].frequency} (${freq.toFixed(2)} Hz), MIDI=${midi}, time=${time}`);
                    noteCount++;
                    if (noteCount >= 20)
                        break;
                }
                else if (channel < 3 && nibble === 0x0F && oldVol < 0x0F) {
                    console.log(`  → NOTE OFF: Ch${channel}, time=${time}`);
                }
            }
        }
        else {
            // Data byte
            const dataBits = data & 0x3F;
            const channel = lastLatchedChannel;
            const oldFreq = channels[channel].frequency;
            channels[channel].frequency = (dataBits << 4) | (channels[channel].frequency & 0x0F);
            console.log(`[${i}] 0x${data.toString(16)} ${binary} - Ch${channel} TONE data, freq high bits=${dataBits.toString(16)}, total freq=0x${channels[channel].frequency.toString(16)} (was 0x${oldFreq.toString(16)})`);
            if (channel < 3 && channels[channel].volume < 0x0F) {
                const freq = 3579545 / (32 * channels[channel].frequency);
                const midi = Math.round(69 + 12 * Math.log2(freq / 440));
                console.log(`  → FREQ CHANGE: Ch${channel}, freq=${channels[channel].frequency} (${freq.toFixed(2)} Hz), MIDI=${midi}, time=${time}`);
            }
        }
    }
}
console.log(`\n\nChannel states after ${noteCount} note events:`);
channels.forEach((ch, i) => {
    if (i < 3) {
        const freq = ch.frequency > 0 ? (3579545 / (32 * ch.frequency)).toFixed(2) : '0';
        console.log(`Channel ${i}: freq=0x${ch.frequency.toString(16)}, volume=${ch.volume}, Hz=${freq}`);
    }
});
