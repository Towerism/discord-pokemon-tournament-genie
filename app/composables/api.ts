/** The message an API error carries (`data.message`), for showing to the user. */
export function errorMessage(err: unknown): string {
  const e = err as { data?: { message?: string; data?: { code?: string } }; message?: string };
  return e?.data?.message ?? e?.message ?? 'Something went wrong.';
}

export function errorCode(err: unknown): string | undefined {
  return (err as { data?: { data?: { code?: string } } })?.data?.data?.code;
}

/** Whether first-run setup is still open: `GET /api/setup` answers 410 once it is complete. */
export function useSetupComplete() {
  const complete = useState<boolean | null>('setup-complete', () => null);
  async function refresh(): Promise<boolean> {
    try {
      await $fetch('/api/setup');
      complete.value = false;
    } catch (err) {
      complete.value = (err as { statusCode?: number }).statusCode === 410;
    }
    return complete.value;
  }
  return { complete, refresh };
}
