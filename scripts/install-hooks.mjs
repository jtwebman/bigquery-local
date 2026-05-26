import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

// Point git at the versioned .githooks dir. Runs on `npm install` via the
// `prepare` lifecycle. No-op outside a git checkout (e.g. CI prod installs,
// Docker build context) so it never breaks those.
if (existsSync('.git')) {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
}
