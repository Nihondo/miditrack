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
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.renderLibvgmStems = exports.renderDacWav = exports.renderNoiseWav = exports.prepareVGMPlayback = exports.MidiConverter = exports.VGMParser = void 0;
exports.convertVGMToMidi = convertVGMToMidi;
var vgm_parser_1 = require("./vgm-parser");
Object.defineProperty(exports, "VGMParser", { enumerable: true, get: function () { return vgm_parser_1.VGMParser; } });
var midi_converter_1 = require("./midi-converter");
Object.defineProperty(exports, "MidiConverter", { enumerable: true, get: function () { return midi_converter_1.MidiConverter; } });
var vgm_playback_1 = require("./vgm-playback");
Object.defineProperty(exports, "prepareVGMPlayback", { enumerable: true, get: function () { return vgm_playback_1.prepareVGMPlayback; } });
var noise_renderer_1 = require("./noise-renderer");
Object.defineProperty(exports, "renderNoiseWav", { enumerable: true, get: function () { return noise_renderer_1.renderNoiseWav; } });
var dac_renderer_1 = require("./dac-renderer");
Object.defineProperty(exports, "renderDacWav", { enumerable: true, get: function () { return dac_renderer_1.renderDacWav; } });
var stems_1 = require("./stems");
Object.defineProperty(exports, "renderLibvgmStems", { enumerable: true, get: function () { return stems_1.renderLibvgmStems; } });
__exportStar(require("./types"), exports);
// Main conversion function for convenience
function convertVGMToMidi(inputPath, outputPath, options) {
    const { VGMParser } = require('./vgm-parser');
    const { MidiConverter } = require('./midi-converter');
    const { prepareVGMPlayback } = require('./vgm-playback');
    const { renderNoiseWav } = require('./noise-renderer');
    const { renderDacWav } = require('./dac-renderer');
    const parser = VGMParser.fromFile(inputPath);
    const vgmData = parser.parse();
    const playback = prepareVGMPlayback(vgmData, {
        loopCount: options?.loopCount,
        durationSeconds: options?.durationSeconds,
    });
    const converter = new MidiConverter(playback.data, {
        ...options,
        suppressHardwareNoise: options?.suppressHardwareNoise ?? options?.noiseWavPath !== undefined,
        suppressYM2612Dac: options?.suppressYM2612Dac ?? options?.dacWavPath !== undefined,
    });
    converter.exportToFile(outputPath);
    if (options?.noiseWavPath) {
        renderNoiseWav(playback.data, playback.totalSamples, options.noiseWavPath);
    }
    if (options?.dacWavPath) {
        renderDacWav(playback.data, playback.totalSamples, options.dacWavPath);
    }
}
