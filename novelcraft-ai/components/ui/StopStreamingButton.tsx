import { Square } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface StopStreamingButtonProps {
  /** Stop/abort the in-flight stream. */
  onStop: () => void;
  /** Localized label — "Pause" in the workspace, "Stop" in the edit chatbox. */
  label: string;
  /** Stretch to fill its container (stage action column). */
  fullWidth?: boolean;
  /** Icon scale — the chatbox uses a slightly larger glyph. */
  iconSize?: 'sm' | 'md';
}

/**
 * Shared danger-styled "stop the stream" affordance for NovelWorkspace,
 * StageActionPill and EditChatbox. The role has exactly one geometry — it rides
 * the canonical Button radius so a stop control never reads as a pill in one
 * surface and a box in another. Full-width stage actions use the stage row's
 * comfortable height; inline chat actions use compact height. Call sites vary
 * label, width and icon scale only.
 */
export function StopStreamingButton({
  onStop,
  label,
  fullWidth = false,
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
        fullWidth && 'w-full py-2.5',
        iconSize === 'md' && 'shrink-0 px-4',
      )}
    >
      <Square className={cn(iconSize === 'md' ? 'h-3.5 w-3.5' : 'h-3 w-3', 'fill-current')} />
      {label}
    </Button>
  );
}
