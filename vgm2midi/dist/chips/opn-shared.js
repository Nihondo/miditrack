"use strict";
// MidiConverterから抽出した、OPNファミリー（YM2612/YM2203/YM2608）が共有する
// FM Timbre/Pan書き込みと、Channel 3 Special mode・CSM Timer Aの状態機械。
// AY8910/YM2203/YM2608が共有するSSGコア（chips/ssg.ts）と同じ理由で、
// この状態機械はどの1チップの所有物でもない——各関数は元から`keyPrefix`/`chip`/
// `instance`または`context: OPNCh3Context`を引数に取る形で書かれており、
// 3チップの`handleYM2612Write()`/`handleYM2203Write()`/`handleYM2608Write()`
// （それぞれchips/ym2612.ts・ym2203.ts・ym2608.ts）から直接呼ばれる。
// `host: MidiConverter`のper-conversion可変状態を直接読み書きする——詳細な
// 設計判断はvgm2midi/CLAUDE.mdの「Refactor: event-output.ts」を参照。
//
// CSM Timer Aの進行そのもの（advanceCSMTimers()/emitOPNCsmPulse()/opnCsmTimer()等）は
// convert()のメインループから直接呼ばれる、YM2151（OPM）側とも共有するティッカーの
// ため、MidiConverter側に残したまま`host.`経由で呼ぶ——ym2151.tsの
// emitOPMCsmPulse()と対をなす設計。
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleOPNPanWrite = handleOPNPanWrite;
exports.handleOPNTimbreWrite = handleOPNTimbreWrite;
exports.recordOPNTimbreEvents = recordOPNTimbreEvents;
exports.handleOPNCh3ModeWrite = handleOPNCh3ModeWrite;
exports.updateOPNCsmTimerRegister = updateOPNCsmTimerRegister;
exports.updateOPNCsmTimer = updateOPNCsmTimer;
exports.handleOPNCh3SpecialKeyWrite = handleOPNCh3SpecialKeyWrite;
exports.trackOPNCh3UnisonAttack = trackOPNCh3UnisonAttack;
exports.handleOPNCh3SpecialOperators = handleOPNCh3SpecialOperators;
exports.handleOPNCh3SpecialPercussion = handleOPNCh3SpecialPercussion;
exports.opnCh3SpecialPercussionNote = opnCh3SpecialPercussionNote;
exports.opnCh3OperatorFrequency = opnCh3OperatorFrequency;
exports.opnCh3PercussionNoteForCarrierNotes = opnCh3PercussionNoteForCarrierNotes;
exports.handleOPNCh3SpecialFrequencyWrite = handleOPNCh3SpecialFrequencyWrite;
exports.updateActiveOPNCh3SpecialPitches = updateActiveOPNCh3SpecialPitches;
const midi_converter_1 = require("../midi-converter");
const midi_math_1 = require("../midi-math");
const event_output_1 = require("../event-output");
// Offset = reg - 0xA8 (or reg - 0xAC); value = 0-based logical operator index matching
// keyOnMask's own bit0=Op1..bit3=Op4 convention. Confirmed against Nuked-OPN2's
// OPN2_PhaseGenerate() slot switch and plutiedev.com's YM2612 register reference.
const OPN_CH3_SPECIAL_OPERATOR_BY_OFFSET = [2, 0, 1]; // offset 0,1,2 -> Op3,Op1,Op2
// Two operators keyed within this many semitones of each other on the same Ch3 Special
// attack are treated as playing in unison (one melodic voice reinforced across multiple
// operators), not as independently-pitched voices.
const OPN_CH3_UNISON_SEMITONE_THRESHOLD = 1;
/** OPN/OPNA の $B4-$B6 LR 出力マスクを CC10 に変換する。 */
function handleOPNPanWrite(host, keyPrefix, port, reg, data, currentTime) {
    if (reg < 0xB4 || reg > 0xB6)
        return false;
    const offset = reg & 0x03;
    if (offset >= 3)
        return true;
    const channel = offset + port * 3;
    const key = keyPrefix === 'ym2612' ? `${keyPrefix}_${channel}` : `${keyPrefix}_fm_${channel}`;
    (0, event_output_1.addPan)(host, key, (data & 0x80) !== 0, (data & 0x40) !== 0, currentTime);
    return true;
}
function handleOPNTimbreWrite(host, keyPrefix, port, reg, data, currentTime) {
    const isMultiplier = reg >= 0x30 && reg <= 0x3F;
    const isTotalLevel = reg >= 0x40 && reg <= 0x4F;
    const isAlgorithm = reg >= 0xB0 && reg <= 0xB2;
    if (!isMultiplier && !isTotalLevel && !isAlgorithm)
        return false;
    const channelOffset = reg & 0x03;
    if (channelOffset >= 3)
        return true;
    const channelIndex = channelOffset + (port * 3);
    const key = keyPrefix === 'ym2612'
        ? `${keyPrefix}_${channelIndex}`
        : `${keyPrefix}_fm_${channelIndex}`;
    const state = host.channels.get(key);
    if (isAlgorithm) {
        state.opnAlgorithm = data & 0x07;
    }
    else {
        const registerSlot = (reg >> 2) & 0x03;
        const logicalOperator = [0, 2, 1, 3][registerSlot];
        if (isMultiplier) {
            state.opnOperatorMultipliers[logicalOperator] = data & 0x0F;
            state.opnOperatorMultiplierWritten[logicalOperator] = true;
        }
        else {
            state.opnOperatorTotalLevels[logicalOperator] = data & 0x7F;
            if (state.active && currentTime !== undefined) {
                (0, event_output_1.addExpression)(host, key, host.opnCarrierExpression(state), currentTime);
            }
        }
    }
    if (currentTime !== undefined)
        recordOPNTimbreEvents(host, keyPrefix, channelIndex, currentTime);
    return true;
}
/** OPN Ch3 Special時は親と発音中のオペレータ別トラックをまとめて更新する。 */
function recordOPNTimbreEvents(host, keyPrefix, channel, currentTime) {
    const parentKey = keyPrefix === 'ym2612'
        ? `${keyPrefix}_${channel}`
        : `${keyPrefix}_fm_${channel}`;
    host.recordFMTimbreEvent(parentKey, currentTime, 'opn-timbre');
    if (channel !== 2)
        return;
    const match = /^(ym2203|ym2608)_(\d+)$/.exec(keyPrefix);
    const context = keyPrefix === 'ym2612'
        ? host.opnCh3Context('YM2612')
        : match
            ? host.opnCh3Context(match[1], Number(match[2]))
            : undefined;
    if (!context || !host.isOPNCh3SpecialMode(context))
        return;
    for (const key of context.operatorKeys) {
        if (key !== parentKey)
            host.recordFMTimbreEvent(key, currentTime, 'opn-timbre');
    }
}
function handleOPNCh3ModeWrite(host, context, data, currentTime, activeNotes) {
    const isSpecial = (data & 0xC0) !== 0;
    if (isSpecial === host.isOPNCh3SpecialMode(context))
        return;
    const percussionKey = host.opnCh3PercussionActiveKeys.get(context.stateKey);
    if (percussionKey !== undefined)
        (0, event_output_1.noteOff)(host, percussionKey, 0, currentTime, activeNotes);
    host.opnCh3PercussionActiveKeys.delete(context.stateKey);
    for (const key of context.operatorKeys) {
        const state = host.channels.get(key);
        if (!state.active)
            continue;
        state.active = false;
        (0, event_output_1.noteOff)(host, key, 0, currentTime, activeNotes);
    }
    host.channels.get(context.parentKey).keyOnMask = 0;
    host.opnCsmTimer(context.chip, context.instance).manualKeyOnMask = 0;
    host.opnCh3SpecialModes.set(context.stateKey, isSpecial);
}
/** OPN Timer Aの値をCSM schedulerへ反映する。 */
function updateOPNCsmTimerRegister(host, chip, instance, register, data) {
    const timer = host.opnCsmTimer(chip, instance);
    if (register === 0x24)
        timer.timerHigh = data;
    else
        timer.timerLow = data & 0x03;
}
/** OPN $27のCSM有効状態とTimer Aの開始状態を更新する。 */
function updateOPNCsmTimer(host, chip, instance, data, currentTime, activeNotes) {
    const timer = host.opnCsmTimer(chip, instance);
    const wasActive = timer.isRunning && timer.isCSMEnabled;
    timer.isRunning = (data & 0x01) !== 0;
    timer.isCSMEnabled = (data & 0xC0) === 0x80;
    const isActive = timer.isRunning && timer.isCSMEnabled;
    if (!isActive) {
        if (timer.nextRelease !== undefined)
            host.emitOPNCsmPulse(chip, instance, false, currentTime, activeNotes);
        timer.nextOverflow = undefined;
        timer.nextRelease = undefined;
        return;
    }
    if (!wasActive) {
        timer.nextOverflow = currentTime + host.opnCsmPeriodSamples(chip, timer);
        timer.nextRelease = undefined;
        timer.lastEmittedTick = undefined;
    }
}
function handleOPNCh3SpecialKeyWrite(host, context, data, currentTime, activeNotes, isCSMEvent = false) {
    const timer = host.opnCsmTimer(context.chip, context.instance);
    const rawMask = (data >> 4) & 0x0F;
    if (!isCSMEvent)
        timer.manualKeyOnMask = rawMask;
    const manualMask = timer.manualKeyOnMask ?? 0;
    const csmMask = isCSMEvent ? rawMask : timer.nextRelease === undefined ? 0 : 0x0F;
    const effectiveData = (data & 0x0F) | ((manualMask | csmMask) << 4);
    trackOPNCh3UnisonAttack(host, context, effectiveData);
    if (host.options.opnCh3SpecialPercussion) {
        handleOPNCh3SpecialPercussion(host, context, effectiveData, currentTime, activeNotes);
        return;
    }
    handleOPNCh3SpecialOperators(host, context, effectiveData, currentTime, activeNotes);
}
/** Ch3 Specialの新規キーオンで、発音中オペレータ同士がユニゾン(ほぼ同一音程)かを集計する。
 *
 * handleOPNCh3SpecialOperators()/handleOPNCh3SpecialPercussion()が parentState.keyOnMask を
 * 書き換える前に呼ぶ必要がある — 「新規にキーオンされたオペレータ」の判定に前回のマスクを使うため。
 */
function trackOPNCh3UnisonAttack(host, context, effectiveData) {
    const parentState = host.channels.get(context.parentKey);
    const previousMask = parentState.keyOnMask ?? 0;
    const slotMask = (effectiveData >> 4) & 0x0F;
    const newlyKeyedMask = slotMask & ~previousMask;
    if (newlyKeyedMask === 0)
        return;
    const totalLevels = parentState.opnOperatorTotalLevels ?? [0, 0, 0, 0];
    const notes = [];
    for (let operator = 0; operator < 4; operator++) {
        if ((newlyKeyedMask & (1 << operator)) === 0)
            continue;
        if ((totalLevels[operator] ?? 0) >= 0x7F)
            continue; // silenced operator, not audible
        const state = host.channels.get(context.operatorKeys[operator]);
        const note = (0, midi_math_1.frequencyToMidiNote)(opnCh3OperatorFrequency(host, context, state));
        if (note > 0)
            notes.push(note);
    }
    if (notes.length < 2)
        return; // need 2+ audible operators to compare
    const stats = host.opnCh3UnisonStats.get(context.stateKey)
        ?? { totalAttacks: 0, unisonAttacks: 0 };
    stats.totalAttacks++;
    if (Math.max(...notes) - Math.min(...notes) <= OPN_CH3_UNISON_SEMITONE_THRESHOLD) {
        stats.unisonAttacks++;
    }
    host.opnCh3UnisonStats.set(context.stateKey, stats);
}
function handleOPNCh3SpecialOperators(host, context, data, currentTime, activeNotes) {
    const parentState = host.channels.get(context.parentKey);
    const slotMask = (data >> 4) & 0x0F;
    parentState.keyOnMask = slotMask;
    const totalLevels = parentState.opnOperatorTotalLevels ?? [0, 0, 0, 0];
    for (let operator = 0; operator < 4; operator++) {
        const key = context.operatorKeys[operator];
        const state = host.channels.get(key);
        const isKeyOn = (slotMask & (1 << operator)) !== 0;
        if (isKeyOn && !state.active) {
            state.opnActivePitchScale = 1;
            const totalLevel = totalLevels[operator];
            state.opnActiveVelocity = totalLevel >= 0x7F
                ? undefined
                : host.operatorTotalLevelVelocity(totalLevel);
            state.active = true;
            (0, event_output_1.noteOn)(host, key, 0, currentTime, activeNotes);
        }
        else if (!isKeyOn && state.active) {
            state.active = false;
            (0, event_output_1.noteOff)(host, key, 0, currentTime, activeNotes);
            state.opnActivePitchScale = 1;
        }
    }
}
function handleOPNCh3SpecialPercussion(host, context, data, currentTime, activeNotes) {
    const parentState = host.channels.get(context.parentKey);
    const previousMask = parentState.keyOnMask ?? 0;
    const slotMask = (data >> 4) & 0x0F;
    const newlyKeyedMask = slotMask & ~previousMask;
    parentState.keyOnMask = slotMask;
    const activeKey = host.opnCh3PercussionActiveKeys.get(context.stateKey);
    if (newlyKeyedMask !== 0) {
        if (activeKey !== undefined)
            (0, event_output_1.noteOff)(host, activeKey, 0, currentTime, activeNotes);
        const note = opnCh3SpecialPercussionNote(host, context, slotMask);
        const key = `${context.percussionPrefix}${note}`;
        (0, event_output_1.noteOnPercussion)(host, key, host.opnCarrierVelocity(parentState), currentTime, activeNotes, note);
        host.opnCh3PercussionActiveKeys.set(context.stateKey, key);
    }
    else if (slotMask === 0 && activeKey !== undefined) {
        (0, event_output_1.noteOff)(host, activeKey, 0, currentTime, activeNotes);
        host.opnCh3PercussionActiveKeys.delete(context.stateKey);
    }
}
function opnCh3SpecialPercussionNote(host, context, slotMask) {
    const parentState = host.channels.get(context.parentKey);
    const algorithm = parentState.opnAlgorithm ?? 0;
    const totalLevels = parentState.opnOperatorTotalLevels ?? [0, 0, 0, 0];
    const carrierNotes = [];
    for (const path of midi_converter_1.OPN_OPERATOR_PATHS[algorithm]) {
        const operator = path.carrier;
        if ((slotMask & (1 << operator)) === 0 || totalLevels[operator] >= 0x7F)
            continue;
        const state = host.channels.get(context.operatorKeys[operator]);
        const note = (0, midi_math_1.frequencyToMidiNote)(opnCh3OperatorFrequency(host, context, state));
        if (note > 0)
            carrierNotes.push(note);
    }
    return opnCh3PercussionNoteForCarrierNotes(carrierNotes);
}
function opnCh3OperatorFrequency(host, context, state) {
    if (context.chip === 'YM2612') {
        return (0, midi_math_1.ym2612FrequencyToHz)(state.frequency, state.block ?? 0, host.vgmData.header.ym2612Clock);
    }
    const clock = context.chip === 'YM2203'
        ? host.vgmData.header.ym2203Clock
        : host.vgmData.header.ym2608Clock;
    const prescaler = context.chip === 'YM2203'
        ? host.ym2203Prescalers[context.instance]
        : host.ym2608Prescalers[context.instance];
    return (0, midi_math_1.ym2203FrequencyToHz)(state.frequency, state.block ?? 0, clock, prescaler);
}
function opnCh3PercussionNoteForCarrierNotes(carrierNotes) {
    if (carrierNotes.length === 0)
        return 38;
    carrierNotes.sort((left, right) => left - right);
    const note = carrierNotes[Math.floor(carrierNotes.length / 2)];
    if (note <= 48)
        return 36;
    if (note <= 64)
        return 38;
    if (note >= 108)
        return 42;
    if (note >= 88)
        return 49;
    if (note <= 68)
        return 41;
    if (note <= 72)
        return 43;
    if (note <= 75)
        return 45;
    if (note <= 78)
        return 47;
    if (note <= 81)
        return 48;
    return 50;
}
function handleOPNCh3SpecialFrequencyWrite(host, context, reg, data, currentTime, activeNotes, cmdIndex) {
    const isLowByte = reg >= 0xA8 && reg <= 0xAA;
    const isHighByte = reg >= 0xAC && reg <= 0xAE;
    if (!isLowByte && !isHighByte)
        return false;
    const offset = isLowByte ? reg - 0xA8 : reg - 0xAC;
    const operator = OPN_CH3_SPECIAL_OPERATOR_BY_OFFSET[offset];
    const key = context.operatorKeys[operator];
    const state = host.channels.get(key);
    if (isLowByte)
        state.freqLSB = data;
    else {
        state.freqMSB = data & 0x07;
        state.block = (data >> 3) & 0x07;
    }
    const oldFrequency = state.frequency;
    state.frequency = ((state.freqMSB ?? 0) << 8) | (state.freqLSB ?? 0);
    const otherReg = isLowByte ? reg + 4 : reg - 4;
    const isSplitUpdate = host.isOPNMultiByteFreqUpdate(cmdIndex, context.chip, 0, otherReg, context.instance);
    const hadPendingUpdate = state.hasPendingFrequencyUpdate ?? false;
    state.hasPendingFrequencyUpdate = isSplitUpdate;
    if (state.active && !isSplitUpdate && (state.frequency !== oldFrequency || hadPendingUpdate)) {
        (0, event_output_1.updateNotePitch)(host, key, 0, currentTime, activeNotes);
    }
    return true;
}
function updateActiveOPNCh3SpecialPitches(host, context, currentTime, activeNotes) {
    for (const key of context.operatorKeys.slice(0, 3)) {
        if (host.channels.get(key).active)
            (0, event_output_1.updateNotePitch)(host, key, 0, currentTime, activeNotes);
    }
}
