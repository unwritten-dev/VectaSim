// Sequence guard for async loads that can overlap (several `logbook:changed` in a row, a
// setting toggled while a load runs): only the answer to the latest request is applied.
//
//   const [latest] = useState(latestOnly);  // one guard per component
//   const isLatest = latest();            // when the request starts
//   const data = await invoke(...);
//   if (!isLatest()) return;              // a newer request was started meanwhile

/** Returns a starter; each call begins a request and returns "is this still the latest one?". */
export function latestOnly(): () => () => boolean {
  let seq = 0;
  return () => {
    const mine = ++seq;
    return () => mine === seq;
  };
}
