export function validateRunContext(env, event) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REF !== 'refs/heads/main') throw new Error('Requires trusted main workflow context');
  if (env.GITHUB_EVENT_NAME === 'workflow_dispatch') return;
  const run = event.workflow_run;
  if (env.GITHUB_EVENT_NAME !== 'workflow_run' || run?.name !== 'CI' || run.event !== 'push'
    || run.conclusion !== 'success' || run.head_branch !== 'main'
    || run.head_repository?.full_name !== env.GITHUB_REPOSITORY) throw new Error('Requires trusted successful main CI');
}
