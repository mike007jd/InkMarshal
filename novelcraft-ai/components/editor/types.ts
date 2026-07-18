// Shared editor value types. Kept framework-agnostic (no React/Lexical
// imports) so both the Lexical editor and its plugins can depend on it.

/** A character-offset span into a chapter's plain text, used for selection
 *  highlighting and AI-edit targeting. */
export interface HighlightRange {
  start: number;
  end: number;
}
