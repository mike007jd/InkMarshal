export function CornerOrnament({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" fill="none" className={className}>
      <path d="M0 40 C0 20, 5 10, 10 5 C15 2, 20 0, 40 0" stroke="currentColor" strokeWidth="1" fill="none" />
      <path d="M0 35 C2 18, 8 10, 12 7 C16 4, 22 2, 35 0" stroke="currentColor" strokeWidth="0.5" opacity="0.5" fill="none" />
      <circle cx="8" cy="8" r="1.5" fill="currentColor" opacity="0.3" />
      <path d="M3 20 Q6 15, 12 12 Q15 6, 20 3" stroke="currentColor" strokeWidth="0.5" fill="none" opacity="0.4" />
      <path d="M10 10 Q12 8, 14 10 Q12 12, 10 10Z" fill="currentColor" opacity="0.2" />
    </svg>
  );
}

export function OrnamentalDivider({ className }: { className?: string }) {
  return (
    <div className={`book-divider ${className ?? ''}`}>
      <svg viewBox="0 0 24 12" fill="currentColor" className="w-5 h-2.5 shrink-0 opacity-60">
        <path d="M12 0 L14 4 L12 8 L10 4 Z" />
        <circle cx="12" cy="4" r="1" />
        <path d="M6 4 Q9 2, 12 4 Q9 6, 6 4Z" opacity="0.5" />
        <path d="M18 4 Q15 2, 12 4 Q15 6, 18 4Z" opacity="0.5" />
      </svg>
    </div>
  );
}

export function BookFrame({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`relative ${className ?? ''}`}>
      <CornerOrnament className="absolute top-1 left-1 w-6 h-6 text-book-gold opacity-40 pointer-events-none" />
      <CornerOrnament className="absolute top-1 right-1 w-6 h-6 text-book-gold opacity-40 -scale-x-100 pointer-events-none" />
      <CornerOrnament className="absolute bottom-1 left-1 w-6 h-6 text-book-gold opacity-40 -scale-y-100 pointer-events-none" />
      <CornerOrnament className="absolute bottom-1 right-1 w-6 h-6 text-book-gold opacity-40 -scale-x-100 -scale-y-100 pointer-events-none" />
      {children}
    </div>
  );
}
