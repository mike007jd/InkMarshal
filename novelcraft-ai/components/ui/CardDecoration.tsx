'use client';

import { Pin, Paperclip } from 'lucide-react';

export type DecorationType = 'pushpin' | 'tape' | 'paperclip' | 'pushpin-dual';

interface CardDecorationProps {
  type: DecorationType;
}

export function CardDecoration({ type }: CardDecorationProps) {
  switch (type) {
    // Decoration colors are intentionally NON-danger: a brass tack / neutral
    // tape / muted clip. Red is reserved app-wide for the danger semantic
    // (--book-danger); a red pushpin in a card's top-right corner reads as an
    // error/delete badge. All tokens are --book-* so the corkboard tracks theme.
    case 'pushpin':
      return (
        <div className="absolute -top-2.5 right-3 text-book-gold-dark z-10" aria-hidden="true">
          <Pin className="w-4 h-4 fill-current" />
        </div>
      );

    case 'pushpin-dual':
      return (
        <>
          <div className="absolute -top-2.5 left-3 text-book-gold-dark z-10" aria-hidden="true">
            <Pin className="w-4 h-4 fill-current" />
          </div>
          <div className="absolute -top-2.5 right-3 text-book-gold-dark z-10" aria-hidden="true">
            <Pin className="w-4 h-4 fill-current" />
          </div>
        </>
      );

    case 'tape':
      return (
        <div
          className="absolute -top-2 left-1/2 -translate-x-1/2 w-16 h-5 bg-book-bg-card/70 backdrop-blur-sm shadow-sm border border-book-border rotate-[-2deg] z-10"
          aria-hidden="true"
        />
      );

    case 'paperclip':
      return (
        <div className="absolute -top-4 right-4 text-book-ink-muted rotate-12 z-10" aria-hidden="true">
          <Paperclip className="w-7 h-7" strokeWidth={1.5} />
        </div>
      );
  }
}
