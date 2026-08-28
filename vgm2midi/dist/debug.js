"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vgm_parser_1 = require("./vgm-parser");
const parser = vgm_parser_1.VGMParser.fromFile('02 Departure.vgm');
const vgmData = parser.parse();
console.log('First 100 commands:');
vgmData.commands.slice(0, 100).forEach((cmd, i) => {
    if (cmd.type === 'psg_write') {
        const binary = cmd.data?.toString(2).padStart(8, '0');
        console.log(`${i}: PSG write 0x${cmd.data?.toString(16).padStart(2, '0')} (${binary})`);
    }
    else if (cmd.type === 'wait') {
        console.log(`${i}: Wait ${cmd.samples} samples`);
    }
    else {
        console.log(`${i}: ${cmd.type}`, cmd);
    }
});
// Check what types of commands we have
const cmdTypes = new Map();
vgmData.commands.forEach(cmd => {
    cmdTypes.set(cmd.type, (cmdTypes.get(cmd.type) || 0) + 1);
});
console.log('\nCommand summary:');
cmdTypes.forEach((count, type) => {
    console.log(`  ${type}: ${count}`);
});
