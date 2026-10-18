import assert from 'node:assert/strict';
import test from 'node:test';
import { listAuthorizedProjects, setStoreClientForTests } from '../../apps/api/src/store.js';

test('discovers legacy memberships through organization project index and paginates', async () => {
  const calls = [];
  const client = { async send(command) {
    calls.push(command.input);
    if (command.input.IndexName) return { Items: [{ PK: 'PROJECT#p1', SK: 'META', projectId: 'p1', organizationId: 'o1', name: 'One' }], LastEvaluatedKey: undefined };
    return { Items: [{ PK: 'USER#u1', SK: 'MEMBERSHIP#o1', userId: 'u1', organizationId: 'o1' }], LastEvaluatedKey: undefined };
  } };
  const restore = setStoreClientForTests(client);
  try {
    const result = await listAuthorizedProjects('u1');
    assert.deepEqual(result.projects.map((item) => item.projectId), ['p1']);
    assert.equal(calls[1].IndexName, 'OrganizationProjectsIndex');
    assert.equal(calls[1].FilterExpression, 'SK = :meta');
  } finally { restore(); }
});

test('deduplicates organizations and rejects forged discovery cursors', async () => {
  const client = { async send(command) {
    if (command.input.IndexName) return { Items: [{ PK: 'PROJECT#p1', SK: 'META', projectId: 'p1', organizationId: 'o1' }], LastEvaluatedKey: undefined };
    return { Items: [{ PK: 'USER#u1', SK: 'MEMBERSHIP#o1', organizationId: 'o1' }, { PK: 'USER#u1', SK: 'MEMBERSHIP#o1-copy', organizationId: 'o1' }], LastEvaluatedKey: undefined };
  } };
  const restore = setStoreClientForTests(client);
  try {
    assert.equal((await listAuthorizedProjects('u1')).projects.length, 1);
    await assert.rejects(() => listAuthorizedProjects('u1', 50, { PK: 'USER#u2', SK: 'ORG_PROJECTS', organizationIds: ['o1'], organizationIndex: 0 }), { code: 'INVALID_CURSOR' });
  } finally { restore(); }
});
