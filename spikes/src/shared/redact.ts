const MASK = '[redacted]';

/** Masks secret values, interaction/webhook tokens in API paths, and OAuth code/state query values. */
export function createRedactor(secrets: string[]): (text: string) => string {
  const values = secrets.filter((s) => s.length > 0);
  return (text) => {
    let out = text;
    for (const value of values) out = out.split(value).join(MASK);
    out = out.replace(/\/(interactions|webhooks)\/(\d+)\/[\w-]+/g, `/$1/$2/${MASK}`);
    out = out.replace(/([?&](?:code|state)=)[^&\s#]+/g, `$1${MASK}`);
    return out;
  };
}
