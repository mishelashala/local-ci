import { useState } from 'react'
import { Box, Button, TextField, Typography } from '@mui/material'
import { useColorMode } from '../color-mode'

const REMOTE = /^(?:git@[\w.-]+:[\w./~-]+|ssh:\/\/git@[\w.-]+\/[\w./~-]+|https:\/\/[\w.-]+\/[\w./~-]+)(?:\.git)?$/

export function Onboarding({ onSaved }: { onSaved: (origin: string) => void }) {
  const { mode, toggle } = useColorMode()
  const [github, setGithub] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function save() {
    const remote = github.trim()
    if (!REMOTE.test(remote)) {
      setError('Use a git@, ssh://, or https:// remote')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const response = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ github: remote }),
      })
      const body = (await response.json()) as { error?: string; origin?: string }
      if (!response.ok || typeof body.origin !== 'string') {
        setError(typeof body.error === 'string' ? body.error : 'Could not save the remote')
        return
      }
      onSaved(body.origin)
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
        <Button type="button" size="small" onClick={toggle} sx={{ minWidth: 0, py: 0, color: 'text.secondary' }}>
          {mode === 'dark' ? 'Light' : 'Dark'}
        </Button>
      </Box>
      <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', p: 2 }}>
        <Box sx={{ width: '100%', maxWidth: 460, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <Typography sx={{ fontWeight: 600, fontSize: 22 }}>Where does this app live on GitHub?</Typography>
          <Typography variant="body2" color="text.secondary">
            develop and main are pushed to this remote. Feature branches still use git push ci.
          </Typography>
          <TextField
            autoFocus
            label="GitHub remote"
            placeholder="git@github.com:you/sample-app.git"
            value={github}
            onChange={(event) => setGithub(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void save()
            }}
            error={error !== null}
            helperText={error ?? 'git@github.com:you/sample-app.git'}
            fullWidth
          />
          <Button type="button" variant="contained" disabled={saving || github.trim().length === 0} onClick={() => void save()}>
            {saving ? 'Saving' : 'Save remote'}
          </Button>
        </Box>
      </Box>
    </Box>
  )
}
