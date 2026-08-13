// No "use server" prologue: an ordinary helper module that must stay real.
export function slugify(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "-");
}
