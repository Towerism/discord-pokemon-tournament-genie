import { z } from 'zod';

// The app's CSP forbids eval, which Zod's JIT probes for in the browser.
z.config({ jitless: true });

export { z };
