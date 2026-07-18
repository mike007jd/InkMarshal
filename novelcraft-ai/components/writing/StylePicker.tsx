'use client';

import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { StyleReferenceEntry } from '@/lib/types/knowledge';
import { useLanguage } from '@/components/LanguageProvider';

interface StylePickerProps {
  novelId: string;
  selectedStyleId: string | null;
  onSelect: (styleId: string | null) => void;
}

const NO_STYLE_VALUE = '__no_style__';

export function StylePicker({ novelId, selectedStyleId, onSelect }: StylePickerProps) {
  const [styles, setStyles] = useState<StyleReferenceEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const { t } = useLanguage();

  // Fetch style references
  useEffect(() => {
    let cancelled = false;

    async function fetchStyles() {
      setLoading(true);
      try {
        const res = await fetch(`/api/novels/${novelId}/knowledge?type=style_reference`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) {
          setStyles(data as StyleReferenceEntry[]);
        }
      } catch {
        // silently fail
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchStyles();
    return () => { cancelled = true; };
  }, [novelId]);

  const selectedStyle = styles.find(s => s.id === selectedStyleId);
  const selectedValue = selectedStyleId ?? NO_STYLE_VALUE;

  return (
    <div data-testid="style-picker">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="unstyled"
            className="flex items-center gap-2 border-book-border bg-book-bg-card px-3 py-2 text-sm text-book-ink-secondary transition-colors hover:bg-book-bg-secondary"
          >
            <span className="max-w-[160px] truncate">
              {selectedStyle ? selectedStyle.title : t.stylePickerNoStyle}
            </span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0" />
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuGroup>
            <DropdownMenuRadioGroup
              value={selectedValue}
              onValueChange={(value) => onSelect(value === NO_STYLE_VALUE ? null : value)}
            >
              <DropdownMenuRadioItem value={NO_STYLE_VALUE}>
                {t.stylePickerNoStyle}
              </DropdownMenuRadioItem>

              {styles.map(style => (
                <DropdownMenuRadioItem
                  key={style.id}
                  value={style.id}
                  className="items-start py-2.5"
                >
                  <div>
                    <div className="font-medium">{style.title}</div>
                    {style.data.source && (
                      <div className="mt-0.5 text-xs text-book-ink-muted">{style.data.source}</div>
                    )}
                  </div>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>

            {loading && (
              <DropdownMenuItem disabled className="py-3 text-xs text-book-ink-muted">
                {t.loading}...
              </DropdownMenuItem>
            )}

            {!loading && styles.length === 0 && (
              <DropdownMenuItem disabled className="py-3 text-xs text-book-ink-muted">
                {t.stylePickerEmpty}
              </DropdownMenuItem>
            )}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
