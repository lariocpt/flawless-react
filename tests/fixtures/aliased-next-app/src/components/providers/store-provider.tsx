// @ts-nocheck — see layout.tsx; "@/…" and zustand resolve through the fixture.
"use client";

import { createContext, useContext, useRef, type ReactNode } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { createStore } from "zustand/vanilla";

export interface Toast {
  id: number;
  text: string;
}

export interface AppState {
  toasts: Toast[];
  pushToast: (text: string) => void;
}

export function createAppStore() {
  return createStore<AppState>()((set) => ({
    toasts: [],
    pushToast: (text) =>
      set((s) => ({ toasts: [...s.toasts, { id: s.toasts.length + 1, text }] })),
  }));
}

type AppStore = ReturnType<typeof createAppStore>;

const StoreContext = createContext<AppStore | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const storeRef = useRef<AppStore | null>(null);
  if (!storeRef.current) storeRef.current = createAppStore();
  return <StoreContext.Provider value={storeRef.current}>{children}</StoreContext.Provider>;
}

/** The synchronous store hook the defect needs: a Promise here changes the bug. */
export function useAppStore<T>(selector: (s: AppState) => T): T {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useAppStore must be used within StoreProvider");
  return useStore(store, selector);
}

export function useAppStoreShallow<T>(selector: (s: AppState) => T): T {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useAppStoreShallow must be used within StoreProvider");
  return useStore(store, useShallow(selector));
}
