import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupSteps, parseActSteps } from '../../dashboard/src/steps.ts';

test('a job that fails after every step succeeded is failed', () => {
  const lines = [
    '[Run Tests/architecture  ]   ✅  Success - Main Architecture fitness [1s]',
    '[Run Tests/architecture  ] 🏁  Job succeeded',
    '[Run Tests/backend-tests ]   ✅  Success - Set up job',
    '[Run Tests/backend-tests ]   ✅  Success - Complete job',
    '[Run Tests/backend-tests ] 🏁  Job failed',
    'Error: dial tcp: lookup github.com: no such host',
  ];
  const jobs = groupSteps(parseActSteps(lines));
  assert.equal(jobs.find((job) => job.job === 'architecture')?.status, 'passed');
  const backend = jobs.find((job) => job.job === 'backend-tests');
  assert.equal(backend?.status, 'failed');
  assert.match(backend?.steps.at(-1)?.lines.join('\n') ?? '', /no such host/);
});
