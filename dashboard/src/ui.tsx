import { Box, Chip, Skeleton, Tooltip, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { mono } from './format';

export function Panel({
  title,
  action,
  children,
  fill = false,
  grow = false,
  scroll = true,
  open = true,
  onToggle,
  maxHeight,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  fill?: boolean;
  grow?: boolean;
  scroll?: boolean;
  open?: boolean;
  onToggle?: () => void;
  maxHeight?: number;
}) {
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        flex: grow && open ? 1 : '0 0 auto',
        height: fill && open ? '100%' : 'auto',
        maxHeight: open ? maxHeight : undefined,
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 1,
        bgcolor: 'background.paper',
        overflow: 'hidden',
      }}
    >
      <Box
        onClick={onToggle}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 1.5,
          height: 36,
          borderBottom: open ? '1px solid' : 'none',
          borderColor: 'divider',
          flex: '0 0 auto',
          cursor: onToggle ? 'pointer' : 'default',
        }}
      >
        {onToggle && (
          <Typography sx={{ width: 12, fontSize: 12, lineHeight: 1, color: 'text.secondary' }}>
            {open ? '▾' : '▸'}
          </Typography>
        )}
        <Typography variant="overline" sx={{ flex: 1, lineHeight: 1 }}>
          {title}
        </Typography>
        {action && <Box onClick={(event) => event.stopPropagation()}>{action}</Box>}
      </Box>
      {open && (
        <Box sx={{ flex: fill || grow ? 1 : undefined, minHeight: 0, overflow: scroll ? 'auto' : 'hidden' }}>
          {children}
        </Box>
      )}
    </Box>
  );
}

export function RunSkeleton() {
  return (
    <Box sx={{ px: 1.5, py: 1.1, borderBottom: '1px solid', borderColor: 'divider' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Skeleton variant="rounded" width={54} height={22} />
        <Skeleton variant="text" width="42%" height={18} />
      </Box>
      <Skeleton variant="text" width="74%" height={16} />
    </Box>
  );
}

export function LogSkeleton() {
  const widths = ['88%', '64%', '76%', '42%', '81%', '53%'];
  return (
    <Box sx={{ px: 1.5, py: 1 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <Skeleton variant="rounded" width={54} height={22} />
        <Skeleton variant="text" width="28%" height={20} />
        <Box sx={{ flex: 1 }} />
        <Skeleton variant="text" width={48} height={16} />
      </Box>
      <Skeleton variant="text" width="70%" height={14} sx={{ mb: 1.5 }} />
      {widths.map((width) => (
        <Skeleton key={width} variant="text" width={width} height={16} />
      ))}
    </Box>
  );
}

export function Sha({ value }: { value: string }) {
  return (
    <Tooltip title={value}>
      <Box
        component="span"
        sx={{ fontFamily: mono, color: 'primary.main', fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}
      >
        {value.slice(0, 7)}
      </Box>
    </Tooltip>
  );
}

const CHIP_COLOR: Record<string, 'success' | 'error' | 'warning' | 'info' | 'default'> = {
  ready: 'success',
  passed: 'success',
  merged: 'success',
  failed: 'error',
  stale: 'warning',
  canceled: 'default',
  running: 'info',
  validating: 'info',
  queued: 'default',
};

export function StatusChip({ status, label }: { status: string; label?: string }) {
  const pulse = status === 'running' || status === 'validating';
  return (
    <Chip
      size="small"
      variant="outlined"
      color={CHIP_COLOR[status] ?? 'default'}
      label={label ?? status}
      icon={
        pulse ? (
          <Box
            className="ci-pulse"
            sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: 'info.main', ml: '8px' }}
          />
        ) : undefined
      }
    />
  );
}
