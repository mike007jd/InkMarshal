import { Square } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface StopStreamingButtonProps {
  /** Stop/abort the in-flight stream. */
  onStop: () => void;
  /** Localized label — "Pause" in the workspace, "Stop" in the edit chatbox. */
  label: string;
  /** Icon scale — the chatbox uses a slightly larger glyph. */
  iconSize?: 'sm' | 'md';
}

/**
 * Shared danger-styled "stop the stream" affordance for manuscript editing
 * and EditChatbox. The role has exactly one geometry — it rides
 * the canonical Button radius so a stop control never reads as a pill in one
 * surface and a box in another. Call sites vary label and icon scale only.
 */
export function StopStreamingButton({
  onStop,
  label,
  iconSize = 'sm',
}: StopStreamingButtonProps) {
  return (
    <Button
      type="button"
      variant="danger-soft"
      size="unstyled"
      onClick={onStop}
      className={cn(
        'h-auto cursor-pointer gap-1.5 px-3 py-2 text-xs font-medium transition',
        iconSize === 'md' && 'shrink-0 px-4',
      )}
    >
      <Square className={cn(iconSize === 'md' ? 'h-3.5 w-3.5' : 'h-3 w-3', 'fill-current')} />
      {label}
    </Button>
  );
}
