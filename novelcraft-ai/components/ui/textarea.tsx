import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const textareaVariants = cva('', {
  variants: {
    variant: {
      // .book-input replica on a <textarea>.
      // Verbatim copy of the prior default class string (default render unchanged).
      underline:
        'w-full bg-transparent border-0 border-b border-book-border text-book-ink-primary py-2 px-0 outline-none resize-none transition-feedback placeholder:text-book-ink-muted focus:border-b-book-gold focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 min-h-[80px]',
      // Self-contained bordered box — cancels the underline + gold-focus by being
      // a complete box (the gold-underline-cancel is now self-documenting).
      boxed:
        'border border-book-border rounded-md bg-book-bg-card px-2 py-1.5 text-book-ink-primary focus:border-book-border focus:outline-none',
    },
  },
  defaultVariants: {
    variant: 'underline',
  },
});

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement>,
    VariantProps<typeof textareaVariants> {}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, variant, ...props }, ref) => {
    return (
      <textarea
        data-slot="textarea"
        className={cn(textareaVariants({ variant }), className)}
        ref={ref}
        {...props}
      />
    );
  },
);
Textarea.displayName = 'Textarea';

export { Textarea, textareaVariants };
