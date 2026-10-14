import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

// Renovate and the main ruleset (issue #4; kit ADR-0005 "Security fixes" §4). Renovate's own behaviour
// (preset resolution, rule order, extraction) is checked against the real tool before merge. These tests pin
// the safety properties to the repo facts they depend on, so a rename or a loosened rule fails here.

const KIT_NPM = '@towerism/selfhost-kit';
// config:recommended's ignorePaths. A repo ignorePaths replaces the preset's list instead of adding to it.
const RECOMMENDED_IGNORE_PATHS = [
  '**/node_modules/**',
  '**/bower_components/**',
  '**/vendor/**',
  '**/examples/**',
  '**/__tests__/**',
  '**/test/**',
  '**/tests/**',
  '**/__fixtures__/**',
];
// The job id inside the kit's app-image.yml. GitHub names a reusable workflow's check "<caller> / <callee job>",
// so this half of a required check name belongs to the kit.
const KIT_IMAGE_JOB = 'image';
const GITHUB_ACTIONS_APP_ID = 15368;

interface PackageRule {
  matchPackageNames?: string[];
  matchUpdateTypes?: string[];
  automerge?: boolean;
  groupName?: string;
  [key: string]: unknown;
}
interface RenovateConfig {
  automerge?: boolean;
  ignorePaths?: string[];
  vulnerabilityAlerts?: Record<string, unknown>;
  packageRules?: PackageRule[];
  customManagers?: { customType: string; managerFilePatterns: string[]; matchStrings: string[] }[];
}
interface Job { name?: string; uses?: string; if?: string }
interface Ruleset {
  target: string;
  enforcement: string;
  bypass_actors: unknown[];
  conditions: { ref_name: { include: string[]; exclude: string[] } };
  rules: { type: string; parameters?: Record<string, unknown> }[];
}

const renovate = () => JSON.parse(readFileSync('renovate.json', 'utf8')) as RenovateConfig;
const ciJobs = () => (parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as { jobs: Record<string, Job> }).jobs;
const ruleset = () => JSON.parse(readFileSync('.github/rulesets/main.json', 'utf8')) as Ruleset;
const kitGroup = () => {
  const rules = (renovate().packageRules ?? []).filter((r) => r.groupName === 'selfhost-kit');
  expect(rules).toHaveLength(1);
  return rules[0]!;
};

describe('Renovate', () => {
  it("groups the kit's npm package with every kit workflow that ci.yml calls", () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies: Record<string, string> };
    expect(pkg.dependencies).toHaveProperty(KIT_NPM);
    const kitRepos = Object.values(ciJobs())
      .map((job) => job.uses?.match(/^([^/]+\/selfhost-kit)\/\.github\/workflows\//)?.[1])
      .filter((repo): repo is string => repo !== undefined);
    expect(kitRepos.length).toBeGreaterThan(0);

    expect(kitGroup().matchPackageNames).toEqual(expect.arrayContaining([KIT_NPM, ...kitRepos]));
  });

  it("automerges only the kit's patch and minor updates, never a major", () => {
    const config = renovate();
    expect(config.automerge).not.toBe(true);
    const automerging = (config.packageRules ?? []).filter((r) => r.automerge === true);

    expect(automerging).toHaveLength(1);
    expect([...automerging[0]!.matchUpdateTypes!].sort()).toEqual(['minor', 'patch']);
    expect([...automerging[0]!.matchPackageNames!].sort()).toEqual([...kitGroup().matchPackageNames!].sort());
  });

  it('never reads spikes/, and keeps the recommended ignore list', () => {
    expect(renovate().ignorePaths).toEqual(expect.arrayContaining([...RECOMMENDED_IGNORE_PATHS, 'spikes/**']));
  });

  it("leaves vulnerability alerts on by default instead of forcing them on (a forced enable undoes ignore rules)", () => {
    const alerts = renovate().vulnerabilityAlerts!;
    expect(alerts).not.toHaveProperty('enabled');
    expect(alerts.labels).toEqual(['security']);
  });

  it("tracks the Dockerfile's pnpm and keeps it equal to package.json's packageManager", () => {
    const managers = (renovate().customManagers ?? []).filter((m) =>
      m.managerFilePatterns.some((p) => new RegExp(p.replace(/^\/|\/$/g, '')).test('Dockerfile')),
    );
    expect(managers).toHaveLength(1);
    const dockerfile = readFileSync('Dockerfile', 'utf8');
    const matches = managers[0]!.matchStrings.flatMap((s) => [...dockerfile.matchAll(new RegExp(s, 'g'))]);

    expect(matches).toHaveLength(1);
    const { datasource, depName, currentValue } = matches[0]!.groups!;
    const { packageManager } = JSON.parse(readFileSync('package.json', 'utf8')) as { packageManager: string };
    expect({ datasource, depName, currentValue }).toEqual({ datasource: 'npm', depName: 'pnpm', currentValue: packageManager.replace(/^pnpm@/, '') });
  });
});

describe("pnpm's release-age gate", () => {
  it('exempts the kit by name, so each fresh kit release installs', () => {
    const { minimumReleaseAgeExclude } = parse(readFileSync('pnpm-workspace.yaml', 'utf8')) as { minimumReleaseAgeExclude: string[] };
    const kitEntries = minimumReleaseAgeExclude.filter((e) => e === KIT_NPM || e.startsWith(`${KIT_NPM}@`));

    expect(kitEntries).toEqual([KIT_NPM]);
  });
});

describe('the main ruleset', () => {
  it('requires a pull request, blocks force-pushes and deletion, and has no bypass', () => {
    const rs = ruleset();
    expect(rs.target).toBe('branch');
    expect(rs.enforcement).toBe('active');
    expect(rs.conditions.ref_name.include).toEqual(['~DEFAULT_BRANCH']);
    expect(rs.bypass_actors).toEqual([]);
    expect(rs.rules.map((r) => r.type).sort()).toEqual(['deletion', 'non_fast_forward', 'pull_request', 'required_status_checks']);
  });

  it('requires exactly the checks CI reports on pull requests, from GitHub Actions', () => {
    // A job limited to pushes (release) is skipped on PRs, so it is never required.
    const prChecks = Object.entries(ciJobs())
      .filter(([, job]) => !job.if?.includes("github.event_name == 'push'"))
      .map(([id, job]) => (job.uses?.includes('/selfhost-kit/.github/workflows/app-image.yml@') ? `${job.name ?? id} / ${KIT_IMAGE_JOB}` : (job.name ?? id)));
    const checks = ruleset().rules.find((r) => r.type === 'required_status_checks')!.parameters!
      .required_status_checks as { context: string; integration_id: number }[];

    expect(checks.map((c) => c.context).sort()).toEqual(prChecks.sort());
    expect(checks.every((c) => c.integration_id === GITHUB_ACTIONS_APP_ID)).toBe(true);
  });
});
