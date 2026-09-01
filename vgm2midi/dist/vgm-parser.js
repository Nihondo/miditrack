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
exports.VGMParser = void 0;
const fs = __importStar(require("fs"));
const pako = __importStar(require("pako"));
const vgm_chip_metadata_1 = require("./vgm-chip-metadata");
class VGMParser {
    constructor(buffer) {
        this.position = 0;
        this.buffer = buffer;
    }
    /** VGM/VGZのBufferを受け取り、必要ならgzipを展開したparserを作成する。 */
    static fromBuffer(buffer) {
        const isGzip = buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
        return new VGMParser(isGzip ? Buffer.from(pako.ungzip(buffer)) : buffer);
    }
    /** ファイルを読み取り、VGM/VGZを自動判別してparserを作成する。 */
    static fromFile(filePath) {
        return VGMParser.fromBuffer(fs.readFileSync(filePath));
    }
    readUInt32LE() {
        this.ensureAvailable(4);
        const value = this.buffer.readUInt32LE(this.position);
        this.position += 4;
        return value;
    }
    readUInt8() {
        this.ensureAvailable(1);
        const value = this.buffer.readUInt8(this.position);
        this.position += 1;
        return value;
    }
    readUInt16LE() {
        this.ensureAvailable(2);
        const value = this.buffer.readUInt16LE(this.position);
        this.position += 2;
        return value;
    }
    seek(offset) {
        this.position = offset;
    }
    ensureAvailable(byteCount) {
        if (this.position + byteCount > this.buffer.length) {
            throw new Error(`Unexpected end of VGM data at offset 0x${this.position.toString(16)}`);
        }
    }
    skipBytes(byteCount) {
        this.ensureAvailable(byteCount);
        this.position += byteCount;
    }
    /** VGM圧縮table blockを読み、後続compressed data block用に登録する。 */
    readCompressionTable(payload) {
        if (payload.length < 6)
            throw new Error('Invalid VGM compression table: header is truncated');
        const compressionType = payload[0];
        const subType = payload[1];
        const bitsDecompressed = payload[2];
        const bitsCompressed = payload[3];
        const valueCount = payload.readUInt16LE(4);
        const valueBytes = Math.ceil(bitsDecompressed / 8);
        if (valueBytes < 1 || valueBytes > 2 || payload.length !== 6 + valueCount * valueBytes) {
            throw new Error('Invalid VGM compression table: invalid value width or length');
        }
        const values = [];
        for (let offset = 6; offset < payload.length; offset += valueBytes) {
            values.push(valueBytes === 1 ? payload[offset] : payload.readUInt16LE(offset));
        }
        return { compressionType, subType, bitsDecompressed, bitsCompressed, values };
    }
    /** MSB先行のVGM bit-packed値を一つ読む。 */
    readPackedValue(payload, bitOffset, bitCount) {
        if (bitCount < 1 || bitCount > 16 || bitOffset + bitCount > payload.length * 8) {
            throw new Error('Invalid compressed VGM data block: packed data is truncated');
        }
        let value = 0;
        for (let index = 0; index < bitCount; index += 1) {
            const position = bitOffset + index;
            value = (value << 1) | ((payload[position >> 3] >> (7 - (position & 7))) & 1);
        }
        return value;
    }
    /** VGM 0x40..0x7E compressed data blockを仕様のcompression headerから展開する。 */
    decompressDataBlock(payload, tables) {
        if (payload.length < 10)
            throw new Error('Invalid compressed VGM data block: header is truncated');
        const compressionType = payload[0];
        const outputSize = payload.readUInt32LE(1);
        const bitsDecompressed = payload[5];
        const bitsCompressed = payload[6];
        const subType = payload[7];
        const baseValue = payload.readUInt16LE(8);
        const valueBytes = Math.ceil(bitsDecompressed / 8);
        if (outputSize > 64 * 1024 * 1024 || valueBytes < 1 || valueBytes > 2 || outputSize % valueBytes !== 0) {
            throw new Error('Invalid compressed VGM data block: invalid output size');
        }
        if (bitsCompressed < 1 || bitsCompressed > 16 || bitsDecompressed < 1 || bitsDecompressed > 16) {
            throw new Error('Invalid compressed VGM data block: invalid bit width');
        }
        const output = Buffer.alloc(outputSize);
        const packed = payload.subarray(10);
        const mask = bitsDecompressed === 16 ? 0xFFFF : (1 << bitsDecompressed) - 1;
        const table = tables.get(`${compressionType}:${subType}`);
        if ((subType === 2 || compressionType === 1) && (!table || table.bitsDecompressed !== bitsDecompressed || table.bitsCompressed !== bitsCompressed)) {
            throw new Error('Invalid compressed VGM data block: required compression table is unavailable');
        }
        let bitOffset = 0;
        let accumulator = baseValue;
        for (let offset = 0; offset < outputSize; offset += valueBytes) {
            const packedValue = this.readPackedValue(packed, bitOffset, bitsCompressed);
            bitOffset += bitsCompressed;
            let value;
            if (compressionType === 0) {
                if (subType === 0)
                    value = packedValue + baseValue;
                else if (subType === 1) {
                    if (bitsCompressed > bitsDecompressed)
                        throw new Error('Invalid compressed VGM data block: shift subtype width');
                    value = (packedValue << (bitsDecompressed - bitsCompressed)) + baseValue;
                }
                else if (subType === 2)
                    value = table.values[packedValue] ?? (() => { throw new Error('Invalid compressed VGM data block: table index'); })();
                else
                    throw new Error(`Invalid compressed VGM data block: unsupported bit-pack subtype ${subType}`);
            }
            else if (compressionType === 1 && subType === 0) {
                accumulator = (accumulator + (table.values[packedValue] ?? (() => { throw new Error('Invalid compressed VGM data block: table index'); })())) & mask;
                value = accumulator;
            }
            else {
                throw new Error(`Invalid compressed VGM data block: unsupported compression type ${compressionType}`);
            }
            output[offset] = value & 0xFF;
            if (valueBytes === 2)
                output[offset + 1] = (value >>> 8) & 0xFF;
        }
        return output;
    }
    readHeaderUInt32LE(offset, dataOffset) {
        if (offset + 4 > dataOffset || offset + 4 > this.buffer.length)
            return 0;
        return this.buffer.readUInt32LE(offset);
    }
    readHeaderUInt8(offset, dataOffset) {
        if (offset + 1 > dataOffset || offset + 1 > this.buffer.length)
            return 0;
        return this.buffer.readUInt8(offset);
    }
    /** VGM 1.00/1.01の共有FM clockが属する最初のFM writeを境界通り探索する。 */
    findLegacyFMChip(offset, version) {
        let position = offset;
        while (position < this.buffer.length) {
            const command = this.buffer[position++];
            if (command === 0x66)
                return undefined;
            if (command === 0x51)
                return 'YM2413';
            if (command === 0x52 || command === 0x53)
                return 'YM2612';
            if (command === 0x54)
                return 'YM2151';
            if (command === 0x50 || command === 0x4F || command === 0x30 || command === 0x31 || command === 0x3F) {
                position += 1;
                continue;
            }
            if (command >= 0x55 && command <= 0x5F) {
                position += 2;
                continue;
            }
            if (command === 0x61) {
                position += 2;
                continue;
            }
            if (command === 0x62 || command === 0x63 || (command & 0xF0) === 0x70 || (command & 0xF0) === 0x80)
                continue;
            const operands = this.getUnsupportedCommandOperandCount(command, version);
            if (operands === undefined || position + operands > this.buffer.length)
                return undefined;
            position += operands;
        }
        return undefined;
    }
    parseHeader() {
        this.seek(0);
        const fileId = this.buffer.slice(0, 4).toString('ascii');
        if (fileId !== 'Vgm ') {
            throw new Error('Invalid VGM file: missing "Vgm " identifier');
        }
        const eofOffset = this.readHeaderUInt32LE(0x04, this.buffer.length);
        const version = this.readHeaderUInt32LE(0x08, this.buffer.length);
        let vgmDataOffset = version >= 0x0150
            ? this.readHeaderUInt32LE(0x34, this.buffer.length)
            : 0;
        if (vgmDataOffset === 0) {
            vgmDataOffset = 0x40;
        }
        else {
            vgmDataOffset += 0x34;
        }
        if (vgmDataOffset > this.buffer.length) {
            throw new Error(`Invalid VGM data offset: 0x${vgmDataOffset.toString(16)}`);
        }
        // Header fields that overlap an early data stream must be treated as zero.
        // This is common in VGM 1.50/1.51 files whose data begins at offset 0x40.
        const sn76489Clock = this.readHeaderUInt32LE(0x0C, vgmDataOffset);
        const sn76489Flags = version >= 0x0151 ? this.readHeaderUInt8(0x2B, vgmDataOffset) : 0;
        const ym2413Clock = this.readHeaderUInt32LE(0x10, vgmDataOffset);
        const gd3Offset = this.readHeaderUInt32LE(0x14, vgmDataOffset);
        const totalSamples = this.readHeaderUInt32LE(0x18, vgmDataOffset);
        const loopOffset = this.readHeaderUInt32LE(0x1C, vgmDataOffset);
        const loopDataOffset = loopOffset === 0 ? 0 : loopOffset + 0x1C;
        const loopSamples = this.readHeaderUInt32LE(0x20, vgmDataOffset);
        const rate = version >= 0x0101 ? this.readHeaderUInt32LE(0x24, vgmDataOffset) : 0;
        const readChipClock = (offset, minimumVersion) => (version >= minimumVersion ? this.readHeaderUInt32LE(offset, vgmDataOffset) : 0);
        const ym2203Clock = readChipClock(0x44, 0x0151);
        const ym2608Clock = readChipClock(0x48, 0x0151);
        const ym3812Clock = readChipClock(0x50, 0x0151);
        const ym3526Clock = readChipClock(0x54, 0x0151);
        const y8950Clock = readChipClock(0x58, 0x0151);
        // VGM 1.00/1.01 shares the $10 legacy FM clock field.  Identify its owner by
        // walking command boundaries (libvgm's ParseFileForFMClocks approach), never by
        // guessing from the unrelated SN76489 clock.
        const legacyChip = version < 0x0110 ? this.findLegacyFMChip(vgmDataOffset, version) : undefined;
        const ym2612Clock = version >= 0x0110 ? this.readHeaderUInt32LE(0x2C, vgmDataOffset) : (legacyChip === 'YM2612' ? ym2413Clock : 0);
        const ym2151Clock = version >= 0x0110 ? this.readHeaderUInt32LE(0x30, vgmDataOffset) : (legacyChip === 'YM2151' ? ym2413Clock : 0);
        const segaPCMClock = readChipClock(0x38, 0x0151);
        const segaPCMInterface = version >= 0x0151 ? this.readHeaderUInt32LE(0x3C, vgmDataOffset) : 0;
        const ay8910Clock = readChipClock(0x74, 0x0151);
        const ay8910Type = version >= 0x0151 ? this.readHeaderUInt8(0x78, vgmDataOffset) : 0;
        const ay8910Flags = version >= 0x0151 ? this.readHeaderUInt8(0x79, vgmDataOffset) : 0;
        const ym2203AyFlags = version >= 0x0151 ? this.readHeaderUInt8(0x7A, vgmDataOffset) : 0;
        const ym2608AyFlags = version >= 0x0151 ? this.readHeaderUInt8(0x7B, vgmDataOffset) : 0;
        const huc6280Clock = readChipClock(0xA4, 0x0161);
        const c140Clock = readChipClock(0xA8, 0x0161);
        const c140Type = version >= 0x0161 ? this.readHeaderUInt8(0x96, vgmDataOffset) : 0;
        const gbDmgClock = readChipClock(0x80, 0x0161);
        const msm6258Clock = readChipClock(0x90, 0x0161);
        const chipClocks = {
            SN76489: sn76489Clock, YM2413: version < 0x0110 && legacyChip !== 'YM2413' ? 0 : ym2413Clock,
            YM2612: ym2612Clock, YM2151: ym2151Clock,
            SegaPCM: segaPCMClock, RF5C68: readChipClock(0x40, 0x0151), YM2203: ym2203Clock,
            YM2608: ym2608Clock, YM2610: readChipClock(0x4C, 0x0151), YM3812: ym3812Clock,
            YM3526: ym3526Clock, Y8950: y8950Clock,
            YMF262: readChipClock(0x5C, 0x0151), YMF278B: readChipClock(0x60, 0x0151),
            YMF271: readChipClock(0x64, 0x0151), YMZ280B: readChipClock(0x68, 0x0151),
            RF5C164: readChipClock(0x6C, 0x0151), PWM: readChipClock(0x70, 0x0151), AY8910: ay8910Clock,
            GBDMG: gbDmgClock, NESAPU: readChipClock(0x84, 0x0161), MultiPCM: readChipClock(0x88, 0x0161),
            uPD7759: readChipClock(0x8C, 0x0161), MSM6258: msm6258Clock, MSM6295: readChipClock(0x98, 0x0161),
            K051649: readChipClock(0x9C, 0x0161), K054539: readChipClock(0xA0, 0x0161),
            HuC6280: huc6280Clock, C140: c140Clock, K053260: readChipClock(0xAC, 0x0161),
            Pokey: readChipClock(0xB0, 0x0161), QSound: readChipClock(0xB4, 0x0161),
            SCSP: readChipClock(0xB8, 0x0171), WonderSwan: readChipClock(0xC0, 0x0171),
            VSU: readChipClock(0xC4, 0x0171), SAA1099: readChipClock(0xC8, 0x0171),
            ES5503: readChipClock(0xCC, 0x0171), ES5506: readChipClock(0xD0, 0x0171),
            'X1-010': readChipClock(0xD8, 0x0171), C352: readChipClock(0xDC, 0x0171),
            GA20: readChipClock(0xE0, 0x0171), Mikey: readChipClock(0xE4, 0x0172),
            K007232: readChipClock(0xE8, 0x0172), K005289: readChipClock(0xEC, 0x0172),
            MSM5205: readChipClock(0xF0, 0x0172), MSM5232: readChipClock(0xF4, 0x0172),
            BSMT2000: readChipClock(0xF8, 0x0172), ICS2115: readChipClock(0xFC, 0x0172),
        };
        return {
            fileId,
            eofOffset,
            version,
            sn76489Clock,
            sn76489Flags,
            ym2413Clock: version < 0x0110 && legacyChip !== 'YM2413' ? 0 : ym2413Clock,
            gd3Offset,
            totalSamples,
            loopOffset,
            loopDataOffset,
            loopSamples,
            rate,
            ym2203Clock,
            ym2608Clock,
            ym3812Clock,
            ym3526Clock,
            y8950Clock,
            ym2612Clock,
            ym2151Clock,
            vgmDataOffset,
            segaPCMClock,
            segaPCMInterface,
            ay8910Clock,
            ay8910Type,
            ay8910Flags,
            ym2203AyFlags,
            ym2608AyFlags,
            huc6280Clock,
            c140Clock,
            c140Type,
            gbDmgClock,
            msm6258Clock,
            chipClocks,
        };
    }
    /** VGM 1.70 extra header の第二チップclock/volumeリストを安全に読む。
     *
     * volumeはエントリが無ければundefinedのまま（=「未指定」）にする。かつては
     * clockリストが先にvolume:0のプレースホルダを作ってしまい、clockだけ指定
     * されたチップが「音量0（無音）」に見えるバグがあった。isAbsoluteVolumeは
     * Flagsバイトのbit0（絶対値指定か、既定値からの相対値か）。miditrack側は
     * 絶対値のみ採用する。
     */
    parseExtraHeader() {
        if (this.buffer.length < 0xC0)
            return [];
        const relativeOffset = this.buffer.readUInt32LE(0xBC);
        if (relativeOffset === 0)
            return [];
        const start = 0xBC + relativeOffset;
        if (start + 12 > this.buffer.length)
            return [];
        const clockOffset = this.buffer.readUInt32LE(start + 4);
        const volumeOffset = this.buffer.readUInt32LE(start + 8);
        const names = ['SN76489', 'YM2413', 'YM2612', 'YM2151', 'SegaPCM', 'RF5C68', 'YM2203', 'YM2608', 'YM2610', 'YM3812', 'YM3526', 'Y8950', 'YMF262', 'YMF278B', 'YMF271', 'YMZ280B', 'RF5C164', 'PWM', 'AY8910', 'GBDMG', 'NESAPU', 'MultiPCM', 'uPD7759', 'OKIM6258', 'OKIM6295', 'K051649', 'K054539', 'HuC6280', 'C140'];
        const entries = new Map();
        // Chip IDのbit7は「2つ目のチップインスタンス」を示す共通の符号化で、
        // clock/volume両リストで同じ意味を持つ（clock/volumeリストそれぞれが
        // 独立にチップを列挙するため、片方にしか無いチップも起こりうる）。
        const chipIdentity = (rawId) => ({
            chip: names[rawId & 0x7F] ?? `Chip${rawId & 0x7F}`,
            instance: (rawId & 0x80) !== 0 ? 1 : 0,
        });
        const getEntry = (chip, instance) => {
            const key = `${chip}:${instance}`;
            let entry = entries.get(key);
            if (!entry) {
                entry = { chip, instance, clock: 0 };
                entries.set(key, entry);
            }
            return entry;
        };
        // Chip Clock Data: 1バイトのエントリ数 + 5バイト(ChipID, Clock uint32)ずつ。
        if (clockOffset !== 0) {
            const base = start + 4 + clockOffset;
            if (base < this.buffer.length) {
                const count = this.buffer[base];
                for (let index = 0; index < count; index += 1) {
                    const position = base + 1 + index * 5;
                    if (position + 5 > this.buffer.length)
                        break;
                    const { chip, instance } = chipIdentity(this.buffer[position]);
                    const entry = getEntry(chip, instance);
                    entry.clock = this.buffer.readUInt32LE(position + 1) & vgm_chip_metadata_1.CLOCK_MASK;
                }
            }
        }
        // Chip Volume Data: 1バイトのエントリ数 + 4バイト(ChipID, Flags, Volume uint16)ずつ。
        if (volumeOffset !== 0) {
            const base = start + 8 + volumeOffset;
            if (base < this.buffer.length) {
                const count = this.buffer[base];
                for (let index = 0; index < count; index += 1) {
                    const position = base + 1 + index * 4;
                    if (position + 4 > this.buffer.length)
                        break;
                    const { chip, instance } = chipIdentity(this.buffer[position]);
                    const flags = this.buffer[position + 1];
                    const entry = getEntry(chip, instance);
                    entry.volume = this.buffer.readUInt16LE(position + 2);
                    entry.isAbsoluteVolume = (flags & 0x01) !== 0;
                }
            }
        }
        return [...entries.values()];
    }
    parseCommandStream(header) {
        const commands = [];
        let loopCommandIndex;
        const ym2612PcmChunks = [];
        const dataBlocks = [];
        // $95 identifies a bank by its normalized type and, for a dual device, by the
        // bit31 flag in $67's size.  Keep their block-number sequences independent.
        const dataBlockCounts = new Map();
        const compressionTables = new Map();
        let unsupportedCommandCount = 0;
        this.seek(header.vgmDataOffset);
        while (this.position < this.buffer.length) {
            if (header.loopDataOffset !== 0 && this.position === header.loopDataOffset) {
                loopCommandIndex = commands.length;
            }
            const cmd = this.readUInt8();
            // End of sound data
            if (cmd === 0x66) {
                commands.push({ type: 'end' });
                break;
            }
            // Wait commands
            else if (cmd === 0x61) {
                const samples = this.readUInt16LE();
                commands.push({ type: 'wait', samples });
            }
            else if (cmd === 0x62) {
                commands.push({ type: 'wait', samples: 735 });
            }
            else if (cmd === 0x63) {
                commands.push({ type: 'wait', samples: 882 });
            }
            else if ((cmd & 0xF0) === 0x70) {
                const samples = (cmd & 0x0F) + 1;
                commands.push({ type: 'wait', samples });
            }
            else if ((cmd & 0xF0) === 0x80) {
                // YM2612 DAC byte from the active PCM data bank, followed by a wait.
                commands.push({ type: 'pcm_write', chip: 'YM2612', samples: cmd & 0x0F });
            }
            // SN76489 PSG, including VGM 1.50+ second instance command 0x30.
            else if (cmd === 0x50 || cmd === 0x30) {
                const data = this.readUInt8();
                commands.push({ type: 'psg_write', chip: 'SN76489', ...(cmd === 0x30 ? { instance: 1 } : {}), data });
            }
            // Game Gear stereo routing: bits 0-3 are left and bits 4-7 are right, ch0..3.
            else if (cmd === 0x4F || cmd === 0x3F) {
                commands.push({ type: 'psg_stereo', chip: 'SN76489', ...(cmd === 0x3F ? { instance: 1 } : {}), data: this.readUInt8(), command: cmd });
            }
            // AY/SSG stereo mask: i y r3 l3 r2 l2 r1 l1. The VGM specification names
            // AY8910 (y=0) and YM2203 SSG (y=1). A few YM2608-only logs use the same
            // y=1 mask; with no YM2203 clock present it unambiguously targets YM2608.
            else if (cmd === 0x31 && header.version >= 0x0171) {
                const data = this.readUInt8();
                const isSecondInstance = (data & 0x80) !== 0;
                const isOPNSSG = (data & 0x40) !== 0;
                const chip = !isOPNSSG
                    ? 'AY8910'
                    : (header.ym2203Clock & vgm_chip_metadata_1.CLOCK_MASK) !== 0 || (header.ym2608Clock & vgm_chip_metadata_1.CLOCK_MASK) === 0
                        ? 'YM2203'
                        : 'YM2608';
                commands.push({ type: 'ay_stereo', chip, ...(isSecondInstance ? { instance: 1 } : {}), data: data & 0x3F, command: cmd });
            }
            // YM2612 writes
            else if (cmd === 0x52 || cmd === 0xA2) {
                const register = this.readUInt8();
                const data = this.readUInt8();
                commands.push({ type: 'chip_write', chip: 'YM2612', ...(cmd === 0xA2 ? { instance: 1 } : {}), port: 0, register, data });
            }
            else if (cmd === 0x53 || cmd === 0xA3) {
                const register = this.readUInt8();
                const data = this.readUInt8();
                commands.push({ type: 'chip_write', chip: 'YM2612', ...(cmd === 0xA3 ? { instance: 1 } : {}), port: 1, register, data });
            }
            // YM2413 writes
            else if (cmd === 0x51 || cmd === 0xA1) {
                const register = this.readUInt8();
                const data = this.readUInt8();
                commands.push({ type: 'chip_write', chip: 'YM2413', ...(cmd === 0xA1 ? { instance: 1 } : {}), port: 0, register, data });
            }
            // YM2151 writes
            else if (cmd === 0x54 || cmd === 0xA4) {
                const register = this.readUInt8();
                const data = this.readUInt8();
                commands.push({ type: 'chip_write', chip: 'YM2151', ...(cmd === 0xA4 ? { instance: 1 } : {}), port: 0, register, data });
            }
            // YM2203 writes (primary and optional second chip)
            else if (cmd === 0x55 || cmd === 0xA5) {
                const register = this.readUInt8();
                const data = this.readUInt8();
                commands.push({
                    type: 'chip_write',
                    chip: 'YM2203',
                    instance: cmd === 0xA5 ? 1 : 0,
                    port: 0,
                    register,
                    data,
                });
            }
            // YM2608 writes (ports 0/1, primary and optional second chip)
            else if (cmd === 0x56 || cmd === 0x57 || cmd === 0xA6 || cmd === 0xA7) {
                const register = this.readUInt8();
                const data = this.readUInt8();
                commands.push({
                    type: 'chip_write',
                    chip: 'YM2608',
                    instance: cmd >= 0xA6 ? 1 : 0,
                    port: cmd & 0x01,
                    register,
                    data,
                });
            }
            // OPL family writes. Y8950's Delta-T ADPCM registers stay diagnostic-only;
            // ordinary FM and shared control writes are converted by the common OPL handler.
            else if (cmd === 0x5A || cmd === 0x5B || cmd === 0x5C
                || cmd === 0xAA || cmd === 0xAB || cmd === 0xAC) {
                const chip = vgm_chip_metadata_1.COMMAND_CHIPS[cmd].chip;
                const register = this.readUInt8();
                const data = this.readUInt8();
                const instance = cmd >= 0xAA ? 1 : 0;
                if (chip === 'Y8950' && vgm_chip_metadata_1.Y8950_ADPCM_REGISTERS.has(register)) {
                    commands.push({
                        type: 'unsupported_write', chip, instance, command: cmd,
                        operands: [register, data], data,
                    });
                }
                else {
                    commands.push({ type: 'chip_write', chip, instance, port: 0, register, data });
                }
            }
            // AY8910 writes
            else if (cmd === 0xA0) {
                const registerAndInstance = this.readUInt8();
                const data = this.readUInt8();
                commands.push({
                    type: 'chip_write',
                    chip: 'AY8910',
                    instance: (registerAndInstance & 0x80) !== 0 ? 1 : 0,
                    port: 0,
                    register: registerAndInstance & 0x7F,
                    data,
                });
            }
            // HuC6280 (PC Engine/TurboGrafx-16 PSG) writes
            else if (cmd === 0xB9) {
                const registerAndInstance = this.readUInt8();
                const data = this.readUInt8();
                commands.push({
                    type: 'chip_write',
                    chip: 'HuC6280',
                    instance: (registerAndInstance & 0x80) !== 0 ? 1 : 0,
                    port: 0,
                    register: registerAndInstance & 0x7F,
                    data,
                });
            }
            // GameBoy DMG (LR35902 APU) writes. Register 0 corresponds to GameBoy address
            // $FF10 (NR10); the parser preserves the raw VGM register number, and
            // MidiConverter's handleGBDMGWrite() maps it back to NR10-NR52 offsets.
            else if (cmd === 0xB3) {
                const register = this.readUInt8();
                const data = this.readUInt8();
                commands.push({ type: 'chip_write', chip: 'GBDMG', ...((register & 0x80) !== 0 ? { instance: 1 } : {}), port: 0, register: register & 0x7F, data });
            }
            // SegaPCM: low address byte, high address byte, data.
            else if (cmd === 0xC0) {
                const addressLow = this.readUInt8();
                const addressHigh = this.readUInt8();
                const data = this.readUInt8();
                // SegaPCM encodes its second device bit in the high address operand.
                const register = addressLow | ((addressHigh & 0x7F) << 8);
                commands.push({ type: 'chip_write', chip: 'SegaPCM', ...((addressHigh & 0x80) !== 0 ? { instance: 1 } : {}), port: 0, register, data });
            }
            // Namco C140: high register byte, low register byte, data.
            else if (cmd === 0xD4) {
                const addressHigh = this.readUInt8();
                const addressLow = this.readUInt8();
                const data = this.readUInt8();
                const register = ((addressHigh & 0x7F) << 8) | addressLow;
                commands.push({ type: 'chip_write', chip: 'C140', ...((addressHigh & 0x80) !== 0 ? { instance: 1 } : {}), port: 0, register, data });
            }
            // Data block
            else if (cmd === 0x67) {
                const compatibilityByte = this.readUInt8();
                if (compatibilityByte !== 0x66) {
                    throw new Error(`Invalid VGM data block at offset 0x${(this.position - 2).toString(16)}`);
                }
                const originalType = this.readUInt8();
                const rawSize = this.readUInt32LE();
                const instance = (rawSize & 0x80000000) !== 0 ? 1 : 0;
                const packedSize = rawSize & 0x7FFFFFFF;
                this.ensureAvailable(packedSize);
                const packedPayload = Buffer.from(this.buffer.subarray(this.position, this.position + packedSize));
                this.position += packedSize;
                if (originalType === 0x7F) {
                    const table = this.readCompressionTable(packedPayload);
                    compressionTables.set(`${table.compressionType}:${table.subType}`, table);
                    commands.push({ type: 'data_block', data: originalType, ...(instance === 1 ? { instance } : {}) });
                    continue;
                }
                const isCompressed = originalType >= 0x40 && originalType <= 0x7E;
                const blockType = isCompressed ? originalType & 0x3F : originalType;
                const payload = isCompressed ? this.decompressDataBlock(packedPayload, compressionTables) : packedPayload;
                const countKey = `${blockType}:${instance}`;
                const blockId = dataBlockCounts.get(countKey) ?? 0;
                dataBlockCounts.set(countKey, blockId + 1);
                // Keep every block, not just YM2612's type 00 bank. DAC stream command 95 refers
                // to this per-type, per-instance block index, so discarding non-YM2612 payloads
                // loses identity and duration information even when MIDI rendering is light.
                dataBlocks.push({ type: blockType, blockId, size: payload.length, payload, instance, originalType, isCompressed });
                // Type 0x00 instance 0 is also kept as the legacy concatenated YM2612 PCM bank.
                if (blockType === 0x00 && instance === 0)
                    ym2612PcmChunks.push(payload);
                commands.push({ type: 'data_block', data: originalType, ...(instance === 1 ? { instance } : {}) });
            }
            // YM2612 PCM data-bank seek. The next 0x80-0x8F command starts playback
            // from this address and is converted to a sample-identity percussion hit.
            else if (cmd === 0xE0) {
                const address = this.readUInt32LE();
                commands.push({ type: 'pcm_seek', chip: 'YM2612', address });
            }
            // Generic DAC stream controls. 0x90 identifies the target device; 0x93
            // starts a range and 0x94 stops it. The converter gives MSM6258 streams a
            // stable editing-trigger identity while native stems retain real audio.
            else if (cmd === 0x90) {
                const streamId = this.readUInt8();
                const data = this.readUInt8();
                const port = this.readUInt8();
                const register = this.readUInt8();
                const targetChip = vgm_chip_metadata_1.STREAM_DEVICE_CHIPS[data & 0x7F];
                commands.push({ type: 'stream_setup', streamId, data, port, register, targetChip, targetInstance: (data & 0x80) !== 0 ? 1 : 0, command: cmd });
            }
            else if (cmd === 0x91) {
                const streamId = this.readUInt8();
                const bankId = this.readUInt8();
                const stepSize = this.readUInt8();
                const stepBase = this.readUInt8();
                commands.push({ type: 'stream_data', streamId, bankId, stepSize, stepBase, command: cmd });
            }
            else if (cmd === 0x92) {
                const streamId = this.readUInt8();
                const frequency = this.readUInt32LE();
                commands.push({ type: 'stream_frequency', streamId, frequency, command: cmd });
            }
            else if (cmd === 0x93) {
                const streamId = this.readUInt8();
                const address = this.readUInt32LE();
                const mode = this.readUInt8();
                const length = this.readUInt32LE();
                commands.push({ type: 'stream_start', streamId, address, data: mode, length, lengthMode: mode & 0x0F, command: cmd });
            }
            else if (cmd === 0x94) {
                commands.push({ type: 'stream_stop', streamId: this.readUInt8(), command: cmd });
            }
            else if (cmd === 0x95) {
                const streamId = this.readUInt8();
                const block = this.readUInt16LE();
                const flags = this.readUInt8();
                commands.push({ type: 'stream_start_fast', streamId, address: block, blockId: block, data: flags, command: cmd });
            }
            else if (vgm_chip_metadata_1.COMMAND_CHIPS[cmd] && (vgm_chip_metadata_1.COMMAND_CHIPS[cmd].minVersion === undefined || header.version >= vgm_chip_metadata_1.COMMAND_CHIPS[cmd].minVersion)) {
                const metadata = vgm_chip_metadata_1.COMMAND_CHIPS[cmd];
                this.ensureAvailable(metadata.width);
                const operands = Array.from(this.buffer.subarray(this.position, this.position + metadata.width));
                this.position += metadata.width;
                const instance = metadata.instance ?? (metadata.instanceOperand === undefined ? 0 : ((operands[metadata.instanceOperand] & 0x80) !== 0 ? 1 : 0));
                commands.push({ type: 'unsupported_write', chip: metadata.chip, instance, ...(metadata.port === undefined ? {} : { port: metadata.port }), command: cmd, operands, data: operands[metadata.width - 1] });
            }
            // Unsupported commands still have defined operand sizes. Keeping their
            // boundaries intact is essential: treating operand bytes as commands can
            // encounter a false 0x66 and silently truncate the song.
            else {
                const operandCount = this.getUnsupportedCommandOperandCount(cmd, header.version);
                if (operandCount === undefined) {
                    throw new Error(`Unsupported or invalid VGM command 0x${cmd.toString(16).padStart(2, '0')} at offset 0x${(this.position - 1).toString(16)}`);
                }
                this.skipBytes(operandCount);
                unsupportedCommandCount += 1;
            }
        }
        const ym2612PcmData = ym2612PcmChunks.length > 0 ? Buffer.concat(ym2612PcmChunks) : undefined;
        return { commands, loopCommandIndex, ym2612PcmData, dataBlocks, unsupportedCommandCount };
    }
    /** VGMコマンド列を解析し、従来互換のコマンド配列を返します。 */
    parseCommands(header) {
        return this.parseCommandStream(header).commands;
    }
    getUnsupportedCommandOperandCount(command, version) {
        return (0, vgm_chip_metadata_1.unsupportedOperandCount)(command, version);
    }
    parse() {
        const header = this.parseHeader();
        const { commands, loopCommandIndex, ym2612PcmData, dataBlocks, unsupportedCommandCount } = this.parseCommandStream(header);
        return { header, commands, loopCommandIndex, ym2612PcmData, dataBlocks, extraHeader: this.parseExtraHeader(), diagnostics: this.createDiagnostics(header, commands, unsupportedCommandCount) };
    }
    /** 書き込みを捨てず、CLI の警告/strict 判定に使う変換診断を集計する。 */
    createDiagnostics(header, commands, unsupportedCommandCount) {
        const entries = new Map();
        const clockForChip = (chip) => (header.chipClocks?.[chip] ?? ({
            SN76489: header.sn76489Clock, YM2413: header.ym2413Clock, YM2612: header.ym2612Clock,
            YM2151: header.ym2151Clock, YM2203: header.ym2203Clock, YM2608: header.ym2608Clock,
            YM3812: header.ym3812Clock, YM3526: header.ym3526Clock, Y8950: header.y8950Clock,
            AY8910: header.ay8910Clock, HuC6280: header.huc6280Clock, GBDMG: header.gbDmgClock,
            SegaPCM: header.segaPCMClock, C140: header.c140Clock, MSM6258: header.msm6258Clock,
        }[chip] ?? 0)) & vgm_chip_metadata_1.CLOCK_MASK;
        const add = (chip, instance, options = {}) => {
            const key = `${chip}:${instance}`;
            const support = options.support ?? 'full';
            const entry = entries.get(key) ?? { chip, instance, commandCount: 0, writeCount: 0, streamCount: 0, midiSupport: support };
            entry.commandCount += 1;
            if (options.isWrite)
                entry.writeCount += 1;
            if (options.isStream)
                entry.streamCount += 1;
            if (support === 'none')
                entry.midiSupport = 'none';
            entries.set(key, entry);
        };
        const streamTargets = new Map();
        for (const command of commands) {
            if (command.type.startsWith('stream_')) {
                if (command.type === 'stream_setup') {
                    const chip = command.targetChip ?? `StreamDevice${(command.data ?? 0) & 0x7F}`;
                    const instance = command.targetInstance ?? 0;
                    const support = chip === 'MSM6258' ? 'trigger' : 'none';
                    streamTargets.set(command.streamId ?? -1, { chip, instance, support });
                    add(chip, instance, { support });
                    continue;
                }
                const target = streamTargets.get(command.streamId ?? -1);
                if (target) {
                    const isStart = command.type === 'stream_start' || command.type === 'stream_start_fast';
                    add(target.chip, target.instance, { isStream: isStart, support: target.support });
                    if (target.support === 'none' && isStart)
                        unsupportedCommandCount += 1;
                }
                continue;
            }
            if (command.type === 'unsupported_write' && command.chip) {
                add(command.chip, command.instance ?? 0, { isWrite: true, support: 'none' });
                unsupportedCommandCount += 1;
            }
            else if (command.chip) {
                add(command.chip, command.instance ?? 0, { isWrite: true });
            }
        }
        const chips = [...entries.values()].map(entry => ({ ...entry, clock: clockForChip(entry.chip) }));
        return { chips, unsupportedCommandCount, unsupportedWriteCount: unsupportedCommandCount, streamCount: chips.reduce((total, chip) => total + chip.streamCount, 0), hasOmittedContent: unsupportedCommandCount > 0 };
    }
}
exports.VGMParser = VGMParser;
