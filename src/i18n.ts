export type Locale = "en" | "zh";

let localeOverride: Locale | null = null;

export function setLocale(locale: Locale): void {
  localeOverride = locale;
}

export function getLocale(): Locale {
  return localeOverride ?? localeFromEnv();
}

export function localeFromEnv(env: NodeJS.ProcessEnv = process.env): Locale {
  const explicit = env.CFOCUS_LANG?.trim().toLowerCase();
  if (explicit === "en" || explicit === "english") return "en";
  if (explicit != null && explicit.startsWith("zh")) return "zh";
  const lang = (env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG ?? "").toLowerCase();
  if (lang.startsWith("zh")) return "zh";
  return "en";
}

export function text(en: string, zh: string, locale?: Locale): string {
  return (locale ?? getLocale()) === "zh" ? zh : en;
}

export function listJoin(items: string[], locale?: Locale): string {
  return items.join(text(", ", "、", locale));
}
