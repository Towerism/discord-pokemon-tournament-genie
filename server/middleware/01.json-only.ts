import { jsonOnly } from '@towerism/selfhost-kit/nitro';

/** CSRF guard (§9): a state-changing /api request with a body must be JSON. */
export default jsonOnly();
