import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

async function ghApi(endpoint) {
  const { stdout } = await exec('gh', ['api', endpoint], { maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(stdout);
}

export function createGithub(repository, request = ghApi) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid repository');
  const prefix = `repos/${repository}`;
  async function pages(endpoint) {
    const result = [];
    for (let page = 1; ; page++) {
      const batch = await request(`${prefix}/${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new Error('Invalid GitHub list response');
      result.push(...batch);
      if (batch.length < 100) return result;
    }
  }
  return {
    async listMerged() { return pages('pulls?state=closed&base=main&sort=updated&direction=desc'); },
    async describe(pull) {
      if (!Number.isSafeInteger(pull.number) || pull.number < 1) throw new Error('Invalid PR number');
      const details = await request(`${prefix}/pulls/${pull.number}`);
      const files = await pages(`pulls/${pull.number}/files`);
      if (!files.length || files.length !== details.changed_files) throw new Error(`Incomplete file list for PR #${pull.number}`);
      return {
        labels: details.labels.map(label => label.name),
        // A product file renamed into docs must still count as a product change.
        files: files.flatMap(file => file.previous_filename ? [file.filename, file.previous_filename] : [file.filename]),
      };
    },
  };
}

export function mergedInOrder(commits, pulls) {
  const byCommit = new Map();
  const wanted = new Set(commits);
  for (const pull of pulls) {
    if (!pull.merged_at || pull.base?.ref !== 'main' || !wanted.has(pull.merge_commit_sha)) continue;
    if (byCommit.has(pull.merge_commit_sha)) throw new Error('Ambiguous merged PR association');
    byCommit.set(pull.merge_commit_sha, { number: pull.number, mergeCommit: pull.merge_commit_sha });
  }
  return commits.flatMap(commit => byCommit.has(commit) ? [byCommit.get(commit)] : []);
}
