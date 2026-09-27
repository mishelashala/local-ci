import { useState } from 'react'
import { Box, Button, TextField, Typography } from '@mui/material'
import { useColorMode } from '../color-mode'
import type { RepoSnapshot } from '../gates'

const REMOTE = /^(?:git@[\w.-]+:[\w./~-]+|ssh:\/\/git@[\w.-]+\/[\w./~-]+|https:\/\/[\w.-]+\/[\w./~-]+)(?:\.git)?$/

export function Onboarding({ onSaved, onCancel }: { onSaved: (repository: RepoSnapshot) => void; onCancel?: () => void }) {
  const { mode, toggle } = useColorMode()
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [github, setGithub] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function save() {
    const repositoryId = id.trim().toLowerCase()
    const remote = github.trim()
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(repositoryId)) {
      setError('Use a short ID with letters, numbers, dots, underscores, or hyphens.')
      return
    }
    if (!REMOTE.test(remote)) {
      setError('Use a git@, ssh://, or https:// remote')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const response = await fetch('/api/repositories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: repositoryId, name: name.trim() || repositoryId, github: remote }),
      })
      const body = (await response.json()) as { error?: string; repository?: RepoSnapshot }
      if (!response.ok || !body.repository) {
        setError(body.error ?? 'Could not connect the repository')
        return
      }
      onSaved(body.repository)
    } catch {
      setError('Scheduler is not answering on 127.0.0.1:3001.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', bgcolor: 'background.default' }}>
      <Box sx={{ px: 1.5, py: 1.25, display: 'flex', alignItems: 'center', gap: 2 }}>
        <Typography sx={{ fontWeight: 600, fontSize: 16 }}>local ci</Typography>
        <Box sx={{ flex: 1 }} />
        {onCancel && <Button size="small" onClick={onCancel}>Cancel</Button>}
        <Button type="button" size="small" onClick={toggle} sx={{ minWidth: 0, py: 0, color: 'text.secondary' }}>
          {mode === 'dark' ? 'Light' : 'Dark'}
        </Button>
      </Box>
      <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', p: 2 }}>
        <Box sx={{ width: '100%', maxWidth: 460, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <Typography sx={{ fontWeight: 600, fontSize: 22 }}>Connect a repository</Typography>
          <Typography variant="body2" color="text.secondary">
            Local CI creates a bare repository, fetches its branches, and shows the exact `ci` remote path to add to your working copy.
          </Typography>
          <TextField label="Repository ID" placeholder="rxrise-server" value={id} onChange={(event) => setId(event.target.value)} fullWidth />
          <TextField label="Display name" placeholder="RxRise Server" value={name} onChange={(event) => setName(event.target.value)} fullWidth />
          <TextField
            autoFocus
            label="GitHub remote"
            placeholder="git@github.com:you/rxrise-server.git"
            value={github}
            onChange={(event) => setGithub(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void save() }}
            error={error !== null}
            helperText={error ?? 'The scheduler host must have Git access to this remote.'}
            fullWidth
          />
          <Button type="button" variant="contained" disabled={saving || !id.trim() || !github.trim()} onClick={() => void save()}>
            {saving ? 'Connecting' : 'Connect repository'}
          </Button>
        </Box>
      </Box>
    </Box>
  )
}
