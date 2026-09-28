import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { resolvePriorReport } from '../../../.archon/workflows/sdlc/review/scripts/resolve-prior-report';
import { BUNDLED_WORKFLOWS } from './defaults/bundled-defaults';
import { parseWorkflow } from './loader';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await removeTempTree(root);
});

function fixture(): { adopted: string; report: string } {
  const root = mkdtempSync(join(tmpdir(), 'archon-prior-report-'));
  roots.push(root);
  const adopted = join(root, 'artifacts', 'runs', 'prior');
  mkdirSync(join(adopted, 'review'), { recursive: true });
  const report = join(adopted, 'review', 'report.md');
  writeFileSync(report, '# Previous review\n');
  return { adopted, report };
}

describe('review continuation report binding', () => {
  it('routes the verified path to both reviewer commands', () => {
    const parsed = parseWorkflow(BUNDLED_WORKFLOWS['archon-review'], 'archon-review.yaml');
    if (parsed.workflow === null) throw new Error(parsed.error.error);
    const mode = parsed.workflow.nodes.find(node => node.id === 'mode');
    expect(mode).toMatchObject({
      script: 'resolve-prior-report',
      with: { prior_report: '$INPUTS.prior_report' },
    });
    for (const id of ['scope', 'synthesize']) {
      expect(parsed.workflow.nodes.find(node => node.id === id)).toMatchObject({
        source: { with: { prior_report: '$mode.output.prior_report' } },
      });
    }
  });

  it('resolves literal adopted-run variable and relative paths under the artifact root', () => {
    const { adopted, report } = fixture();
    expect(resolvePriorReport('$ADOPTED_RUN_DIR/review/report.md', adopted)).toEqual({
      continuation: true,
      prior_report: report,
    });
    expect(resolvePriorReport('review/report.md', adopted).prior_report).toBe(report);
  });

  it('accepts a correction report from the current run even when a previous run was adopted', () => {
    const { adopted } = fixture();
    const current = fixture();
    expect(resolvePriorReport(current.report, adopted, current.adopted)).toEqual({
      continuation: true,
      prior_report: current.report,
    });
    expect(resolvePriorReport(current.report, undefined, current.adopted).prior_report).toBe(
      current.report
    );
    expect(() => resolvePriorReport(current.report, adopted)).toThrow(
      'resolves outside run artifact roots'
    );
    const outside = join(current.adopted, '..', 'outside-current.md');
    writeFileSync(outside, 'outside');
    const link = join(current.adopted, 'review', 'link.md');
    symlinkSync(outside, link);
    expect(() => resolvePriorReport(link, adopted, current.adopted)).toThrow(
      'resolves outside run artifact roots through a symlink'
    );
  });

  it('reports a fully resolved path when a prior report is missing', () => {
    const { adopted } = fixture();
    expect(() => resolvePriorReport('$ADOPTED_RUN_DIR/review/missing.md', adopted)).toThrow(
      `Previous review report does not exist or is not a file: ${join(adopted, 'review', 'missing.md')}`
    );
  });

  it('rejects a variable without adoption, but allows a first review', () => {
    expect(resolvePriorReport('', undefined)).toEqual({ continuation: false, prior_report: '' });
    expect(() => resolvePriorReport('$ADOPTED_RUN_DIR/review/report.md', undefined)).toThrow(
      '$ADOPTED_RUN_DIR is referenced but this run did not adopt a prior run.'
    );
    expect(() => resolvePriorReport('review/report.md', undefined)).toThrow(
      'Relative previous review report requires an adopted run: review/report.md'
    );
  });

  it('rejects traversal and symlink escapes beyond the adopted artifact root', () => {
    const { adopted } = fixture();
    expect(() => resolvePriorReport('../other/report.md', adopted)).toThrow(
      'resolves outside run artifact roots'
    );
    expect(() => resolvePriorReport('$ADOPTED_RUN_DIR/../other/report.md', adopted)).toThrow(
      'resolves outside run artifact roots'
    );
    const outside = join(adopted, '..', 'outside.md');
    writeFileSync(outside, 'outside');
    symlinkSync(outside, join(adopted, 'review', 'link.md'));
    expect(() => resolvePriorReport('review/link.md', adopted)).toThrow(
      'resolves outside run artifact roots through a symlink'
    );
    expect(() => resolvePriorReport('prefix$ADOPTED_RUN_DIR/review/report.md', adopted)).toThrow(
      'unsupported $ADOPTED_RUN_DIR reference'
    );
  });
});
