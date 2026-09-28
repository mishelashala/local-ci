export function laneFor(name: string, repositoryId: string): string {
  if (/server|backend/i.test(name)) {
    return 'backend';
  }
  if (/market|frontend/i.test(name)) {
    return 'frontend';
  }
  return repositoryId;
}
