// "Latest answer wins" for overlapping async lookups: a map refresh fires on every move, and an
// older IPC answer that arrives after a newer one must not overwrite it.

/**
 * Returns `begin`: call it when a request starts; the function it returns tells, when the answer
 * arrives, whether this request is still the latest one.
 */
export function sequence(): () => () => boolean {
  let latest = 0;
  return () => {
    const mine = ++latest;
    return () => mine === latest;
  };
}
