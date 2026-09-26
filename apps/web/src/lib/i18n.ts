import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector, { type CustomDetector } from "i18next-browser-languagedetector";
import type { BackendModule, ReadCallback, Resource, Services } from "i18next";
import { setDateLocale } from "./format";

/** The shipped languages, labelled in their own language for the pickers. */
export const LANGUAGES = [
  { code: "en", name: "English" },
  { code: "de", name: "Deutsch" },
  { code: "es", name: "Español" },
  { code: "fr", name: "Français" },
  { code: "hi", name: "हिन्दी" },
  { code: "it", name: "Italiano" },
  { code: "ko", name: "한국어" }
] as const;

export type Lang = (typeof LANGUAGES)[number]["code"];

export const LANG_CODES = LANGUAGES.map((l) => l.code) as readonly Lang[];
export const DEFAULT_LANG: Lang = "en";

/** Where the explicit choice lives, and the mirror of the account's Language. */
const STORAGE_KEY = "lang";
const PROFILE_KEY = "lang:profile";

/**
 * Normalises anything the browser, the URL or the server hands us onto a
 * shipped code: "en-GB" -> "en", "kr" -> "ko" (the classic OpenSign UI stored
 * Korean as "kr"), unknown -> undefined.
 */
export function normalizeLang(raw: string | null | undefined): Lang | undefined {
  if (!raw) return undefined;
  const lower = raw.toLowerCase().replace(/_/g, "-");
  const base = lower.split("-")[0];
  if (base === "kr") return "ko";
  return (LANG_CODES as readonly string[]).includes(base) ? (base as Lang) : undefined;
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    // Private mode or blocked storage: fall through to the next detector.
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Nothing to do: the choice still applies for this session.
  }
}

/** 1. The language the user picked explicitly, in Settings or a footer picker. */
const savedSetting: CustomDetector = {
  name: "savedSetting",
  lookup: () => normalizeLang(read(STORAGE_KEY))
};

/**
 * 2. `contracts_Users.Language` for the signed-in account. The row is only
 * fetched after boot, so `rememberProfileLanguage` mirrors it into storage and
 * this detector reads the mirror on the next load.
 */
const userProfile: CustomDetector = {
  name: "userProfile",
  lookup: () => normalizeLang(read(PROFILE_KEY))
};

/** Vite splits every locale into its own chunk, so only the active one ships. */
const loaders = import.meta.glob<{ default: Resource }>("../locales/*.json");

const lazyBackend: BackendModule = {
  type: "backend",
  init: (_services: Services, _backendOptions: unknown, _i18nextOptions: unknown) => {
    // Nothing to set up: the loaders are static imports resolved by Vite.
  },
  read: (language: string, _namespace: string, callback: ReadCallback) => {
    const load = loaders[`../locales/${language}.json`];
    if (!load) {
      callback(new Error(`No locale bundle for "${language}"`), false);
      return;
    }
    load()
      .then((mod) => callback(null, mod.default))
      .catch((err: unknown) => callback(err instanceof Error ? err : new Error(String(err)), false));
  }
};

/** Stamps a shipped code on <html>, so "en-GB" and "kr" both land on en / ko. */
function applyHtmlLang(raw: string) {
  document.documentElement.setAttribute("lang", normalizeLang(raw) ?? DEFAULT_LANG);
}

/**
 * Boots i18next with the lazy backend and the detection chain
 * (saved setting, account language, browser, English). Resolves once the first
 * language bundle has loaded, so `main.tsx` can render translated on the first
 * paint; later switches load their chunk under a `<Suspense>` fallback.
 */
export async function initI18n() {
  const detector = new LanguageDetector();
  detector.addDetector(savedSetting);
  detector.addDetector(userProfile);

  await i18next
    .use(lazyBackend)
    .use(detector)
    .use(initReactI18next)
    .init({
      fallbackLng: DEFAULT_LANG,
      supportedLngs: LANG_CODES as unknown as string[],
      nonExplicitSupportedLngs: true,
      load: "languageOnly",
      ns: ["translation"],
      defaultNS: "translation",
      detection: {
        order: ["savedSetting", "userProfile", "navigator"],
        // Writes go through `setLanguage` so the profile mirror stays separate.
        caches: []
      },
      interpolation: { escapeValue: false },
      returnNull: false
    });

  await setDateLocale(currentLang());
  applyHtmlLang(currentLang());

  i18next.on("languageChanged", (lng) => {
    applyHtmlLang(lng);
    void setDateLocale(lng);
  });

  return i18next;
}

/** The active language, always one of the shipped codes. */
export function currentLang(): Lang {
  return normalizeLang(i18next.resolvedLanguage ?? i18next.language) ?? DEFAULT_LANG;
}

/** Switches the UI and remembers the choice on this device. */
export async function setLanguage(raw: string) {
  const lang = normalizeLang(raw) ?? DEFAULT_LANG;
  write(STORAGE_KEY, lang);
  if (lang !== currentLang()) await i18next.changeLanguage(lang);
}

/**
 * Called with `contracts_Users.Language` once the profile loads. It mirrors the
 * value for the next boot and switches now when the user has not made an
 * explicit choice on this device.
 */
export function rememberProfileLanguage(raw: string | null | undefined) {
  const lang = normalizeLang(raw);
  if (!lang) return;
  write(PROFILE_KEY, lang);
  if (normalizeLang(read(STORAGE_KEY))) return;
  if (lang !== currentLang()) void i18next.changeLanguage(lang);
}

export { i18next };
