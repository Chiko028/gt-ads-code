import type { ReactNode } from "react";

import { DevicesPanel } from "../devices/DevicesPanel";
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
    default:
      return <UnavailablePage title={match.route.label} />;
  }
}

/**
 * Kleiner Dashboard-Rahmen oberhalb der geschuetzten Inhalte. Die Navigation
 * besteht aus nativen Hashlinks; der aktive Eintrag ist per aria-current
 * markiert. Der Rahmen liegt im main-Bereich der AdminShell und bringt je
 * Seite eine sichtbare Ueberschrift mit.
 */
export function NavigationFrame({
  taxiPage,
  mediaPage,
  campaignPage,
}: NavigationFrameProps = {}) {
  const match = useHashRoute();
  const activeRouteId = match.kind === "route" ? match.route.id : null;

  return (
    <>
      <nav aria-label="Hauptnavigation">
        <ul>
          {DASHBOARD_ROUTES.map((route) => {
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
      {pageFor(match, taxiPage, mediaPage, campaignPage)}
    </>
  );
}
