import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

// Releases come from the kit's workflows and config (ADR-0011), and stay off until the owner opts in after the
// Caddy round trip (owner decision on #11, deploy guide).
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { devDependencies: Record<string, string> };
const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
  jobs: Record<string, { uses?: string; needs?: string[] | string; if?: string; permissions?: Record<string, string>; with?: Record<string, string> }>;
};

describe('the release setup', () => {
  it("extends the kit's release config", () => {
    expect(JSON.parse(readFileSync('.releaserc.json', 'utf8'))).toEqual({ extends: '@towerism/selfhost-kit/release-config' });
    for (const dep of ['semantic-release', '@semantic-release/exec', 'conventional-changelog-conventionalcommits']) {
      expect(pkg.devDependencies).toHaveProperty(dep);
    }
  });

  it("builds and smoke-tests the image through the kit's workflow, pinned by full SHA, after check", () => {
    const image = ci.jobs.image!;
    expect(image.uses).toMatch(/^Towerism\/selfhost-kit\/\.github\/workflows\/app-image\.yml@[0-9a-f]{40}$/);
    expect(image.needs).toBe('check');
    expect(image.permissions).toEqual({ contents: 'read', packages: 'write' });
    expect(image.with!['smoke-scripts']!.trim().split('\n').map((s) => s.trim())).toEqual([
      'test/docker/smoke.sh',
      'test/docker/restore-drill.sh',
      'test/docker/litestream.sh',
    ]);
  });

  it('releases only from main, after every job, on the tested digest, and only once the owner opts in', () => {
    const release = ci.jobs.release!;
    expect(release.uses).toMatch(/^Towerism\/selfhost-kit\/\.github\/workflows\/app-release\.yml@[0-9a-f]{40}$/);
    expect(release.uses!.split('@')[1]).toBe(ci.jobs.image!.uses!.split('@')[1]);
    expect(release.needs).toEqual(['check', 'e2e', 'image']);
    expect(release.if).toContain("github.event_name == 'push'");
    expect(release.if).toContain("github.ref == 'refs/heads/main'");
    expect(release.if).toContain("vars.RELEASES_ENABLED == 'true'");
    expect(release.with).toEqual({ 'image-name': ci.jobs.image!.with!['image-name'], digest: '${{ needs.image.outputs.digest }}' });
  });
});
