// @ts-nocheck — see layout.tsx; "@/…" resolves through the fixture's tsconfig.
"use client";

import { useAppStore } from "@/components/providers/store-provider";

export const useToasts = () => useAppStore((s) => s.toasts);
