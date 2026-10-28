import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRunContext } from '../scripts/version-context.mjs';

const env = { GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'owner/repo', GITHUB_EVENT_NAME: 'workflow_run' };
const event = { workflow_run: { name: 'CI', event: 'push', conclusion: 'success', head_branch: 'main', head_repository: { full_name: 'owner/repo' } } };
test('write automation accepts successful main CI and explicit main retries only', () => {
  validateRunContext(env, event);
  validateRunContext({ ...env, GITHUB_EVENT_NAME: 'workflow_dispatch' }, {});
  for (const change of [{ event: 'pull_request' }, { conclusion: 'failure' }, { head_branch: 'feature' }, { head_repository: { full_name: 'fork/repo' } }]) {
    assert.throws(() => validateRunContext(env, { workflow_run: { ...event.workflow_run, ...change } }), /trusted/);
  }
  assert.throws(() => validateRunContext({ ...env, GITHUB_REF: 'refs/heads/feature' }, event), /trusted/);
  assert.throws(() => validateRunContext({ ...env, GITHUB_ACTIONS: 'false' }, event), /trusted/);
});
