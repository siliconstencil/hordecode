import { DialogSelect, type DialogSelectRef } from "../ui/dialog-select"
import { useLanguage, type Locale } from "../context/language"
import { useDialog } from "../ui/dialog"
import { onCleanup } from "solid-js"

const LANGUAGES: { value: Locale; label: string }[] = [
  { value: "en", label: "English" },
  { value: "zh", label: "简体中文" },
  { value: "zht", label: "繁體中文" },
  { value: "ja", label: "日本語" },
  { value: "ko", label: "한국어" },
  { value: "de", label: "Deutsch" },
  { value: "es", label: "Español" },
  { value: "fr", label: "Français" },
  { value: "ru", label: "Русский" },
  { value: "tr", label: "Türkçe" },
  { value: "br", label: "Português (Brasil)" },
  { value: "ar", label: "العربية" },
  { value: "th", label: "ไทย" },
]

export function DialogLanguageList() {
  const lang = useLanguage()
  const dialog = useDialog()
  let confirmed = false
  let ref: DialogSelectRef<Locale>
  const initial = lang.locale()

  onCleanup(() => {
    if (!confirmed) lang.setLocale(initial)
  })

  return (
    <DialogSelect
      title="Language"
      options={LANGUAGES.map((l) => ({
        title: l.label,
        value: l.value,
      }))}
      current={initial}
      onMove={(opt) => {
        lang.setLocale(opt.value)
      }}
      onSelect={(opt) => {
        lang.setLocale(opt.value)
        confirmed = true
        dialog.clear()
      }}
      ref={(r) => {
        ref = r
      }}
      onFilter={(query) => {
        if (query.length === 0) {
          lang.setLocale(initial)
          return
        }

        const first = ref.filtered[0]
        if (first) lang.setLocale(first.value)
      }}
    />
  )
}
