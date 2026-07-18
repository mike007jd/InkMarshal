import * as React from 'react';
import { Slot } from 'radix-ui';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  // Base: cursor, inline-flex, align, font, whitespace, ring-offset, rounded-md
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-feedback focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        // Default = book/烫金 — replicates .book-btn exactly
        book:
          'bg-book-bg-card text-book-ink-primary border border-book-border cursor-pointer hover:border-book-gold hover:shadow-[0_0_0_1px_var(--book-gold-light)]',
        ghost:
          'text-book-ink-primary hover:bg-book-bg-secondary hover:text-book-ink-primary',
        // Primary solid book-ink fill (replaces the repeated ghost + 6-class ink override)
        ink:
          'bg-book-ink-primary text-book-bg-primary border border-transparent hover:bg-book-ink-primary hover:text-book-bg-primary hover:opacity-90 disabled:opacity-50',
        // Solid gold/烫金 accent CTA — text-book-on-gold flips to dark ink in dark mode (dark gold is too light for white)
        accent:
          'bg-book-accent text-book-on-gold border border-transparent hover:bg-book-accent hover:text-book-on-gold hover:opacity-90 disabled:opacity-50',
        outline:
          'border border-book-border bg-transparent text-book-ink-primary hover:bg-book-bg-secondary hover:border-book-gold',
        destructive:
          'bg-destructive text-white hover:bg-destructive/90 border border-transparent',
        // Soft semantic pair for inline accept/reject decisions (diff review).
        'success-soft':
          'bg-book-success-light text-book-success border border-book-success-border hover:bg-book-success/20',
        'danger-soft':
          'bg-book-danger-light text-book-danger border border-book-danger-border hover:bg-book-danger/20',
        unstyled:
          'border-transparent bg-transparent text-inherit hover:bg-transparent hover:text-inherit',
      },
      size: {
        sm: 'h-7 px-3 text-xs',
        md: 'h-9 px-4 py-2 text-sm',
        lg: 'h-11 px-6 text-base',
        icon: 'h-9 w-9',
        unstyled: '',
      },
    },
    defaultVariants: {
      variant: 'book',
      size: 'md',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot.Root : 'button';
    return (
      <Comp
        data-slot="button"
        className={cn(buttonVariants({ variant, size }), className)}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
