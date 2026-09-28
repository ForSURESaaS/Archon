import { execFileAsync } from '@archon/git';
import { access } from 'fs/promises';
import { join } from 'node:path';

/**
 * Git refuses an ordinary `worktree remove` while submodules are populated, even
 * when everything is clean. Deinitialize only after an explicit status check;
 * never use `deinit --force` (it would discard changes ignored by configuration).
 * Git's own non-forced deinit remains a guard against races and dirt. Git
 * requires one --force for worktree removal even after clean deinitialization.
 */
export async function deinitCleanWorktreeSubmodules(worktreePath: string): Promise<boolean> {
  try {
    await access(join(worktreePath, '.gitmodules'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  const { stdout } = await execFileAsync(
    'git',
    ['-C', worktreePath, 'submodule', 'status', '--recursive'],
    { timeout: 30000 }
  );
  // '-' denotes a missing/uninitialized submodule. Git refuses ordinary removal
  // even after deinit, as long as the checkout records submodules at all.
  if (!stdout.trim()) return false;
  const populated = stdout.split(/\r?\n/).some(line => line.length > 0 && !line.startsWith('-'));

  const status = await execFileAsync(
    'git',
    [
      '-C',
      worktreePath,
      'status',
      '--porcelain',
      '--untracked-files=all',
      '--ignore-submodules=none',
    ],
    { timeout: 30000 }
  );
  if (status.stdout.length > 0) {
    throw new Error(
      `Cannot remove worktree at ${worktreePath}: populated submodules or the worktree have changes. ` +
        'Commit or move the changes and retry; no submodules were deinitialized.'
    );
  }

  try {
    if (populated) {
      await execFileAsync('git', ['-C', worktreePath, 'submodule', 'deinit', '--all'], {
        timeout: 30000,
      });
    }
    const after = await execFileAsync(
      'git',
      [
        '-C',
        worktreePath,
        'status',
        '--porcelain',
        '--untracked-files=all',
        '--ignore-submodules=none',
      ],
      { timeout: 30000 }
    );
    if (after.stdout.length > 0) {
      throw new Error('The checkout changed during submodule deinitialization');
    }
    return true;
  } catch (cause) {
    throw new Error(
      `Cannot safely deinitialize submodules in ${worktreePath}; the worktree was kept. ` +
        'Check submodule changes (including untracked files) and retry after preserving them.',
      { cause }
    );
  }
}
