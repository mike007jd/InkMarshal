import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-sharp px-2 py-0.5 text-xs font-medium transition-colors',
  {
    variants: {
      variant: {
        // Default book aesthetic
        book:
          'bg-book-bg-secondary text-book-ink-secondary border border-book-border',
        // Stage variants — tinted fills so the stage reads at a glance (not a flat chip)
        completed:
          'bg-book-success-light text-book-stage-completed border border-book-success-border',
        writing:
          'bg-book-warning-light text-book-stage-writing border border-book-warning-border',
        ready:
          'bg-book-info-light text-book-stage-ready border border-book-info-border',
        default:
          'bg-book-bg-secondary text-book-stage-default border border-book-border',
        // Semantic status
        success:
          'bg-book-success-light text-book-success border border-book-success-border',
        danger:
          'bg-book-danger-light text-book-danger border border-book-danger-border',
        info:
          'bg-book-info-light text-book-info border border-book-info-border',
        muted:
          'bg-book-bg-secondary text-book-ink-muted border border-book-border',
        // Gold accent
        gold:
          'bg-book-bg-card text-book-gold border border-book-gold',
      },
    },
    defaultVariants: {
      variant: 'book',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant, ...props }, ref) => (
    <span
      ref={ref}
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  ),
);
Badge.displayName = 'Badge';

export { Badge, badgeVariants };
