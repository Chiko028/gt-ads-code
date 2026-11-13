import { useEffect, useMemo, useState } from "react";

import { matchHash } from "./routes";
import type { RouteMatch } from "./routes";

/**
 * Liest das aktuelle Navigationsziel aus dem Hash und folgt nativen
 * Hashwechseln. Der Browser loest bei Zurueck/Vorwaerts sowohl popstate als
 * auch hashchange aus; beide Ereignisse werden deshalb beobachtet. Es gibt
 * keinen Router und keine eigene History.
 */
export function useHashRoute(): RouteMatch {
  const [hash, setHash] = useState(() => window.location.hash);

  useEffect(() => {
    const sync = () => {
      setHash(window.location.hash);
    };
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
    // Ein Hashwechsel zwischen Initialisierung und Effekt wird nachgeholt.
    sync();
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("popstate", sync);
    };
  }, []);

  return useMemo(() => matchHash(hash), [hash]);
}
