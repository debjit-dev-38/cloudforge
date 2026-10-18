export function auditLegacyOwnership({ memberships, projects }) {
  const projectList = projects.filter((item) => item?.SK === 'META' && typeof item.projectId === 'string');
  const byOrganization = new Map();
  for (const project of projectList) {
    if (typeof project.organizationId !== 'string' || !project.organizationId) continue;
    const list = byOrganization.get(project.organizationId) || [];
    list.push(project);
    byOrganization.set(project.organizationId, list);
  }
  const results = [];
  for (const membership of memberships) {
    const userId = membership?.userId;
    const organizationId = membership?.organizationId;
    const membershipKey = `${membership?.PK || ''}/${membership?.SK || ''}`;
    if (!membership || typeof userId !== 'string' || !userId || typeof organizationId !== 'string' || !organizationId) {
      results.push({ classification: 'invalid_or_inconsistent', membershipKey, evidence: ['membership requires userId and organizationId'] });
      continue;
    }
    if (membership.projectId) continue;
    const ownedElsewhere = projectList.filter((project) => project.ownerUserId === userId && project.organizationId !== organizationId);
    if (ownedElsewhere.length) {
      results.push({ classification: 'invalid_or_inconsistent', membershipKey, organizationId, evidence: [`user owns project(s) in a different organization: ${ownedElsewhere.map((project) => project.projectId).join(', ')}`] });
      continue;
    }
    const candidates = (byOrganization.get(organizationId) || []).map((project) => project.projectId).sort();
    if (candidates.length === 0) results.push({ classification: 'no_match', membershipKey, organizationId, evidence: ['no project META record has this organizationId'] });
    else if (candidates.length === 1) results.push({ classification: 'unambiguous_match', membershipKey, organizationId, projectId: candidates[0], evidence: ['legacy organization membership and exactly one project META record share organizationId'] });
    else results.push({ classification: 'ambiguous_match', membershipKey, organizationId, candidateProjectIds: candidates, evidence: ['legacy organization membership matches multiple project META records; membership has no projectId'] });
  }
  const counts = results.reduce((summary, item) => ({ ...summary, [item.classification]: (summary[item.classification] || 0) + 1 }), {});
  return { counts, results };
}

async function scanAll(client, TableName, ScanCommand) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await client.send(new ScanCommand({ TableName, ExclusiveStartKey, ProjectionExpression: 'PK, SK, projectId, organizationId, ownerUserId, userId, #name', ExpressionAttributeNames: { '#name': 'name' } }));
    items.push(...(page.Items || []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

export async function runAudit({ client, tableName, ScanCommand }) {
  if (!tableName) throw new Error('tableName is required');
  const items = await scanAll(client, tableName, ScanCommand);
  return auditLegacyOwnership({
    memberships: items.filter((item) => typeof item.SK === 'string' && item.SK.startsWith('MEMBERSHIP#')),
    projects: items.filter((item) => item.SK === 'META' && typeof item.PK === 'string' && item.PK.startsWith('PROJECT#')),
  });
}

if (process.argv[1]?.endsWith('legacy-ownership-audit.mjs')) {
  const tableName = process.argv[2] || process.env.TABLE_NAME;
  if (!tableName) throw new Error('Usage: node tools/legacy-ownership-audit.mjs <table-name>');
  const [{ DynamoDBClient }, { DynamoDBDocumentClient, ScanCommand }] = await Promise.all([import('@aws-sdk/client-dynamodb'), import('@aws-sdk/lib-dynamodb')]);
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  console.log(JSON.stringify(await runAudit({ client, tableName, ScanCommand }), null, 2));
}
