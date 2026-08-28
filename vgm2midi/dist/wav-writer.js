"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.WAV_BITS_PER_SAMPLE = exports.WAV_CHANNELS = exports.WAV_SAMPLE_RATE = void 0;
exports.clampInt16 = clampInt16;
exports.writeWaveFile = writeWaveFile;
const fs = __importStar(require("fs"));
exports.WAV_SAMPLE_RATE = 44100;
exports.WAV_CHANNELS = 2;
exports.WAV_BITS_PER_SAMPLE = 16;
/** [-32768, 32767]へクランプする。 */
function clampInt16(value) {
    return Math.max(-32768, Math.min(32767, value));
}
/** モノラルのInt16Arrayを16bit/44.1kHz/stereo WAVとして書き出す（両チャンネルへ複製）。 */
function writeWaveFile(outPath, samples) {
    const dataBytes = samples.byteLength;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + dataBytes, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(exports.WAV_CHANNELS, 22);
    header.writeUInt32LE(exports.WAV_SAMPLE_RATE, 24);
    const blockAlign = exports.WAV_CHANNELS * (exports.WAV_BITS_PER_SAMPLE / 8);
    header.writeUInt32LE(exports.WAV_SAMPLE_RATE * blockAlign, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(exports.WAV_BITS_PER_SAMPLE, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(dataBytes, 40);
    const file = fs.openSync(outPath, 'w');
    try {
        fs.writeSync(file, header);
        fs.writeSync(file, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
    }
    finally {
        fs.closeSync(file);
    }
}
