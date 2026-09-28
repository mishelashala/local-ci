import { useState } from 'react'
import { Box, Button, Dialog, DialogContent, DialogTitle, Typography } from '@mui/material'
import { mono } from '../format'
import type { RepoSnapshot } from '../gates'

function Command({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <Box>
      <Typography variant="body2" sx={{ mb: 0.75 }}>{label}</Typography>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
        <Typography sx={{ flex: 1, fontFamily: mono, fontSize: 13, wordBreak: 'break-all', bgcolor: 'action.hover', borderRadius: 1, px: 1.25, py: 1 }}>
          {command}
        </Typography>
        <Button size="small" variant="outlined" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</Button>
      </Box>
    </Box>
  )
}

export function ConnectDialog({ repo, open, onClose }: { repo: RepoSnapshot | null; open: boolean; onClose: () => void }) {
  if (!repo) return null
  const add = `git remote add ci ${repo.barePath}`
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Connect {repo.name}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pb: 2.5 }}>
        <Typography variant="body2" color="text.secondary">Run these in that project's folder.</Typography>
        <Command label="1. Add the local remote" command={add} />
        <Command label="2. Push a branch" command="git push ci your-branch" />
        <Box>
          <Button size="small" onClick={onClose}>Close</Button>
        </Box>
      </DialogContent>
    </Dialog>
  )
}
