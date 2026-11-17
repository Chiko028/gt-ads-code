import type { ReactNode } from "react";

import { useOptionalAdminSession } from "../admin/AdminShell";
import { DevicesPanel } from "../devices/DevicesPanel";
import { UsersPanel } from "../users/UsersPanel";
import { PageErrorBoundary } from "./PageErrorBoundary";
import { DASHBOARD_ROUTES } from "./routes";
import type { RouteMatch } from "./routes";
import { TaxiPageSlot } from "./TaxiPageSlot";
import { UnavailablePage } from "./UnavailablePage";
import { useHashRoute } from "./useHashRoute";

export interface NavigationFrameProps {
  /**
   * Austauschbarer Seitenplatz fuer #/taxis (CX-037). Ohne Angabe wird der
   * klar gekennzeichnete Platzhalter gerendert.
   */
  readonly taxiPage?: ReactNode;
  /**
   * Austauschbarer Seitenplatz fuer #/medien (CX-039). Ohne Angabe wird der
   * klar gekennzeichnete Platzhalter gerendert.
   */
  readonly mediaPage?: ReactNode;
  /**
   * Austauschbarer Seitenplatz fuer #/kampagnen (CX-040). Ohne Angabe wird
   * der klar gekennzeichnete Platzhalter gerendert.
   */
  readonly campaignPage?: ReactNode;
  /**
   * Austauschbarer Seitenplatz fuer #/ausspielung (CX-044). Ohne Angabe
   * wird der klar gekennzeichnete Platzhalter gerendert.
   */
  readonly previewPage?: ReactNode;
  /**
   * Austauschbarer Seitenplatz fuer #/statistik (CX-050). Ohne Angabe wird
   * der klar gekennzeichnete Platzhalter gerendert.
   */
  readonly statisticPage?: ReactNode;
  /**
   * Austauschbarer Seitenplatz fuer #/betrieb (CX-062). Ohne Angabe wird
   * der klar gekennzeichnete Platzhalter gerendert; in der App wird die
   * lesende Betriebsseite eingebunden.
   */
  readonly operationsPage?: ReactNode;
}

function NotFoundPage() {
  return (
    <section aria-labelledby="page-heading" data-page-state="not-found">
      <h2 id="page-heading">Seite nicht gefunden</h2>
      <p>Die aufgerufene Adresse ist nicht bekannt.</p>
      <p>
        <a href="#/geraete">Zu den Geräten</a>
      </p>
    </section>
  );
}

function pageFor(
  match: RouteMatch,
  taxiPage: ReactNode | undefined,
  mediaPage: ReactNode | undefined,
  campaignPage: ReactNode | undefined,
  previewPage: ReactNode | undefined,
  statisticPage: ReactNode | undefined,
  operationsPage: ReactNode | undefined,
) {
  if (match.kind === "not_found") {
    return <NotFoundPage />;
  }
  switch (match.route.id) {
    case "geraete":
      return <DevicesPanel />;
    case "taxis":
      return taxiPage === undefined ? <TaxiPageSlot /> : taxiPage;
    case "medien":
      return mediaPage === undefined ? (
        <UnavailablePage title="Medien" />
      ) : (
        mediaPage
      );
    case "kampagnen":
      return campaignPage === undefined ? (
        <UnavailablePage title="Kampagnen" />
      ) : (
        campaignPage
      );
    case "ausspielung":
      return previewPage === undefined ? (
        <UnavailablePage title="Ausspielung" />
      ) : (
        previewPage
      );
    case "statistik":
      return statisticPage === undefined ? (
        <UnavailablePage title="Statistik" />
      ) : (
        statisticPage
      );
    case "betrieb":
      return operationsPage === undefined ? (
        <UnavailablePage title="Betrieb" />
      ) : (
        operationsPage
      );
    case "benutzer":
      return <UsersPanel />;
    default:
      return <UnavailablePage title={match.route.label} />;
  }
}

/**
 * Kleiner Dashboard-Rahmen oberhalb der geschuetzten Inhalte. Die Navigation
 * besteht aus nativen Hashlinks; der aktive Eintrag ist per aria-current
 * markiert. Der Rahmen liegt im main-Bereich der AdminShell und bringt je
 * Seite eine sichtbare Ueberschrift mit.
 *
 * Der Eintrag Betrieb ist eine reine Admin-Ansicht und wird fuer Operatoren
 * ausgeblendet; ein direkter Hashaufruf bleibt trotzdem durch die
 * serverseitige Berechtigung und die Seitenpruefung gesperrt.
 */
export function NavigationFrame({
  taxiPage,
  mediaPage,
  campaignPage,
  previewPage,
  statisticPage,
  operationsPage,
}: NavigationFrameProps = {}) {
  const match = useHashRoute();
  const session = useOptionalAdminSession();
  const showOperations = session === null || session.role === "Admin";
  const visibleRoutes = DASHBOARD_ROUTES.filter(
    (route) => route.id !== "betrieb" || showOperations,
  );
  const activeRouteId = match.kind === "route" ? match.route.id : null;

  return (
    <>
      <nav aria-label="Hauptnavigation">
        <ul>
          {visibleRoutes.map((route) => {
            const active = route.id === activeRouteId;
            return (
              <li key={route.id}>
                <a
                  href={route.hash}
                  aria-current={active ? "page" : undefined}
                >
                  {route.label}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
      {/* CX-144: Der vorhandene CX-064-Fehlerschutz umschliesst jede Route
          (auch Geraete, Benutzer und Nicht-gefunden) und wird beim
          Routenwechsel ueber resetKey zurueckgesetzt. */}
      <PageErrorBoundary resetKey={activeRouteId ?? "not_found"}>
        {pageFor(
          match,
          taxiPage,
          mediaPage,
          campaignPage,
          previewPage,
          statisticPage,
          operationsPage,
        )}
      </PageErrorBoundary>
    </>
  );
}
