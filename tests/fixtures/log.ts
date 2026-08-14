export const logger = {
  error: (o: unknown): void => void o,
  warn: (o: unknown): void => void o,
};

export function useSessionUser(): { name: string } | undefined {
  return undefined;
}
