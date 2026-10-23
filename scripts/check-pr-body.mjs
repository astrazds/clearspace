import { readFileSync } from 'node:fs';

const marker = 'CURSOR_AGENT_PR_BODY';

function readBody(argv, env) {
  const fileFlag = argv.indexOf('--file');
  if (fileFlag === -1) return env.PR_BODY ?? '';

  const path = argv[fileFlag + 1];
  if (!path) throw new Error('Pass a file path after --file.');

  return readFileSync(path, 'utf8');
}

const body = readBody(process.argv, process.env);
if (body.includes(marker)) {
  console.error('Pull request body contains an agent footer marker.');
  process.exit(1);
}
