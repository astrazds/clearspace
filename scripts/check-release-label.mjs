import { readJson } from './version-files.mjs';
import { createGithub } from './version-github.mjs';
import { releaseKind } from './version-policy.mjs';

const event = await readJson(process.env.GITHUB_EVENT_PATH);
const number = event.pull_request?.number;
const details = await createGithub(process.env.GITHUB_REPOSITORY).describe({ number });
console.log(`PR #${number}: ${releaseKind(details.labels, details.files)}`);
