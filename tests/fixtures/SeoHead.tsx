import { useEffect } from "react";

/**
 * An effect-only component declared as a FUNCTION with an acronym name. The
 * SCREAMING_CASE guard exists for value constants; a function declaration is
 * not one, so SEO/GTM-style head managers must stay detected.
 */
export function SEO({ title }: { title: string }) {
  useEffect(() => {
    document.title = title;
  }, [title]);
  return null;
}
