import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const inputVariants = cva('', {
  variants: {
    variant: {
      // .book-input replica — transparent bg, bottom-border only, gold focus.
      // Verbatim copy of the prior default class string (default render unchanged).
      underline:
        'w-full bg-transparent border-0 border-b border-book-border text-book-ink-primary py-2 px-0 outline-none transition-feedback placeholder:text-book-ink-muted focus:border-b-book-gold focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 file:border-0 file:bg-transparent file:text-sm file:font-medium',
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

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement>,
    VariantProps<typeof inputVariants> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, variant, ...props }, ref) => {
    return (
      <input
        type={type}
        data-slot="input"
        className={cn(inputVariants({ variant }), className)}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = 'Input';

export { Input, inputVariants };
