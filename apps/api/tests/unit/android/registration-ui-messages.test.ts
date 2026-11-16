import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error jsdom liefert keine eigenen Typdeklarationen
import { JSDOM } from "jsdom";

/**
 * Synthetische Server-Fehlerfixtures. Sie beschreiben nur Kategorien und
 * Rohwerte; keine dieser Rohwerte darf als UI-Textvorlage dienen.
 */
interface ServerErrorFixture {
  name: string;
  status: number;
  errorCode: string;
  category: "invalid_input" | "code_rejected" | "rate_limited" | "network_error" | "unknown";
}

const FIXTURES: ServerErrorFixture[] = [
  {
    name: "unbekannter Registrierungscode",
    status: 400,
    errorCode: "invalid_registration_code",
    category: "code_rejected",
  },
  {
    name: "bereits gebundener Schluessel",
    status: 409,
    errorCode: "key_already_registered",
    category: "code_rejected",
  },
  {
    name: "zu viele Versuche",
    status: 429,
    errorCode: "rate_limited",
    category: "rate_limited",
  },
  {
    name: "Verbindung unterbrochen",
    status: 0,
    errorCode: "network_unreachable",
    category: "network_error",
  },
  {
    name: "formal ungueltige Anfrage",
    status: 400,
    errorCode: "invalid_request",
    category: "invalid_input",
  },
  {
    name: "unerwartete Serverantwort",
    status: 502,
    errorCode: "unexpected_response",
    category: "unknown",
  },
];

/** Synthetische Geheimniswerte, die nie in einer Meldungsvorlage stehen duerfen. */
const SYNTHETIC_SECRETS = [
  "SYN-ABCD-EFGH-JKMN",
  "Bearer SYN-ACCESS-TOKEN",
  "SYN-PRIVATE-KEY-MATERIAL",
];

const STRINGS_PATH = fileURLToPath(
  new URL(
    "../../../../../apps/android/app/src/main/res/values/strings.xml",
    import.meta.url,
  ),
);
const MAIN_ACTIVITY_PATH = fileURLToPath(
  new URL(
    "../../../../../apps/android/app/src/main/java/gtads/device/MainActivity.kt",
    import.meta.url,
  ),
);
const PROCESS_PATH = fileURLToPath(
  new URL(
    "../../../../../apps/android/app/src/main/java/gtads/device/RegistrationProcess.kt",
    import.meta.url,
  ),
);

interface XmlElement {
  localName: string;
  textContent: string | null;
  getAttribute(name: string): string | null;
  getElementsByTagName(name: string): ArrayLike<XmlElement>;
}

interface XmlDocument {
  documentElement: XmlElement;
  getElementsByTagName(name: string): ArrayLike<XmlElement>;
}

function readMessages(): Map<string, string> {
  const xml = readFileSync(STRINGS_PATH, "utf8");
  const dom = new JSDOM(xml, { contentType: "text/xml" });
  try {
    const document = dom.window.document as unknown as XmlDocument;
    if (document.getElementsByTagName("parsererror").length > 0) {
      throw new Error("strings.xml ist kein gueltiges XML");
    }
    const messages = new Map<string, string>();
    const nodes = Array.from(document.getElementsByTagName("string"));
    for (const node of nodes) {
      const name = node.getAttribute("name");
      if (name !== null) {
        messages.set(name, (node.textContent ?? "").trim());
      }
    }
    return messages;
  } finally {
    dom.window.close();
  }
}

describe("CX-072 Android-Meldungsressource gegen synthetische Serverfehler", () => {
  it("deckt jede Fehlerkategorie mit fester Meldung ab und uebernimmt keine Rohwerte oder Geheimnisse", () => {
    const messages = readMessages();
    const source = [
      readFileSync(MAIN_ACTIVITY_PATH, "utf8"),
      readFileSync(PROCESS_PATH, "utf8"),
    ].join("\n");

    // Jede synthetische Fehlerkategorie hat eine reale, nicht leere Anzeigemeldung,
    // die von der Anwendung ueber R.string tatsaechlich referenziert wird.
    for (const fixture of FIXTURES) {
      const resourceName = "registration_message_" + fixture.category;
      const message = messages.get(resourceName);
      expect(message, resourceName + " fehlt in strings.xml").toBeTruthy();
      expect((message ?? "").length, resourceName).toBeGreaterThan(0);
      expect(source, resourceName + " wird nicht verwendet").toContain("R.string." + resourceName);
      expect(message ?? "").not.toContain(fixture.errorCode);
      expect(message ?? "").not.toContain(String(fixture.status));
    }

    // Rohfehlercodes und Geheimniswerte sind keine UI-Textvorlagen.
    const allText = Array.from(messages.values()).join("\n");
    for (const fixture of FIXTURES) {
      expect(allText, fixture.name).not.toContain(fixture.errorCode);
      expect(source, fixture.name).not.toContain('"' + fixture.errorCode + '"');
    }
    for (const secret of SYNTHETIC_SECRETS) {
      expect(allText, secret).not.toContain(secret);
    }

    // Keine Formatplatzhalter, die spaeter Rohwerte einsetzen koennten.
    for (const [name, value] of messages) {
      expect(value, name).not.toMatch(/%[0-9]*\$?[sd]/);
    }
    expect(allText).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}/);
  });
});

