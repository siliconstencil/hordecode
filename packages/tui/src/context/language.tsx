import { createSignal, type Accessor } from "solid-js"
import { createSimpleContext } from "./helper"
import { useKV } from "./kv"
import { detectSystemLocale } from "../util/system-locale"
import type { Locale } from "./locales"
import { dict as en } from "../i18n/en"
import { dict as zh } from "../i18n/zh"
import { dict as zht } from "../i18n/zh-Hant"
import { dict as ja } from "../i18n/ja"
import { dict as fr } from "../i18n/fr"
import { dict as es } from "../i18n/es"
import { dict as ru } from "../i18n/ru"
import { dict as ko } from "../i18n/ko"
import { dict as de } from "../i18n/de"
import { dict as da } from "../i18n/da"
import { dict as pl } from "../i18n/pl"
import { dict as ar } from "../i18n/ar"
import { dict as no } from "../i18n/no"
import { dict as br } from "../i18n/br"
import { dict as th } from "../i18n/th"
import { dict as bs } from "../i18n/bs"
import { dict as tr } from "../i18n/tr"

export type { Locale }

const dicts: Record<Locale, Record<string, string>> = {
  en,
  zh,
  zht,
  ja,
  fr,
  es,
  ru,
  ko,
  de,
  da,
  pl,
  ar,
  no,
  br,
  th,
  bs,
  tr,
}

function interpolate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const val = params[key]
    return val !== undefined ? String(val) : `{{${key}}}`
  })
}

export type LanguageContext = {
  locale: Accessor<Locale>
  setLocale: (locale: Locale) => void
  t: (key: string, params?: Record<string, string | number>) => string
}

export const { use: useLanguage, provider: LanguageProvider } = createSimpleContext({
  name: "Language",
  init: () => {
    const kv = useKV()
    const saved = kv.get("language") as Locale | undefined
    const initial = saved ?? detectSystemLocale()
    const [locale, setLocaleRaw] = createSignal<Locale>(initial)

    const setLocale = (next: Locale) => {
      setLocaleRaw(next)
      kv.set("language", next)
    }

    const t = (key: string, params?: Record<string, string | number>): string => {
      const dict = dicts[locale()] ?? dicts.en
      const raw = dict[key] ?? en[key] ?? key
      return params ? interpolate(raw, params) : raw
    }

    return { locale, setLocale, t }
  },
})
