import { PlaybackOptions, VGMData } from './types';
export interface VGMPlaybackPlan {
    data: VGMData;
    sourceSamples: number;
    introSamples: number;
    loopSamples: number;
    totalSamples: number;
}
/**
 * VGMのイントロを一度だけ保持し、指定回数または指定時間までループ区間を展開します。
 */
export declare function prepareVGMPlayback(data: VGMData, options?: PlaybackOptions): VGMPlaybackPlan;
