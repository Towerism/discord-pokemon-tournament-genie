import type { Grant } from '../access/access';

// nuxt-auth-utils' sealed session (ADR-0004): the Discord user, the grant that admitted them and when
// membership was last checked; `setup` marks a browser that unlocked the wizard in this process.
declare module '#auth-utils' {
  interface User {
    id: string;
    username: string;
    globalName: string | null;
    avatar: string | null;
  }
  interface UserSession {
    grant?: Grant;
    checkedAt?: number;
    setup?: { bootId: string };
    /** The OAuth state of the login this browser started; sealed, so no other site can plant it. */
    oauthState?: string;
  }
}

export {};
