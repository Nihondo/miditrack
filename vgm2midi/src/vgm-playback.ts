import { PlaybackOptions, VGMCommand, VGMData } from './types';

const VGM_SAMPLE_RATE = 44100;

export interface VGMPlaybackPlan {
  data: VGMData;
  sourceSamples: number;
  introSamples: number;
  loopSamples: number;
  totalSamples: number;
}

function countSamples(commands: VGMCommand[]): number {
  return commands.reduce((total, command) => {
    return command.type === 'wait' || command.type === 'pcm_write'
      ? total + (command.samples ?? 0)
      : total;
  }, 0);
}

function getCommandBody(commands: VGMCommand[]): VGMCommand[] {
  const endIndex = commands.findIndex(command => command.type === 'end');
  return endIndex === -1 ? commands.slice() : commands.slice(0, endIndex);
}

function appendCommands(output: VGMCommand[], commands: VGMCommand[]): void {
  for (const command of commands) {
    output.push(command);
  }
}

function appendUntilSample(
  output: VGMCommand[],
  commands: VGMCommand[],
  currentSamples: number,
  targetSamples: number
): number {
  let nextSamples = currentSamples;

  for (const command of commands) {
    if (nextSamples >= targetSamples) break;

    if (command.type !== 'wait' && command.type !== 'pcm_write') {
      output.push(command);
      continue;
    }

    const waitSamples = command.samples ?? 0;
    const appliedSamples = Math.min(waitSamples, targetSamples - nextSamples);
    // A pcm_write always outputs one PCM byte regardless of its embedded wait, so it must
    // be kept even when appliedSamples clips to 0 (e.g. a zero-wait sample write) —
    // otherwise duration-truncated DAC playback silently loses sample triggers.
    if (appliedSamples > 0 || command.type === 'pcm_write') {
      output.push(appliedSamples === waitSamples ? command : { ...command, samples: appliedSamples });
      nextSamples += appliedSamples;
    }
  }

  return nextSamples;
}

function validateOptions(options: PlaybackOptions): void {
  if (options.loopCount !== undefined && options.durationSeconds !== undefined) {
    throw new Error('--loops and --duration cannot be used together');
  }
  if (options.loopCount !== undefined
      && (!Number.isInteger(options.loopCount) || options.loopCount < 1)) {
    throw new Error('--loops must be an integer greater than or equal to 1');
  }
  if (options.durationSeconds !== undefined
      && (!Number.isFinite(options.durationSeconds) || options.durationSeconds <= 0)) {
    throw new Error('--duration must be a positive number of seconds');
  }
}

function requireLoopCommands(data: VGMData, bodyLength: number): number {
  if (data.header.loopOffset === 0) {
    throw new Error('This VGM does not define a loop point');
  }
  if (data.loopCommandIndex === undefined || data.loopCommandIndex > bodyLength) {
    throw new Error('The VGM loop point does not align with a parsed command boundary');
  }
  return data.loopCommandIndex;
}

/**
 * VGMのイントロを一度だけ保持し、指定回数または指定時間までループ区間を展開します。
 */
export function prepareVGMPlayback(
  data: VGMData,
  options: PlaybackOptions = {}
): VGMPlaybackPlan {
  validateOptions(options);

  const body = getCommandBody(data.commands);
  const sourceSamples = countSamples(body);
  const loopCount = options.loopCount ?? 1;
  const needsLoopPoint = loopCount > 1
    || (options.durationSeconds !== undefined
      && Math.round(options.durationSeconds * VGM_SAMPLE_RATE) > sourceSamples);
  const loopIndex = needsLoopPoint
    ? requireLoopCommands(data, body.length)
    : data.loopCommandIndex;
  const introCommands = loopIndex === undefined ? body : body.slice(0, loopIndex);
  const loopCommands = loopIndex === undefined ? [] : body.slice(loopIndex);
  const introSamples = countSamples(introCommands);
  const loopSamples = countSamples(loopCommands);
  const outputCommands: VGMCommand[] = [];

  if (options.durationSeconds !== undefined) {
    const targetSamples = Math.round(options.durationSeconds * VGM_SAMPLE_RATE);
    if (targetSamples < 1) {
      throw new Error('--duration is shorter than one VGM sample');
    }

    let currentSamples = appendUntilSample(outputCommands, introCommands, 0, targetSamples);
    while (currentSamples < targetSamples) {
      if (loopCommands.length === 0 || loopSamples === 0) {
        throw new Error('The VGM loop section has no playback duration');
      }
      currentSamples = appendUntilSample(
        outputCommands,
        loopCommands,
        currentSamples,
        targetSamples
      );
    }
  } else {
    appendCommands(outputCommands, introCommands);
    if (loopIndex === undefined) {
      appendCommands(outputCommands, body.slice(introCommands.length));
    } else {
      for (let pass = 0; pass < loopCount; pass += 1) {
        appendCommands(outputCommands, loopCommands);
      }
    }
  }

  outputCommands.push({ type: 'end' });
  const totalSamples = countSamples(outputCommands);

  return {
    data: {
      ...data,
      header: { ...data.header, totalSamples },
      commands: outputCommands,
    },
    sourceSamples,
    introSamples,
    loopSamples,
    totalSamples,
  };
}
