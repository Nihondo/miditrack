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
exports.renderLibvgmStems = renderLibvgmStems;
const childProcess = __importStar(require("child_process"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/** libvgm helper invocation contract for sample-exact chip stem rendering. */
function renderLibvgmStems(inputPath, outputDirectory, totalSamples) {
    const helper = process.env.VGM2MIDI_STEMS_HELPER
        ?? '/tmp/vgm2midi-native-build/vgm2midi_stems';
    if (!fs.existsSync(helper)) {
        throw new Error(`--stems requires the native helper; run vgm2midi/scripts/build-native.sh or set VGM2MIDI_STEMS_HELPER (${helper})`);
    }
    fs.mkdirSync(outputDirectory, { recursive: true });
    const base = path.parse(inputPath).name;
    const manifest = path.join(outputDirectory, `${base}.stems.json`);
    const result = childProcess.spawnSync(helper, [inputPath, outputDirectory, String(totalSamples), manifest], { encoding: 'utf8' });
    if (result.status !== 0)
        throw new Error(`libvgm stems helper failed: ${result.stderr.trim() || result.stdout.trim()}`);
    if (!fs.existsSync(manifest))
        throw new Error('libvgm stems helper completed without a manifest');
}
