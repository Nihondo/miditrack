"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vgm_parser_1 = require("./vgm-parser");
const parser = vgm_parser_1.VGMParser.fromFile('02 Departure.vgm');
const vgmData = parser.parse();
console.log('Complete VGM command dump (first 200 commands):\n');
let time = 0;
let cmdCount = 0;
for (const cmd of vgmData.commands) {
    if (cmdCount >= 200)
        break;
    if (cmd.type === 'wait' && cmd.samples) {
        time += cmd.samples;
        const ms = (cmd.samples / 44.1).toFixed(1);
        console.log(`[${cmdCount}] Wait ${cmd.samples} samples (${ms}ms) - time now: ${time}`);
    }
    else if (cmd.type === 'psg_write' && cmd.data !== undefined) {
        const data = cmd.data;
        const binary = data.toString(2).padStart(8, '0');
        const hex = data.toString(16).padStart(2, '0');
        if ((data & 0x80) === 0x80) {
            const channel = (data >> 5) & 0x03;
            const type = (data >> 4) & 0x01;
            const nibble = data & 0x0F;
            const typeStr = type === 0 ? 'TONE' : 'VOL';
            console.log(`[${cmdCount}] 0x${hex} ${binary} - Ch${channel} ${typeStr} data=0x${nibble.toString(16)} (time: ${time})`);
        }
        else {
            const dataBits = data & 0x3F;
            console.log(`[${cmdCount}] 0x${hex} ${binary} - DATA 0x${dataBits.toString(16)} (time: ${time})`);
        }
    }
    else if (cmd.type === 'end') {
        console.log(`[${cmdCount}] END (time: ${time})`);
        break;
    }
    else {
        console.log(`[${cmdCount}] ${cmd.type} (time: ${time})`);
    }
    cmdCount++;
}
console.log(`\nTotal time: ${(time / 44100).toFixed(2)} seconds`);
