import { VGMParser } from './vgm-parser';

const parser = VGMParser.fromFile('02 Departure.vgm');
const vgmData = parser.parse();

console.log('Analyzing PSG Channel 2 (Tone 3) commands...');

let time = 0;
let lastLatchedChannel = 0;
let ch2Freq = 0;

// Only look at first few seconds where the issue likely is
const limitSamples = 44100 * 5; 

for (const cmd of vgmData.commands) {
  if (cmd.type === 'wait' && cmd.samples) {
    time += cmd.samples;
    if (time > limitSamples) break;
  }
  else if (cmd.type === 'psg_write' && cmd.data !== undefined) {
    const data = cmd.data;
    
    if ((data & 0x80) === 0x80) {
        // Latch
        const channel = (data >> 5) & 0x03;
        lastLatchedChannel = channel;
        
        if (channel === 2) {
            const type = (data >> 4) & 0x01;
            const nibble = data & 0x0F;
            if (type === 0) {
                // Tone Latch (Low 4 bits)
                // Keep upper 6 bits, set lower 4
                const oldFreq = ch2Freq;
                ch2Freq = (ch2Freq & 0x3F0) | nibble;
                console.log(`[${time}] Ch2 Freq LATCH: ${ch2Freq} (Low=${nibble.toString(16)})`);
            } else {
                // Volume
                console.log(`[${time}] Ch2 Volume: ${nibble} (0=Loud, 15=Silent)`);
            }
        }
    } else {
        // Data byte
        if (lastLatchedChannel === 2) {
            const dataBits = data & 0x3F; // 6 bits
            // Set upper 6 bits
            const oldFreq = ch2Freq;
            ch2Freq = (dataBits << 4) | (ch2Freq & 0x0F);
            console.log(`[${time}] Ch2 Freq DATA:  ${ch2Freq} (High=${dataBits.toString(16)})`);
        }
    }
  }
}
