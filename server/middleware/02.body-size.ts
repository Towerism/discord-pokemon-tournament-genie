import { bodySizeLimit } from '@towerism/selfhost-kit/nitro';

/** 1 MiB is plenty for every /api body; nothing is uploaded in M1. */
export const MAX_BODY_BYTES = 1_048_576;

export default bodySizeLimit({ maxBytes: MAX_BODY_BYTES });
