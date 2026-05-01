import { spawnSync } from 'node:child_process';

const psqlAvailable = (): boolean => {
  try {
    return spawnSync('psql', ['--version'], { stdio: 'ignore', timeout: 5_000 }).status === 0;
  } catch {
    return false;
  }
};

export const hasPsql: boolean = psqlAvailable();
