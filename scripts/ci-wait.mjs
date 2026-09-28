#!/usr/bin/env node
// Agent handoff: node scripts/ci-wait.mjs <repository> <branch> [head-sha]
const [repository, branch, expectedHead] = process.argv.slice(2);
if (!repository || !branch) {
  console.error('Usage: ci-wait.mjs <repository> <branch> [head-sha]');
  process.exit(2);
}
const base = process.env.LOCAL_CI_URL ?? 'http://127.0.0.1:6001';
const deadline = Date.now() + Number(process.env.LOCAL_CI_WAIT_MINUTES ?? 90) * 60_000;
let last = '';
while (Date.now() < deadline) {
  try {
    const response = await fetch(`${base}/api/runs?repository=${encodeURIComponent(repository)}`);
    if (!response.ok) throw new Error(`scheduler returned ${response.status}`);
    const { runs } = await response.json();
    const run = runs.find(
      (item) =>
        item.branch === branch &&
        (!expectedHead || item.headSha === expectedHead) &&
        !['stale', 'canceled'].includes(item.status),
    );
    if (run && run.id !== last) {
      console.log(`run ${run.id} (${run.status})`);
      last = run.id;
    }
    if (run) {
      const result = await (await fetch(`${base}/api/runs/${encodeURIComponent(run.id)}/result`)).json();
      if (result.status === 'integrated') {
        console.log(`integrated ${run.candidateSha} into healthy local develop`);
        process.exit(0);
      }
      if (result.status === 'failed' || result.status === 'blocked') {
        console.error(`CI failed for ${repository}/${branch} (${run.id}):`);
        for (const line of result.failure ?? []) console.error(line);
        console.error(`logs: ${base}${result.logsUrl}`);
        process.exit(1);
      }
    }
  } catch (error) {
    console.error(`Waiting for local CI: ${error}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
console.error('Timed out waiting for local integration');
process.exit(2);
