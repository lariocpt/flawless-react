/** Opaque to the analyser on purpose — see UndecidableRender.tsx. */
export function useFeatureFlag(): boolean {
  return Math.random() > 0.5;
}
