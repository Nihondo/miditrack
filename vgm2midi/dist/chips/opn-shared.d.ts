import type { MidiConverter, OPNCh3Context, OPNCh3Chip, ChannelState } from '../midi-converter';
type ActiveNoteMap = Map<string, {
    note: number;
    startTime: number;
    startVolume: number;
}>;
/** OPN/OPNA の $B4-$B6 LR 出力マスクを CC10 に変換する。 */
export declare function handleOPNPanWrite(host: MidiConverter, keyPrefix: string, port: number, reg: number, data: number, currentTime: number): boolean;
export declare function handleOPNTimbreWrite(host: MidiConverter, keyPrefix: string, port: number, reg: number, data: number, currentTime?: number): boolean;
/** OPN Ch3 Special時は親と発音中のオペレータ別トラックをまとめて更新する。 */
export declare function recordOPNTimbreEvents(host: MidiConverter, keyPrefix: string, channel: number, currentTime: number): void;
export declare function handleOPNCh3ModeWrite(host: MidiConverter, context: OPNCh3Context, data: number, currentTime: number, activeNotes: ActiveNoteMap): void;
/** OPN Timer Aの値をCSM schedulerへ反映する。 */
export declare function updateOPNCsmTimerRegister(host: MidiConverter, chip: OPNCh3Chip, instance: number, register: number, data: number): void;
/** OPN $27のCSM有効状態とTimer Aの開始状態を更新する。 */
export declare function updateOPNCsmTimer(host: MidiConverter, chip: OPNCh3Chip, instance: number, data: number, currentTime: number, activeNotes: ActiveNoteMap): void;
export declare function handleOPNCh3SpecialKeyWrite(host: MidiConverter, context: OPNCh3Context, data: number, currentTime: number, activeNotes: ActiveNoteMap, isCSMEvent?: boolean): void;
/** Ch3 Specialの新規キーオンで、発音中オペレータ同士がユニゾン(ほぼ同一音程)かを集計する。
 *
 * handleOPNCh3SpecialOperators()/handleOPNCh3SpecialPercussion()が parentState.keyOnMask を
 * 書き換える前に呼ぶ必要がある — 「新規にキーオンされたオペレータ」の判定に前回のマスクを使うため。
 */
export declare function trackOPNCh3UnisonAttack(host: MidiConverter, context: OPNCh3Context, effectiveData: number): void;
export declare function handleOPNCh3SpecialOperators(host: MidiConverter, context: OPNCh3Context, data: number, currentTime: number, activeNotes: ActiveNoteMap): void;
export declare function handleOPNCh3SpecialPercussion(host: MidiConverter, context: OPNCh3Context, data: number, currentTime: number, activeNotes: ActiveNoteMap): void;
export declare function opnCh3SpecialPercussionNote(host: MidiConverter, context: OPNCh3Context, slotMask: number): number;
export declare function opnCh3OperatorFrequency(host: MidiConverter, context: OPNCh3Context, state: ChannelState): number;
export declare function opnCh3PercussionNoteForCarrierNotes(carrierNotes: number[]): number;
export declare function handleOPNCh3SpecialFrequencyWrite(host: MidiConverter, context: OPNCh3Context, reg: number, data: number, currentTime: number, activeNotes: ActiveNoteMap, cmdIndex: number): boolean;
export declare function updateActiveOPNCh3SpecialPitches(host: MidiConverter, context: OPNCh3Context, currentTime: number, activeNotes: ActiveNoteMap): void;
export {};
