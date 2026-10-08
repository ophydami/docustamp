import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type JSX,
  type ReactNode,
  type SelectHTMLAttributes
} from "react";
import { useTranslation } from "react-i18next";
import {
  Bold,
  FileOutput,
  Italic,
  List,
  ListOrdered,
  Minus,
  PenLine,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignStart,
  Underline,
  type LucideIcon
} from "lucide-react";
import { Input } from "@/components/ui";
import { cn } from "@/lib/cn";
import { contentToHtml, escapeHtml, htmlToContent, PAGE_BREAK_SELECTOR, parsePastedHtml } from "./dom";
import { isPageSize, SIGNING_BLOCK_LINES, TITLE_MAX_CHARS, type Align, type Content, type PageSize } from "./model";
import "./composer.css";

/**
 * The writing editor: a title, a formatting toolbar and a sheet of white
 * paper that is a contenteditable. Formatting goes through the browser's own
 * editing commands (so undo, the native ⌘B/I/U and the IME all keep working)
 * and every edit is walked back into the content model for the parent.
 */

export interface ComposerProps {
  title: string;
  onTitle: (title: string) => void;
  value: Content;
  onChange: (content: Content) => void;
  autoFocus?: "title" | "body";
  disabled?: boolean;
  /** Slot at the right end of the toolbar. */
  toolbarRight?: ReactNode;
  className?: string;
}

type BlockStyle = "p" | "h1" | "h2" | "h3";

interface ToolState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  ul: boolean;
  ol: boolean;
  align: Align;
  block: BlockStyle;
}

const IDLE: ToolState = { bold: false, italic: false, underline: false, ul: false, ol: false, align: "left", block: "p" };

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
const MOD = MAC ? "⌘" : "Ctrl+";

/** What "- ", "1. ", "## " and friends turn an otherwise empty paragraph into. */
const SHORTCUTS: Record<string, "ul" | "ol" | "h1" | "h2" | "h3"> = {
  "-": "ul",
  "*": "ul",
  "1.": "ol",
  "#": "h1",
  "##": "h2",
  "###": "h3"
};

const BLOCK_TAGS = new Set(["P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "BLOCKQUOTE", "PRE"]);

/* Same chevron as the ui Select; that one is 34px tall and the toolbar runs at 28px. */
const CHEVRON =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 16 16' fill='none' stroke='%2371717B' stroke-width='1.6'%3E%3Cpath d='M4 6l4 4 4-4'/%3E%3C/svg%3E\")";

function queryState(command: string): boolean {
  // Firefox throws for commands it does not know; treat that as "off".
  try {
    return document.queryCommandState(command);
  } catch {
    return false;
  }
}

/** The nearest block element around a node, inside the sheet. */
function blockOf(node: Node | null, root: HTMLElement): HTMLElement | null {
  let el: Node | null = node;
  while (el && el !== root) {
    if (el.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has((el as HTMLElement).tagName)) return el as HTMLElement;
    el = el.parentNode;
  }
  return null;
}

/** The sheet's direct child that holds a node. */
function topBlockOf(node: Node | null, root: HTMLElement): HTMLElement | null {
  let el: Node | null = node;
  while (el && el.parentNode !== root) el = el.parentNode;
  return el && el.nodeType === Node.ELEMENT_NODE ? (el as HTMLElement) : null;
}

function selectionIn(root: HTMLElement): Range | null {
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  return root.contains(range.commonAncestorContainer) ? range : null;
}

function setCaret(node: Node, offset: number): void {
  const sel = document.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function placeCaret(root: HTMLElement, where: "start" | "end"): void {
  const sel = document.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(where === "start");
  sel.removeAllRanges();
  sel.addRange(range);
}

function emptyParagraph(): HTMLParagraphElement {
  const p = document.createElement("p");
  p.innerHTML = "<br>";
  return p;
}

/** Keeps the sheet somewhere to type: a paragraph when it is empty, and one after a trailing rule or page break. */
function ensureEditable(root: HTMLElement): void {
  if (!root.firstChild) {
    root.append(emptyParagraph());
    return;
  }
  const last = root.lastElementChild;
  if (last && (last.tagName === "HR" || last.matches(PAGE_BREAK_SELECTOR))) root.append(emptyParagraph());
}

/**
 * Chrome leaves a list it just made inside the paragraph (or heading) the
 * caret was in. Lift it out, keeping the caret where it was.
 */
function unwrapLists(root: HTMLElement): void {
  const wrapped = root.querySelectorAll(":scope > :is(p, div, h1, h2, h3, h4, h5, h6) > :is(ul, ol)");
  if (!wrapped.length) return;
  const sel = document.getSelection();
  const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  const start = range ? { node: range.startContainer, offset: range.startOffset } : null;
  const end = range ? { node: range.endContainer, offset: range.endOffset } : null;
  for (const list of Array.from(wrapped)) {
    const wrapper = list.parentElement;
    if (wrapper) wrapper.replaceWith(...Array.from(wrapper.childNodes));
  }
  // Moving a node collapses any live range inside it, so put the caret back by hand.
  if (sel && start && end && root.contains(start.node) && root.contains(end.node)) {
    const restored = document.createRange();
    restored.setStart(start.node, start.offset);
    restored.setEnd(end.node, end.offset);
    sel.removeAllRanges();
    sel.addRange(restored);
  }
}

function alignOfBlock(block: HTMLElement | null): Align {
  if (!block) return "left";
  const value = getComputedStyle(block).textAlign;
  if (value === "center" || value === "-webkit-center") return "center";
  if (value === "right" || value === "end" || value === "-webkit-right") return "right";
  return "left";
}

function readTool(root: HTMLElement): ToolState {
  const block = blockOf(document.getSelection()?.anchorNode ?? null, root);
  const tag = block?.tagName.toLowerCase();
  return {
    bold: queryState("bold"),
    italic: queryState("italic"),
    underline: queryState("underline"),
    ul: queryState("insertUnorderedList"),
    ol: queryState("insertOrderedList"),
    align: alignOfBlock(block),
    block: tag === "h1" || tag === "h2" || tag === "h3" ? tag : "p"
  };
}

function sameTool(a: ToolState, b: ToolState): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.ul === b.ul &&
    a.ol === b.ol &&
    a.align === b.align &&
    a.block === b.block
  );
}

/** Nothing but one empty line: the time to show the placeholder. */
function isBlank(content: Content): boolean {
  const [first] = content.blocks;
  return content.blocks.length === 0 || (content.blocks.length === 1 && first.type === "paragraph" && first.runs.length === 0);
}

function ToolButton({
  icon: Icon,
  label,
  keys,
  active,
  disabled,
  onClick,
  children
}: {
  icon: LucideIcon;
  label: string;
  keys?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      title={keys ? `${label} (${keys})` : label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      // Keeps the caret and the selection in the sheet while the button is clicked.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 min-w-7 items-center justify-center gap-1.5 rounded-md border px-1 text-[12px] font-medium transition-colors",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        active
          ? "bg-surface-3 text-ink border-line-strong"
          : "bg-transparent text-ink-2 border-transparent hover:bg-surface-3 hover:text-ink"
      )}
    >
      <Icon className="size-4 shrink-0" strokeWidth={1.6} />
      {children ? <span className="pr-1 max-sm:hidden">{children}</span> : null}
    </button>
  );
}

function ToolSelect({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "h-7 rounded-md border border-line bg-surface pl-2 pr-6 text-[12px] text-ink appearance-none bg-no-repeat",
        "hover:border-line-strong focus:outline-none focus:border-muted-2 focus:shadow-[var(--shadow-focus)]",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        className
      )}
      style={{ backgroundImage: CHEVRON, backgroundPosition: "right 7px center" }}
      {...rest}
    />
  );
}

function Sep() {
  return <span aria-hidden className="mx-0.5 h-4 w-px bg-line" />;
}

export function Composer({
  title,
  onTitle,
  value,
  onChange,
  autoFocus,
  disabled,
  toolbarRight,
  className
}: ComposerProps): JSX.Element {
  const { t } = useTranslation();
  const sheetRef = useRef<HTMLDivElement>(null);
  /** JSON of the last content this editor emitted; `value` is only written to the DOM when it differs. */
  const lastEmitted = useRef("");
  /** Where the caret was last seen in the sheet, for commands fired from a control that took focus. */
  const savedRange = useRef<Range | null>(null);
  /** Set while a toolbar command runs, so the `input` event it fires does not serialise a second time. */
  const inCommand = useRef(false);
  const [tool, setTool] = useState<ToolState>(IDLE);
  const [blank, setBlank] = useState(() => isBlank(value));
  const pageBreakLabel = t("compose.pageBreak");

  useLayoutEffect(() => {
    const root = sheetRef.current;
    if (!root) return;
    const json = JSON.stringify(value);
    if (json === lastEmitted.current) return;
    lastEmitted.current = json;
    root.innerHTML = contentToHtml(value, { pageBreakLabel });
    ensureEditable(root);
    setBlank(isBlank(value));
  }, [value, pageBreakLabel]);

  useEffect(() => {
    // Enter makes a <p>, not a <div>, so headings and lists end cleanly.
    try {
      document.execCommand("defaultParagraphSeparator", false, "p");
    } catch {
      // Not supported: the walker reads divs as paragraphs anyway.
    }
    if (autoFocus === "body" && sheetRef.current) {
      sheetRef.current.focus();
      placeCaret(sheetRef.current, "end");
    }
    // Mount only: the paragraph separator is document-wide and autoFocus is a first-render choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The toolbar follows the caret.
  useEffect(() => {
    const onSelection = () => {
      const root = sheetRef.current;
      if (!root) return;
      const range = selectionIn(root);
      if (!range) {
        setTool((s) => (sameTool(s, IDLE) ? s : IDLE));
        return;
      }
      savedRange.current = range.cloneRange();
      const next = readTool(root);
      setTool((s) => (sameTool(s, next) ? s : next));
    };
    document.addEventListener("selectionchange", onSelection);
    return () => document.removeEventListener("selectionchange", onSelection);
  }, []);

  /** Walks the sheet into the model and hands it up. Only ever called from event handlers. */
  function emit(pageSize: PageSize = value.pageSize): void {
    const root = sheetRef.current;
    if (!root) return;
    ensureEditable(root);
    const content = htmlToContent(root, pageSize);
    lastEmitted.current = JSON.stringify(content);
    setBlank(isBlank(content));
    onChange(content);
  }

  /** Focuses the sheet and brings the selection back into it if a control took it. */
  function focusSheet(): HTMLDivElement | null {
    const root = sheetRef.current;
    if (!root) return null;
    if (selectionIn(root)) {
      if (document.activeElement !== root) root.focus();
      return root;
    }
    root.focus();
    const sel = document.getSelection();
    const saved = savedRange.current;
    if (sel && saved && root.contains(saved.startContainer) && root.contains(saved.endContainer)) {
      sel.removeAllRanges();
      sel.addRange(saved);
    } else {
      placeCaret(root, "end");
    }
    return root;
  }

  /** Runs an editing command against the sheet, then serialises once and refreshes the toolbar. */
  function run(command: (root: HTMLDivElement) => void): void {
    if (disabled) return;
    const root = focusSheet();
    if (!root) return;
    inCommand.current = true;
    try {
      command(root);
    } finally {
      inCommand.current = false;
    }
    unwrapLists(root);
    emit();
    const next = readTool(root);
    setTool((s) => (sameTool(s, next) ? s : next));
  }

  function command(name: string, arg?: string): void {
    run(() => {
      document.execCommand(name, false, arg);
    });
  }

  /**
   * Inserts block markup. Into an empty line it goes as is; otherwise it goes
   * below the current block (a list item included), because the browser would
   * merge the first inserted line into the text around the caret.
   */
  function insertBlocks(html: string): void {
    run((root) => {
      const block = topBlockOf(document.getSelection()?.anchorNode ?? null, root);
      if (block && (block.textContent ?? "").trim() !== "") {
        const line = emptyParagraph();
        block.after(line);
        setCaret(line, 0);
      }
      document.execCommand("insertHTML", false, html);
    });
  }

  function insertDivider(): void {
    insertBlocks("<hr><p><br></p>");
  }

  function insertPageBreak(): void {
    insertBlocks(`<div data-block="pageBreak" contenteditable="false">${escapeHtml(pageBreakLabel)}</div><p><br></p>`);
  }

  function insertSigningBlock(): void {
    insertBlocks(SIGNING_BLOCK_LINES.map((line) => `<p>${escapeHtml(line)}</p>`).join(""));
  }

  /** "- ", "1. ", "# " and so on, typed at the start of an empty paragraph. */
  function applyShortcut(): boolean {
    const root = sheetRef.current;
    const sel = document.getSelection();
    if (!root || !sel || !sel.isCollapsed || !selectionIn(root)) return false;
    const block = blockOf(sel.anchorNode, root);
    if (!block || block.parentElement !== root || (block.tagName !== "P" && block.tagName !== "DIV")) return false;
    const text = (block.textContent ?? "").replace(/ /g, " ");
    if (!text.endsWith(" ")) return false;
    const action = SHORTCUTS[text.slice(0, -1)];
    if (!action) return false;
    run(() => {
      // The marker is removed through the editor, not the DOM, so undo still works.
      const range = document.createRange();
      range.selectNodeContents(block);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand("delete");
      if (action === "ul") document.execCommand("insertUnorderedList");
      else if (action === "ol") document.execCommand("insertOrderedList");
      else document.execCommand("formatBlock", false, `<${action}>`);
    });
    return true;
  }

  function onInput(e: FormEvent<HTMLDivElement>): void {
    if (inCommand.current) return;
    const native = e.nativeEvent as InputEvent;
    if (native.inputType === "insertText" && native.data === " " && applyShortcut()) return;
    emit();
  }

  function onPaste(e: ClipboardEvent<HTMLDivElement>): void {
    if (disabled) return;
    const html = e.clipboardData.getData("text/html");
    const text = e.clipboardData.getData("text/plain");
    if (!html && !text) return;
    e.preventDefault();
    let markup: string | null = null;
    if (html) {
      // Through the model and back: fonts, colours, tables and images do not survive.
      const parsed = parsePastedHtml(html, value.pageSize);
      if (parsed.blocks.length) markup = contentToHtml(parsed, { pageBreakLabel });
    }
    if (markup === null) {
      const lines = text.replace(/\r\n?/g, "\n").split("\n");
      if (lines.length === 1) {
        run(() => {
          document.execCommand("insertText", false, text);
        });
        return;
      }
      markup = lines.map((line) => `<p>${escapeHtml(line) || "<br>"}</p>`).join("");
    }
    const insert = markup;
    run(() => {
      document.execCommand("insertHTML", false, insert);
    });
  }

  function onPageSize(size: string): void {
    if (!isPageSize(size) || disabled) return;
    emit(size);
  }

  const styleLabel = t("compose.style.label");

  return (
    <div className={cn("flex w-full min-w-0 max-w-[792px] flex-col gap-3", className)}>
      <Input
        value={title}
        maxLength={TITLE_MAX_CHARS}
        disabled={disabled}
        autoFocus={autoFocus === "title"}
        aria-label={t("compose.titleLabel")}
        placeholder={t("compose.titlePlaceholder")}
        onChange={(e) => onTitle(e.target.value)}
        onKeyDown={(e) => {
          // Enter moves on to the text, like a form would.
          if (e.key !== "Enter" || !sheetRef.current) return;
          e.preventDefault();
          sheetRef.current.focus();
          placeCaret(sheetRef.current, "start");
        }}
        className="h-[44px] px-3.5 text-[18px] font-semibold tracking-[-.01em]"
      />

      <div
        role="toolbar"
        aria-label={t("compose.toolbar.label")}
        className="sticky top-0 z-10 -mx-1 flex flex-wrap items-center gap-1 bg-ground px-1 py-1.5"
      >
        <ToolSelect
          aria-label={styleLabel}
          title={styleLabel}
          value={tool.block}
          disabled={disabled}
          onChange={(e) => command("formatBlock", `<${e.target.value}>`)}
        >
          <option value="p">{t("compose.style.paragraph")}</option>
          <option value="h1">{t("compose.style.heading1")}</option>
          <option value="h2">{t("compose.style.heading2")}</option>
          <option value="h3">{t("compose.style.heading3")}</option>
        </ToolSelect>
        <Sep />
        <ToolButton icon={Bold} label={t("compose.toolbar.bold")} keys={`${MOD}B`} active={tool.bold} disabled={disabled} onClick={() => command("bold")} />
        <ToolButton icon={Italic} label={t("compose.toolbar.italic")} keys={`${MOD}I`} active={tool.italic} disabled={disabled} onClick={() => command("italic")} />
        <ToolButton icon={Underline} label={t("compose.toolbar.underline")} keys={`${MOD}U`} active={tool.underline} disabled={disabled} onClick={() => command("underline")} />
        <Sep />
        <ToolButton icon={List} label={t("compose.toolbar.bulletList")} active={tool.ul} disabled={disabled} onClick={() => command("insertUnorderedList")} />
        <ToolButton icon={ListOrdered} label={t("compose.toolbar.numberedList")} active={tool.ol} disabled={disabled} onClick={() => command("insertOrderedList")} />
        <Sep />
        <ToolButton icon={TextAlignStart} label={t("compose.toolbar.alignLeft")} active={tool.align === "left"} disabled={disabled} onClick={() => command("justifyLeft")} />
        <ToolButton icon={TextAlignCenter} label={t("compose.toolbar.alignCenter")} active={tool.align === "center"} disabled={disabled} onClick={() => command("justifyCenter")} />
        <ToolButton icon={TextAlignEnd} label={t("compose.toolbar.alignRight")} active={tool.align === "right"} disabled={disabled} onClick={() => command("justifyRight")} />
        <Sep />
        <ToolButton icon={Minus} label={t("compose.toolbar.divider")} disabled={disabled} onClick={insertDivider} />
        <ToolButton icon={FileOutput} label={t("compose.toolbar.pageBreak")} disabled={disabled} onClick={insertPageBreak} />
        <ToolButton icon={PenLine} label={t("compose.toolbar.signingBlock")} disabled={disabled} onClick={insertSigningBlock}>
          {t("compose.toolbar.signingBlock")}
        </ToolButton>
        <span className="flex-1" />
        <ToolSelect
          aria-label={t("compose.pageSize.label")}
          title={t("compose.pageSize.label")}
          value={value.pageSize}
          disabled={disabled}
          onChange={(e) => onPageSize(e.target.value)}
        >
          <option value="letter">{t("compose.pageSize.letter")}</option>
          <option value="a4">{t("compose.pageSize.a4")}</option>
        </ToolSelect>
        {toolbarRight}
      </div>

      <div
        className={cn(
          "paper-white rounded-lg border border-line shadow-[var(--shadow-page)] px-5 py-8 sm:px-14 sm:py-14",
          "focus-within:border-line-strong",
          disabled && "opacity-70"
        )}
      >
        <div
          ref={sheetRef}
          className="composer-sheet"
          contentEditable={!disabled}
          role="textbox"
          aria-multiline="true"
          aria-label={t("compose.bodyLabel")}
          data-empty={blank ? "true" : "false"}
          data-placeholder={t("compose.bodyPlaceholder")}
          onInput={onInput}
          onPaste={onPaste}
        />
      </div>
    </div>
  );
}
