'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { AlignJustify, Database, Globe, Palette, RefreshCw, X } from 'lucide-react';
import { useLanguage } from '@/components/LanguageProvider';
import { LOCALES, LOCALE_NAMES } from '@/lib/i18n';
import { applySettingsToDocument, getSettings, saveSettings, type AppSettings } from '@/lib/settings';
import { useTheme } from '@/components/ThemeProvider';
import { VaultSettings } from '@/components/VaultSettings';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { BackupSettings } from '@/components/BackupSettings';
import { ModelDownloadSourceSettings } from '@/components/ModelDownloadSourceSettings';
import { Checkbox } from '@/components/ui/checkbox';
import { Spinner } from '@/components/ui/spinner';
import { onAppSettingsHydrated } from '@/lib/app-settings-client';
import {
  DESKTOP_UPDATE_CHECK_RESULT_EVENT,
  type DesktopUpdateCheckResult,
  isAutomaticUpdateCheckEnabled,
  requestManualDesktopUpdateCheck,
  setAutomaticUpdateCheckEnabled,
} from '@/lib/desktop-update-preferences';

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
}

const OPEN_SETTINGS_EVENT = 'inkmarshal:open-settings';

type SettingsSection = 'general' | 'writing' | 'vault';

function normalizeSettingsSection(value: unknown): SettingsSection {
  return value === 'writing' || value === 'vault'
    ? value
    : 'general';
}

function isTheme(value: string): value is AppSettings['theme'] {
  return value === 'light' || value === 'dark' || value === 'system';
}

function isFontSize(value: string): value is AppSettings['fontSize'] {
  return value === 'sm' || value === 'md' || value === 'lg';
}

function isLineSpacing(value: string): value is AppSettings['lineSpacing'] {
  return value === 'compact' || value === 'normal' || value === 'relaxed';
}

export function SettingsPanel({ open, onClose }: SettingsPanelProps) {
  const [eventOpen, setEventOpen] = useState(false);
  const [requestedSection, setRequestedSection] =
    useState<SettingsSection | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = normalizeSettingsSection((e as CustomEvent<unknown>).detail);
      setRequestedSection(detail);
      setEventOpen(true);
    };
    window.addEventListener(OPEN_SETTINGS_EVENT, handler);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, handler);
  }, []);

  const isOpen = open || eventOpen;

  const handleClose = () => {
    setEventOpen(false);
    setRequestedSection(null);
    onClose();
  };

  return (
    <SettingsPanelDrawer
      open={isOpen}
      onClose={handleClose}
      initialSection={requestedSection}
    />
  );
}

function SettingsPanelDrawer({
  open,
  onClose,
  initialSection,
}: {
  open: boolean;
  onClose: () => void;
  initialSection: SettingsSection | null;
}) {
  const { locale, setLocale, t } = useLanguage();
  const { theme, setTheme } = useTheme();
  const params = useParams();
  const activeNovelId = typeof params?.id === 'string' ? params.id : null;
  const hasNovelContext = activeNovelId !== null;

  const [settings, setSettings] = useState<AppSettings>(() => getSettings());
  const [automaticUpdateCheck, setAutomaticUpdateCheck] = useState(
    () => isAutomaticUpdateCheckEnabled(),
  );
  const [updateCheckResult, setUpdateCheckResult] = useState<DesktopUpdateCheckResult | null>(null);
  const [activeSection, setActiveSection] = useState<SettingsSection>(
    initialSection === 'vault' && (!hasNovelContext || !getSettings().developerTools)
      ? 'general'
      : initialSection ?? 'general',
  );

  const updateSetting = <K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K],
  ) => {
    const next = saveSettings({ [key]: value });
    setSettings(next);
    applySettingsToDocument(next, locale);
    window.dispatchEvent(new Event('inkmarshal:settings-changed'));
  };

  useEffect(() => {
    if (initialSection) {
      const nextSection = initialSection === 'vault' && (!hasNovelContext || !settings.developerTools)
        ? 'general'
        : initialSection;
      const id = window.setTimeout(() => setActiveSection(nextSection), 0);
      return () => window.clearTimeout(id);
    }
  }, [hasNovelContext, initialSection, settings.developerTools]);

  useEffect(() => {
    if ((hasNovelContext && settings.developerTools) || activeSection !== 'vault') return;
    const id = window.setTimeout(() => setActiveSection('general'), 0);
    return () => window.clearTimeout(id);
  }, [activeSection, hasNovelContext, settings.developerTools]);

  useEffect(() => {
    const unsubscribeHydration = onAppSettingsHydrated(() => {
      setAutomaticUpdateCheck(isAutomaticUpdateCheckEnabled());
    });
    const handleResult = (event: Event) => {
      setUpdateCheckResult((event as CustomEvent<DesktopUpdateCheckResult>).detail);
    };
    window.addEventListener(DESKTOP_UPDATE_CHECK_RESULT_EVENT, handleResult);
    return () => {
      unsubscribeHydration();
      window.removeEventListener(DESKTOP_UPDATE_CHECK_RESULT_EVENT, handleResult);
    };
  }, []);

  const updateCheckStatus = updateCheckResult === 'checking'
    ? t.updateChecking
    : updateCheckResult === 'up-to-date'
      ? t.updateUpToDate
      : updateCheckResult === 'update-available'
        ? t.updateAvailableTitle
        : updateCheckResult === 'failed'
          ? t.updateCheckFailed
          : null;

  const sectionTabs: {
    id: SettingsSection;
    label: string;
    Icon: typeof Globe;
  }[] = [
    {
      id: 'general',
      label: t.settingsTabGeneral,
      Icon: Globe,
    },
    {
      id: 'writing',
      label: t.settingsTabWriting,
      Icon: AlignJustify,
    },
    ...(hasNovelContext && settings.developerTools ? [{
      id: 'vault' as const,
      label: t.settingsTabVault,
      Icon: Database,
    }] : []),
  ];

  const segmentedItemClass =
    'w-full data-[state=on]:border-book-gold data-[state=on]:bg-book-bg-secondary data-[state=on]:text-book-ink-primary data-[state=on]:shadow-sm';

  return (
    <Sheet
      open={open}
      onOpenChange={nextOpen => {
        if (!nextOpen) onClose();
      }}
    >
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-full gap-0 overflow-hidden border-book-border bg-book-bg-primary p-0 text-book-ink-primary sm:w-[34rem] sm:max-w-none lg:w-[38rem]"
      >
        <SheetHeader className="flex-row items-center justify-between gap-4 border-b border-book-border px-5 py-4 text-left">
          <div className="min-w-0">
            <SheetTitle className="text-xl font-semibold text-book-ink-primary">
              {t.settingsTitle}
            </SheetTitle>
            <SheetDescription className="sr-only">
              {t.settingsTitle}
            </SheetDescription>
          </div>
          <SheetClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t.searchClose}
            >
              <X data-icon="inline-start" />
            </Button>
          </SheetClose>
        </SheetHeader>

        <Tabs
          value={activeSection}
          onValueChange={v => setActiveSection(normalizeSettingsSection(v))}
          orientation="vertical"
          className="grid min-h-0 flex-1 grid-cols-[10.5rem_1px_minmax(0,1fr)] sm:grid-cols-[12rem_1px_minmax(0,1fr)]"
        >
          <TabsList className="flex h-full w-full flex-col items-stretch justify-start gap-1 border-b-0 p-3">
            {sectionTabs.map(({ id, label, Icon }) => (
              <TabsTrigger
                key={id}
                value={id}
                className="h-auto w-full justify-start gap-2 rounded-md border-b-0 px-3 py-2 text-left text-sm data-[state=active]:border-b-transparent data-[state=active]:bg-book-bg-secondary data-[state=active]:text-book-ink-primary"
              >
                <Icon className="size-4" aria-hidden />
                <span className="truncate">{label}</span>
              </TabsTrigger>
            ))}
          </TabsList>
          <Separator orientation="vertical" className="h-full bg-book-border" />

          <ScrollArea className="h-full min-h-0 overflow-x-hidden">
            <div className="min-w-0 p-4 sm:p-5">
              <TabsContent value="general" className="m-0 flex flex-col gap-6">
                <section className="flex flex-col gap-3">
                  <div className="flex items-center gap-2">
                    <Globe className="size-4 text-book-ink-muted" />
                    <h3 className="text-sm font-semibold text-book-ink-secondary">
                      {t.settingsLanguage}
                    </h3>
                  </div>
                  <Select
                    value={locale}
                    onValueChange={v => setLocale(v as (typeof LOCALES)[number])}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LOCALES.map(loc => (
                        <SelectItem key={loc} value={loc}>
                          {LOCALE_NAMES[loc]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </section>

                <section className="flex flex-col gap-3">
                  <div className="flex items-center gap-2">
                    <Palette className="size-4 text-book-ink-muted" />
                    <h3 className="text-sm font-semibold text-book-ink-secondary">
                      {t.settingsTheme}
                    </h3>
                  </div>
                  <ToggleGroup
                    type="single"
                    value={theme}
                    onValueChange={value => {
                      if (!isTheme(value)) return;
                      setTheme(value);
                      updateSetting('theme', value);
                    }}
                    variant="outline"
                    size="sm"
                    className="grid w-full grid-cols-3"
                  >
                    {(
                      [
                        { value: 'light' as const, label: t.themeLight },
                        { value: 'dark' as const, label: t.themeDark },
                        { value: 'system' as const, label: t.themeSystem },
                      ]
                    ).map(({ value, label }) => (
                      <ToggleGroupItem
                        key={value}
                        value={value}
                        aria-label={label}
                        className={segmentedItemClass}
                      >
                        {label}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </section>

                <section className="flex flex-col gap-3 border-t border-book-border pt-5">
                  <div className="flex items-start justify-between gap-4">
                    <label htmlFor="automatic-update-check" className="min-w-0 cursor-pointer">
                      <span className="block text-sm font-semibold text-book-ink-secondary">
                        {t.automaticUpdateCheckTitle}
                      </span>
                      <span className="mt-1 block text-sm leading-relaxed text-book-ink-muted">
                        {t.automaticUpdateCheckDescription}
                      </span>
                    </label>
                    <Checkbox
                      id="automatic-update-check"
                      checked={automaticUpdateCheck}
                      onCheckedChange={checked => {
                        const enabled = checked === true;
                        setAutomaticUpdateCheckEnabled(enabled);
                        setAutomaticUpdateCheck(enabled);
                      }}
                      aria-label={t.automaticUpdateCheckTitle}
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={updateCheckResult === 'checking'}
                      onClick={() => requestManualDesktopUpdateCheck()}
                    >
                      {updateCheckResult === 'checking' ? <Spinner size="sm" /> : <RefreshCw />}
                      {t.updateCheckNow}
                    </Button>
                    {updateCheckStatus ? (
                      <p
                        className={updateCheckResult === 'failed' ? 'text-xs text-book-danger' : 'text-xs text-book-ink-muted'}
                        role="status"
                      >
                        {updateCheckStatus}
                      </p>
                    ) : null}
                  </div>
                </section>

                <BackupSettings novelId={activeNovelId} />

                <ModelDownloadSourceSettings />

                <section className="flex flex-col gap-3 border-t border-book-border pt-5">
                  <div>
                    <h3 className="text-sm font-semibold text-book-ink-secondary">
                      {t.developerToolsTitle}
                    </h3>
                    <p className="mt-1 text-sm leading-relaxed text-book-ink-secondary">
                      {t.developerToolsDescription}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => updateSetting('developerTools', !settings.developerTools)}
                    className="self-start"
                  >
                    {settings.developerTools ? t.developerToolsDisable : t.developerToolsEnable}
                  </Button>
                </section>
              </TabsContent>

              <TabsContent value="writing" className="m-0">
                <section className="flex flex-col gap-5">
                  <div className="flex items-center gap-2">
                    <AlignJustify className="size-4 text-book-ink-muted" />
                    <h3 className="text-sm font-semibold text-book-ink-secondary">
                      {t.settingsWritingPrefs}
                    </h3>
                  </div>

                  <div className="flex flex-col gap-2">
                    <label className="text-xs text-book-ink-muted">
                      {t.fontSize}
                    </label>
                    <ToggleGroup
                      type="single"
                      value={settings.fontSize}
                      onValueChange={value => {
                        if (isFontSize(value)) updateSetting('fontSize', value);
                      }}
                      variant="outline"
                      size="sm"
                      className="grid w-full grid-cols-3"
                    >
                      {(
                        [
                          { value: 'sm' as const, label: t.fontSmall },
                          { value: 'md' as const, label: t.fontMedium },
                          { value: 'lg' as const, label: t.fontLarge },
                        ]
                      ).map(({ value, label }) => (
                        <ToggleGroupItem
                          key={value}
                          value={value}
                          aria-label={label}
                          className={segmentedItemClass}
                        >
                          {label}
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                  </div>

                  <div className="flex flex-col gap-2">
                    <label className="text-xs text-book-ink-muted">
                      {t.lineSpacing}
                    </label>
                    <ToggleGroup
                      type="single"
                      value={settings.lineSpacing}
                      onValueChange={value => {
                        if (isLineSpacing(value)) {
                          updateSetting('lineSpacing', value);
                        }
                      }}
                      variant="outline"
                      size="sm"
                      className="grid w-full grid-cols-3"
                    >
                      {(
                        [
                          { value: 'compact' as const, label: t.spacingCompact },
                          { value: 'normal' as const, label: t.spacingNormal },
                          { value: 'relaxed' as const, label: t.spacingRelaxed },
                        ]
                      ).map(({ value, label }) => (
                        <ToggleGroupItem
                          key={value}
                          value={value}
                          aria-label={label}
                          className={segmentedItemClass}
                        >
                          {label}
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                  </div>
                </section>
              </TabsContent>

              {activeNovelId && settings.developerTools && (
                <TabsContent value="vault" className="m-0">
                  <VaultSettings novelId={activeNovelId} />
                </TabsContent>
              )}
            </div>
          </ScrollArea>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
