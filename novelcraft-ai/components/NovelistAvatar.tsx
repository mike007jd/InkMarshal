// components/NovelistAvatar.tsx
//
// Intentional fixed-palette illustration. The hex fills below are the mascot's
// own art colors (skin, hair, glasses, scarf, ink pen) — a self-contained
// drawing, not surface chrome. They are deliberately NOT mapped to the --book-*
// design tokens: those tokens describe page/ink/parchment surfaces, and forcing
// the drawing onto them would flatten the illustration rather than theme it. So
// this file is an accepted exception to the semantic-token rule, in the same
// spirit as app/opengraph-image.tsx. Counted in the design-system-contract
// hexColor baseline; do not "fix" these into tokens.
export function NovelistAvatar({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
      {/* Background circle */}
      <circle cx="32" cy="32" r="32" fill="#f4f2ec" />
      {/* Face */}
      <circle cx="32" cy="26" r="12" fill="#f5e6d3" />
      {/* Hair */}
      <path d="M20 22c0-8 5-14 12-14s12 6 12 14c0 0-3-8-12-8s-12 8-12 8z" fill="#5c4a3a" />
      {/* Glasses */}
      <circle cx="28" cy="26" r="4" stroke="#8b7355" strokeWidth="1.5" fill="none" />
      <circle cx="36" cy="26" r="4" stroke="#8b7355" strokeWidth="1.5" fill="none" />
      <path d="M32 26h0" stroke="#8b7355" strokeWidth="1.5" />
      <line x1="24" y1="26" x2="20" y2="25" stroke="#8b7355" strokeWidth="1.5" />
      <line x1="40" y1="26" x2="44" y2="25" stroke="#8b7355" strokeWidth="1.5" />
      {/* Smile */}
      <path d="M29 30c1.5 2 3.5 2 6 0" stroke="#8b7355" strokeWidth="1" strokeLinecap="round" fill="none" />
      {/* Scarf */}
      <path d="M22 38c2-3 6-5 10-5s8 2 10 5" fill="#c4956a" />
      <path d="M26 38c0 4-2 8-4 12h2c2-3 3-7 4-10" fill="#b5845a" />
      {/* Body */}
      <path d="M18 50c3-8 8-12 14-12s11 4 14 12" fill="#e8dcc8" />
      {/* Pen in hand */}
      <line x1="42" y1="44" x2="48" y2="36" stroke="#a17d48" strokeWidth="2" strokeLinecap="round" />
      <circle cx="48.5" cy="35.5" r="1" fill="#a17d48" />
    </svg>
  );
}
