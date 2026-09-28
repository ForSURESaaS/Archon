/** Resolve a prior review report as data, before passing it to reviewer prompts. */
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { emit, refuse, text } from '../../.shared/io';

const ADOPTED = '$ADOPTED_RUN_DIR';

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function resolvePriorReport(input: string, adoptedDir: string | undefined, currentDir?: string): {
  continuation: boolean;
  prior_report: string;
} {
  const prior = input.trim();
  if (!prior) return { continuation: false, prior_report: '' };

  const adopted = adoptedDir ? resolve(adoptedDir) : undefined;
  const current = currentDir ? resolve(currentDir) : undefined;
  const referencesAdopted = prior === ADOPTED || prior.startsWith(`${ADOPTED}/`);
  if (prior.includes(ADOPTED) && !referencesAdopted) {
    throw new Error(`Previous review report has an unsupported ${ADOPTED} reference: ${prior}`);
  }
  if (!adopted && referencesAdopted) {
    throw new Error(`${ADOPTED} is referenced but this run did not adopt a prior run.`);
  }
  if (!isAbsolute(prior) && !referencesAdopted && !adopted) {
    throw new Error(`Relative previous review report requires an adopted run: ${prior}`);
  }
  // Bindings are literal data, not shell-expanded. Relative paths still refer to
  // the adopted run; corrections can also read this run's own prior review report.
  const expanded = referencesAdopted ? `${adopted}${prior.slice(ADOPTED.length)}` : prior;
  const path = resolve(adopted ?? process.cwd(), expanded);
  const roots = referencesAdopted ? [adopted] : [adopted, current];
  const allowed = roots.filter((root): root is string => root !== undefined);
  if (allowed.length > 0 && !allowed.some(root => inside(root, path))) {
    throw new Error(`Previous review report resolves outside run artifact roots: ${path}`);
  }
  try {
    if (!statSync(path).isFile()) throw new Error('not a regular file');
    // Check the actual target, not just the lexical path, to prevent symlink escapes.
    if (allowed.length > 0 && !allowed.some(root => inside(realpathSync(root), realpathSync(path)))) {
      throw new Error('resolves outside run artifact roots through a symlink');
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('resolves outside')) {
      throw new Error(`Previous review report ${error.message}: ${path}`);
    }
    throw new Error(`Previous review report does not exist or is not a file: ${path}`);
  }
  return { continuation: true, prior_report: path };
}

if (import.meta.main) {
  try {
    emit(resolvePriorReport(text(process.env.INPUTS_PRIOR_REPORT), process.env.ADOPTED_RUN_DIR, process.env.ARTIFACTS_DIR));
  } catch (error) {
    refuse(error instanceof Error ? error.message : String(error));
  }
}
