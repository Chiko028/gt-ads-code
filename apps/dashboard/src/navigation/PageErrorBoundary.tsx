import { Component } from "react";
import type { ReactNode } from "react";

const PAGE_RENDER_ERROR_MESSAGE =
  "Der Seiteninhalt konnte nicht angezeigt werden. Bitte eine andere Seite öffnen.";

export interface PageErrorBoundaryProps {
  /** Bestehende Routenkennung; ihr Wechsel setzt den Fehlerzustand zurueck. */
  readonly resetKey: string;
  readonly children?: ReactNode;
}

interface PageErrorBoundaryState {
  readonly failed: boolean;
  readonly resetKey: string;
}

/**
 * Kleiner produktiver Fehlerschutz unmittelbar um den bereits autorisierten
 * Seiteninhalt. Navigation, Sitzungspruefung und Abmelden bleiben ausserhalb.
 * Der feste deutsche Hinweis enthaelt weder Fehlertext noch Stack noch
 * Requestdaten. Der Fehlerzustand wird ausschliesslich beim Wechsel der
 * bestehenden Seitenkennung zurueckgesetzt; es gibt weder Timer noch
 * automatische Wiederholung.
 */
export class PageErrorBoundary extends Component<
  PageErrorBoundaryProps,
  PageErrorBoundaryState
> {
  constructor(props: PageErrorBoundaryProps) {
    super(props);
    this.state = { failed: false, resetKey: props.resetKey };
  }

  static getDerivedStateFromError(): Partial<PageErrorBoundaryState> {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: PageErrorBoundaryProps,
    state: PageErrorBoundaryState,
  ): Partial<PageErrorBoundaryState> | null {
    if (props.resetKey === state.resetKey) {
      return null;
    }
    return { failed: false, resetKey: props.resetKey };
  }

  render() {
    if (this.state.failed) {
      return (
        <section role="alert">
          <h2>Seiteninhalt nicht verfügbar</h2>
          <p>{PAGE_RENDER_ERROR_MESSAGE}</p>
        </section>
      );
    }
    return this.props.children;
  }
}

