import assert from 'node:assert/strict';
import test from 'node:test';
import { auditLegacyOwnership } from '../../tools/legacy-ownership-audit.mjs';

const membership = (userId, organizationId) => ({ PK: `USER#${userId}`, SK: `MEMBERSHIP#${organizationId}`, userId, organizationId });
const project = (projectId, organizationId, ownerUserId = 'owner') => ({ PK: `PROJECT#${projectId}`, SK: 'META', projectId, organizationId, ownerUserId });

test('single-project organization is unambiguous', () => assert.equal(auditLegacyOwnership({ memberships: [membership('u1', 'o1')], projects: [project('p1', 'o1')] }).results[0].classification, 'unambiguous_match'));
test('multi-project organization is ambiguous', () => assert.deepEqual(auditLegacyOwnership({ memberships: [membership('u1', 'o1')], projects: [project('p1', 'o1'), project('p2', 'o1')] }).results[0].candidateProjectIds, ['p1', 'p2']));
test('missing metadata is no match', () => assert.equal(auditLegacyOwnership({ memberships: [membership('u1', 'missing')], projects: [] }).results[0].classification, 'no_match'));
test('conflicting owner organization is invalid', () => assert.equal(auditLegacyOwnership({ memberships: [membership('u1', 'o1')], projects: [project('p1', 'o2', 'u1')] }).results[0].classification, 'invalid_or_inconsistent'));
test('users with multiple organizations are evaluated independently', () => {
  const result = auditLegacyOwnership({ memberships: [membership('u1', 'o1'), membership('u1', 'o2')], projects: [project('p1', 'o1'), project('p2', 'o2')] });
  assert.deepEqual(result.results.map((item) => item.projectId), ['p1', 'p2']);
});
