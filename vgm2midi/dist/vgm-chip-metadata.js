"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.COMMAND_CHIPS = exports.STREAM_DEVICE_CHIPS = exports.Y8950_ADPCM_REGISTERS = exports.DUAL_CHIP_FLAG = exports.CLOCK_MASK = void 0;
exports.unsupportedOperandCount = unsupportedOperandCount;
/** VGM 1.72 command/chip metadata. Parser and diagnostics share this single table. */
exports.CLOCK_MASK = 0x3FFFFFFF;
exports.DUAL_CHIP_FLAG = 0x40000000;
/** Y8950のFM部と共有されない、今回変換対象外のDelta-T ADPCMレジスタ。 */
exports.Y8950_ADPCM_REGISTERS = new Set([
    0x07,
    0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10, 0x11, 0x12,
    0x15, 0x16, 0x17,
]);
/** Header clock-order used by DAC stream target device numbers. */
exports.STREAM_DEVICE_CHIPS = [
    'SN76489', 'YM2413', 'YM2612', 'YM2151', 'SegaPCM', 'RF5C68', 'YM2203', 'YM2608',
    'YM2610', 'YM3812', 'YM3526', 'Y8950', 'YMF262', 'YMF278B', 'YMF271', 'YMZ280B',
    'RF5C164', 'PWM', 'AY8910', 'GBDMG', 'NESAPU', 'MultiPCM', 'uPD7759', 'MSM6258',
    'MSM6295', 'K051649', 'K054539', 'HuC6280', 'C140', 'K053260', 'Pokey', 'QSound',
    'SCSP', 'WonderSwan', 'VSU', 'SAA1099', 'ES5503', 'ES5506', 'X1-010', 'C352', 'GA20', 'Mikey',
    'K007232', 'K005289', 'MSM5205', 'MSM5232', 'BSMT2000', 'ICS2115',
];
/**
 * VGM 1.72 の定義済み chip-write command 一覧。
 * instanceOperand は第1引数（SegaPCMだけ第2引数）の bit 7 で第2 chip を示す。
 */
exports.COMMAND_CHIPS = {
    0x30: { chip: 'SN76489', width: 1, instance: 1 },
    0x31: { chip: 'AY8910/YM2203 SSG stereo', width: 1, minVersion: 0x0171 },
    0x32: { chip: 'MSM5205', width: 1, instanceOperand: 0, minVersion: 0x0172 },
    0x3F: { chip: 'SN76489', width: 1, instance: 1 },
    0x40: { chip: 'Mikey', width: 2, instanceOperand: 0, minVersion: 0x0172 },
    0x41: { chip: 'K007232', width: 2, instanceOperand: 0, minVersion: 0x0172 },
    0x42: { chip: 'K005289', width: 2, instanceOperand: 0, minVersion: 0x0172 },
    0x43: { chip: 'MSM5232', width: 2, instanceOperand: 0, minVersion: 0x0172 },
    0x44: { chip: 'ICS2115', width: 2, instanceOperand: 0, minVersion: 0x0172 },
    0x4F: { chip: 'SN76489', width: 1, instance: 0 },
    0x50: { chip: 'SN76489', width: 1, instance: 0 },
    0x51: { chip: 'YM2413', width: 2, instance: 0 },
    0x52: { chip: 'YM2612', width: 2, port: 0, instance: 0 },
    0x53: { chip: 'YM2612', width: 2, port: 1, instance: 0 },
    0x54: { chip: 'YM2151', width: 2, instance: 0 },
    0x55: { chip: 'YM2203', width: 2, instance: 0 },
    0x56: { chip: 'YM2608', width: 2, port: 0, instance: 0 },
    0x57: { chip: 'YM2608', width: 2, port: 1, instance: 0 },
    0x58: { chip: 'YM2610', width: 2, port: 0, instance: 0 },
    0x59: { chip: 'YM2610', width: 2, port: 1, instance: 0 },
    0x5A: { chip: 'YM3812', width: 2, instance: 0 },
    0x5B: { chip: 'YM3526', width: 2, instance: 0 },
    0x5C: { chip: 'Y8950', width: 2, instance: 0 },
    0x5D: { chip: 'YMZ280B', width: 2, instance: 0 },
    0x5E: { chip: 'YMF262', width: 2, port: 0, instance: 0 },
    0x5F: { chip: 'YMF262', width: 2, port: 1, instance: 0 },
    0xA0: { chip: 'AY8910', width: 2, instanceOperand: 0 },
    0xA1: { chip: 'YM2413', width: 2, instance: 1 },
    0xA2: { chip: 'YM2612', width: 2, port: 0, instance: 1 },
    0xA3: { chip: 'YM2612', width: 2, port: 1, instance: 1 },
    0xA4: { chip: 'YM2151', width: 2, instance: 1 },
    0xA5: { chip: 'YM2203', width: 2, instance: 1 },
    0xA6: { chip: 'YM2608', width: 2, port: 0, instance: 1 },
    0xA7: { chip: 'YM2608', width: 2, port: 1, instance: 1 },
    0xA8: { chip: 'YM2610', width: 2, port: 0, instance: 1 },
    0xA9: { chip: 'YM2610', width: 2, port: 1, instance: 1 },
    0xAA: { chip: 'YM3812', width: 2, instance: 1 },
    0xAB: { chip: 'YM3526', width: 2, instance: 1 },
    0xAC: { chip: 'Y8950', width: 2, instance: 1 },
    0xAD: { chip: 'YMZ280B', width: 2, instance: 1 },
    0xAE: { chip: 'YMF262', width: 2, port: 0, instance: 1 },
    0xAF: { chip: 'YMF262', width: 2, port: 1, instance: 1 },
    0xB0: { chip: 'RF5C68', width: 2, instanceOperand: 0 },
    0xB1: { chip: 'RF5C164', width: 2, instanceOperand: 0 },
    0xB2: { chip: 'PWM', width: 2 },
    0xB3: { chip: 'GBDMG', width: 2, instanceOperand: 0 },
    0xB4: { chip: 'NESAPU', width: 2, instanceOperand: 0 },
    0xB5: { chip: 'MultiPCM', width: 2, instanceOperand: 0 },
    0xB6: { chip: 'uPD7759', width: 2, instanceOperand: 0 },
    0xB7: { chip: 'MSM6258', width: 2, instanceOperand: 0 },
    0xB8: { chip: 'MSM6295', width: 2, instanceOperand: 0 },
    0xB9: { chip: 'HuC6280', width: 2, instanceOperand: 0 },
    0xBA: { chip: 'K053260', width: 2, instanceOperand: 0 },
    0xBB: { chip: 'Pokey', width: 2, instanceOperand: 0 },
    0xBC: { chip: 'WonderSwan', width: 2, instanceOperand: 0 },
    0xBD: { chip: 'SAA1099', width: 2, instanceOperand: 0 },
    0xBE: { chip: 'ES5506', width: 2, instanceOperand: 0 },
    0xBF: { chip: 'GA20', width: 2, instanceOperand: 0 },
    0xC0: { chip: 'SegaPCM', width: 3, instanceOperand: 1 },
    0xC1: { chip: 'RF5C68', width: 3, instanceOperand: 0 },
    0xC2: { chip: 'RF5C164', width: 3, instanceOperand: 0 },
    0xC3: { chip: 'MultiPCM', width: 3, instanceOperand: 0 },
    0xC4: { chip: 'QSound', width: 3, instanceOperand: 0 },
    0xC5: { chip: 'SCSP', width: 3, instanceOperand: 0 },
    0xC6: { chip: 'WonderSwan', width: 3, instanceOperand: 0 },
    0xC7: { chip: 'VSU', width: 3, instanceOperand: 0 },
    0xC8: { chip: 'X1-010', width: 3, instanceOperand: 0 },
    0xC9: { chip: 'BSMT2000', width: 3, instanceOperand: 0, minVersion: 0x0172 },
    0xD0: { chip: 'YMF278B', width: 3, instanceOperand: 0 },
    0xD1: { chip: 'YMF271', width: 3, instanceOperand: 0 },
    0xD2: { chip: 'K051649', width: 3, instanceOperand: 0 },
    0xD3: { chip: 'K054539', width: 3, instanceOperand: 0 },
    0xD4: { chip: 'C140', width: 3, instanceOperand: 0 },
    0xD5: { chip: 'ES5503', width: 3, instanceOperand: 0 },
    0xD6: { chip: 'ES5506', width: 3, instanceOperand: 0 },
    0xE1: { chip: 'C352', width: 4, instanceOperand: 0 },
};
/** Command operand length varies before VGM 1.60 at the 0x40 boundary. */
function unsupportedOperandCount(command, version) {
    if (command >= 0x30 && command <= 0x3F)
        return 1;
    if (command >= 0x40 && command <= 0x4E)
        return version <= 0x0160 ? 1 : 2;
    if (command === 0x4F)
        return 1;
    if (command >= 0x55 && command <= 0x5F)
        return 2;
    if (command === 0x64)
        return 3;
    if (command === 0x68)
        return 11;
    if (command === 0x90 || command === 0x91)
        return 4;
    if (command === 0x92)
        return 5;
    if (command === 0x93)
        return 10;
    if (command === 0x94)
        return 1;
    if (command === 0x95)
        return 4;
    if (command >= 0xA1 && command <= 0xBF)
        return 2;
    if (command >= 0xC0 && command <= 0xDF)
        return 3;
    if (command >= 0xE0 && command <= 0xFF)
        return 4;
    return undefined;
}
