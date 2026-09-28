import { Box, Button, Typography } from '@mui/material';
import { useState } from 'react';
import { useColorMode } from '../color-mode';
import { mono } from '../format';
import type { RepoSnapshot } from '../gates';
import { useToast } from '../toast';

export function Repositories({
  repositories,
  activeId,
  onOpen,
  onAdd,
  onRemoved,
  onClose,
}: {
  repositories: RepoSnapshot[];
  activeId: string;
  onOpen: (id: string) => void;
  onAdd: () => void;
  onRemoved: (id: string) => void;
  onClose: () => void;
}) {
  const { mode, toggle } = useColorMode();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const notify = useToast();

  async function remove(id: string) {
    const repository = repositories.find((item) => item.id === id);
    setRemovingId(id);
    try {
      const response = await fetch(`/api/repositories/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        notify('error', body.error ?? `Remove failed (${response.status})`);
        return;
      }
      setPendingId(null);
      onRemoved(id);
      notify('success', `Removed ${repository?.name ?? 'repository'}`);
    } catch {
      notify('error', 'Scheduler is not answering on 127.0.0.1:6001.');
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', bgcolor: 'background.default' }}>
      <Box
        sx={{
          px: 1.5,
          py: 1.25,
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          borderBottom: '1px solid',
          borderColor: 'divider',
        }}
      >
        <Typography sx={{ fontWeight: 600, fontSize: 16 }}>local ci</Typography>
        <Typography variant="caption" color="text.secondary">
          {repositories.length} repositories
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Button size="small" onClick={onAdd}>
          Add repository
        </Button>
        <Button size="small" onClick={onClose}>
          Back
        </Button>
        <Button type="button" size="small" onClick={toggle} sx={{ minWidth: 0, py: 0, color: 'text.secondary' }}>
          {mode === 'dark' ? 'Light' : 'Dark'}
        </Button>
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', p: 1.5, display: 'flex', flexDirection: 'column', gap: 1 }}>
        {repositories.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            No repositories yet.
          </Typography>
        )}
        {repositories.map((repository) => {
          const confirming = pendingId === repository.id;
          return (
            <Box
              key={repository.id}
              sx={{
                border: '1px solid',
                borderColor: 'divider',
                borderRadius: 1,
                bgcolor: 'background.paper',
                px: 1.5,
                py: 1.25,
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Typography sx={{ fontWeight: 600, flex: 1 }} noWrap>
                  {repository.name}
                </Typography>
                {repository.id === activeId && (
                  <Typography variant="caption" color="success.main">
                    open
                  </Typography>
                )}
                <Button size="small" onClick={() => onOpen(repository.id)}>
                  Open
                </Button>
                <Button
                  size="small"
                  color="error"
                  variant="outlined"
                  disabled={removingId !== null}
                  onClick={() => setPendingId(repository.id)}
                >
                  Remove
                </Button>
              </Box>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                {repository.id} · {repository.branches.length} branches
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontFamily: mono }}>
                {repository.origin ?? 'No GitHub remote'}
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontFamily: mono }}>
                {repository.barePath}
              </Typography>
              {confirming && (
                <Box sx={{ mt: 1 }}>
                  <Typography variant="caption" color="error.main" sx={{ display: 'block' }}>
                    Delete {repository.name}? This removes the local bare repository and its run history. GitHub is left
                    unchanged.
                  </Typography>
                  <Box sx={{ display: 'flex', gap: 1, mt: 0.75 }}>
                    <Button
                      size="small"
                      color="error"
                      variant="contained"
                      loading={removingId === repository.id}
                      loadingPosition="center"
                      disabled={removingId !== null && removingId !== repository.id}
                      onClick={() => void remove(repository.id)}
                    >
                      Delete local repository
                    </Button>
                    <Button size="small" disabled={removingId !== null} onClick={() => setPendingId(null)}>
                      Cancel
                    </Button>
                  </Box>
                </Box>
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
