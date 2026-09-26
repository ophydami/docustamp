import { create } from "zustand";
import type { ReactNode } from "react";

/** Sidebar badge counts, set by features (e.g. inbox sets "needs you"). */
interface BadgeState {
  inbox: number;
  expiring: number;
  setBadges: (b: Partial<Pick<BadgeState, "inbox" | "expiring">>) => void;
}
export const useBadges = create<BadgeState>((set) => ({
  inbox: 0,
  expiring: 0,
  setBadges: (b) => set(b)
}));

/** Commands a feature contributes to the ⌘K palette while mounted. */
export interface Command {
  id: string;
  label: string;
  group?: string;
  kbd?: string;
  icon?: ReactNode;
  run: () => void;
}
interface CommandState {
  commands: Command[];
  register: (cmds: Command[]) => () => void;
}
export const useCommands = create<CommandState>((set) => ({
  commands: [],
  register: (cmds) => {
    set((s) => ({ commands: [...s.commands, ...cmds] }));
    return () => set((s) => ({ commands: s.commands.filter((c) => !cmds.includes(c)) }));
  }
}));

/** Command palette open state. */
interface PaletteState {
  open: boolean;
  setOpen: (v: boolean) => void;
}
export const usePalette = create<PaletteState>((set) => ({ open: false, setOpen: (open) => set({ open }) }));

/**
 * Off-canvas sidebar state. Only used below 1024px, where the sidebar is a
 * drawer instead of a permanent column.
 */
interface NavDrawerState {
  open: boolean;
  setOpen: (v: boolean) => void;
  toggle: () => void;
}
export const useNavDrawer = create<NavDrawerState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open }))
}));
