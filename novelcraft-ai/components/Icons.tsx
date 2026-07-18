export function ManuscriptIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a2.5 2.5 0 0 1 0-5H20" />
      <path d="M8 7h6" />
      <path d="M8 11h8" />
    </svg>
  );
}

export function FeatherIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z" />
      <line x1="16" y1="8" x2="2" y2="22" />
      <line x1="17.5" y1="15" x2="9" y2="15" />
    </svg>
  );
}

export function NibIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 2l4 6v4l-4 10-4-10V8l4-6z" />
      <path d="M12 12v10" />
      <path d="M10 10h4" />
    </svg>
  );
}

/**
 * Brand mark — single-color SVG that tracks `currentColor` so the logo
 * adapts to the surrounding theme (e.g. `text-book-gold` in the sidebar,
 * neutral ink elsewhere, auto-flipping in dark mode). The open-book pages
 * are filled with a soft tint of `currentColor`; the outline + quill nib
 * use full-strength `currentColor` strokes.
 */
export function InkMarshalLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label="InkMarshal"
      className={className}
    >
      <path
        d="M3.5 5.8c2.6-.9 5.3-.9 8 .7v12.8c-2.7-1.6-5.4-1.6-8-.7V5.8z"
        fill="currentColor"
        fillOpacity="0.14"
        stroke="none"
      />
      <path
        d="M20.5 5.8c-2.6-.9-5.3-.9-8 .7v12.8c2.7-1.6 5.4-1.6 8-.7V5.8z"
        fill="currentColor"
        fillOpacity="0.14"
        stroke="none"
      />
      <path d="M3.5 5.8c2.6-.9 5.3-.9 8 .7 2.7-1.6 5.4-1.6 8-.7v12.8c-2.6-.9-5.3-.9-8 .7-2.7-1.6-5.4-1.6-8-.7V5.8z" />
      <path d="M11.5 6.5v12.8" />
      <path d="M18.7 3.4 13.1 9" />
      <path d="m13.1 9-1.5 1.5 1.5 1.5 1.5-1.5z" />
      <path d="m12.3 11.3-1.2 1.2" />
    </svg>
  );
}
