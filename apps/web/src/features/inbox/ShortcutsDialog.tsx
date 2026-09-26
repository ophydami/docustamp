import { useTranslation } from "react-i18next";
import { Dialog, Kbd } from "@/components/ui";

/** The key glyph is never translated, only the sentence describing what it does. */
const SHORTCUTS: Array<[key: string, descriptionKey: string]> = [
  ["J", "inbox.shortcuts.moveDown"],
  ["K", "inbox.shortcuts.moveUp"],
  ["X", "inbox.shortcuts.toggleRow"],
  ["↵", "inbox.shortcuts.openDocument"],
  ["R", "inbox.shortcuts.remind"],
  ["N", "inbox.shortcuts.newRequest"],
  ["S", "inbox.shortcuts.signYourself"],
  ["⌘K", "inbox.shortcuts.commandPalette"],
  ["?", "inbox.shortcuts.thisList"]
];

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onClose={onClose} title={t("inbox.shortcuts.title")} width={420}>
      <ul className="flex flex-col gap-2">
        {SHORTCUTS.map(([key, descriptionKey]) => (
          <li key={key} className="flex items-center justify-between text-[13px]">
            <span className="text-ink-2">{t(descriptionKey)}</span>
            <Kbd>{key}</Kbd>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
