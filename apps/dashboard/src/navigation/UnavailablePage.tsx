export interface UnavailablePageProps {
  readonly title: string;
}

/**
 * Platzhalter fuer noch nicht implementierte Seiten. Bewusst ohne Daten,
 * ohne Schreibaktionen und ohne Erfolgsanzeige.
 */
export function UnavailablePage({ title }: UnavailablePageProps) {
  return (
    <section aria-labelledby="page-heading" data-page-state="unavailable">
      <h2 id="page-heading">{title}</h2>
      <p>Noch nicht verfügbar</p>
    </section>
  );
}
