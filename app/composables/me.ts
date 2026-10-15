export interface DaySummary {
  id: number;
  date: string;
  title: string;
  state: 'draft' | 'open' | 'closing' | 'closed' | 'purged';
  eventCount: number;
  staffCount: number;
}

export interface Me {
  user: { id: string; username: string; globalName: string | null; avatar: string | null };
  grant: 'owner' | 'organizer_role' | 'allowlist' | 'event_head_judge';
  isOwner: boolean;
  isOrganizer: boolean;
  headJudgeDays: DaySummary[];
}

/** Who is signed in and what they may use; the navigation and pages follow it. */
export function useMe() {
  const { loggedIn } = useUserSession();
  return useFetch<Me | null>('/api/me', { key: 'me', immediate: loggedIn.value, watch: [loggedIn], default: () => null });
}
