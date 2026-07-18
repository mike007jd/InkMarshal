import { Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';

const spinnerSizes = {
  sm: 'size-3.5',
  md: 'size-4',
  lg: 'size-5',
} as const;

interface SpinnerProps extends Omit<React.ComponentProps<typeof Loader2>, 'size'> {
  size?: keyof typeof spinnerSizes;
}

export function Spinner({ size = 'md', className, ...props }: SpinnerProps) {
  return (
    <Loader2
      aria-hidden
      className={cn('motion-essential animate-spin shrink-0', spinnerSizes[size], className)}
      {...props}
    />
  );
}
