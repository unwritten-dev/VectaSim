import { useEffect, useState } from "react";

/** `value`, but only after it stayed unchanged for `ms` (e.g. a live-region text while typing). */
export function useDebouncedValue<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return settled;
}
