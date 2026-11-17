import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error jsdom liefert keine eigenen Typdeklarationen
import { JSDOM } from "jsdom";

const ANDROID_NS = "http://schemas.android.com/apk/res/android";
const MANIFEST_PATH = fileURLToPath(
  new URL("../../../../../apps/android/app/src/main/AndroidManifest.xml", import.meta.url),
);

interface XmlElement {
  localName: string;
  children: ArrayLike<XmlElement>;
  getAttributeNS(namespace: string, name: string): string | null;
  getElementsByTagNameNS(namespace: string, localName: string): ArrayLike<XmlElement>;
}

interface XmlDocument {
  documentElement: XmlElement;
  getElementsByTagNameNS(namespace: string, localName: string): ArrayLike<XmlElement>;
}

function withManifest<T>(check: (document: XmlDocument) => T): T {
  const xml = readFileSync(MANIFEST_PATH, "utf8");
  const dom = new JSDOM(xml, { contentType: "text/xml" });
  try {
    const document = dom.window.document as XmlDocument;
    if (document.getElementsByTagNameNS("*", "parsererror").length > 0) {
      throw new Error("AndroidManifest.xml ist kein gueltiges XML");
    }
    if (document.documentElement.localName !== "manifest") {
      throw new Error("AndroidManifest.xml hat kein manifest-Wurzelelement");
    }
    return check(document);
  } finally {
    dom.window.close();
  }
}

const androidName = (element: XmlElement): string | null =>
  element.getAttributeNS(ANDROID_NS, "name");

const childrenNamed = (element: XmlElement, localName: string): XmlElement[] =>
  Array.from(element.children).filter((child) => child.localName === localName);

describe("Android-Startbildschirm-Manifest", () => {
  it("deklariert genau eine exportierte Launcher-Activity", () => {
    withManifest((document) => {
      const activities = Array.from(document.getElementsByTagNameNS("*", "activity"));
      expect(activities).toHaveLength(1);
      const activity = activities[0];
      expect(androidName(activity)).toBe("gtads.device.MainActivity");
      expect(activity.getAttributeNS(ANDROID_NS, "exported")).toBe("true");

      const filters = childrenNamed(activity, "intent-filter");
      expect(filters).toHaveLength(1);
      expect(childrenNamed(filters[0], "action").map(androidName)).toEqual([
        "android.intent.action.MAIN",
      ]);
      expect(childrenNamed(filters[0], "category").map(androidName)).toEqual([
        "android.intent.category.LAUNCHER",
      ]);
    });
  });

  // 2026-11-17: Die App braucht inzwischen genau festgelegte Berechtigungen (Netz: Registrierung, Manifest,
  // Befehle, Uploads; CX-146) und den Boot-Receiver (CX-090 / R-907). Statt "keine Berechtigung" gilt eine
  // abschliessende Erlaubnisliste; Standort, Sensoren, Kamera, Mikrofon und Klartext bleiben verboten.
  const ALLOWED_PERMISSIONS = [
    "android.permission.ACCESS_NETWORK_STATE",
    "android.permission.INTERNET",
    "android.permission.POST_NOTIFICATIONS",
    "android.permission.RECEIVE_BOOT_COMPLETED",
  ];
  const ALLOWED_RECEIVERS = ["gtads.device.boot.BootReceiver"];

  it("verbietet Klartext, nicht freigegebene Berechtigungen und weitere Komponenten", () => {
    withManifest((document) => {
      const applications = Array.from(document.getElementsByTagNameNS("*", "application"));
      expect(applications).toHaveLength(1);
      expect(applications[0].getAttributeNS(ANDROID_NS, "usesCleartextTraffic")).toBe("false");

      const elements = Array.from(document.documentElement.getElementsByTagNameNS("*", "*"));
      for (const component of ["activity-alias", "service", "provider"]) {
        expect(elements.filter((element) => element.localName === component)).toEqual([]);
      }
      const receivers = elements.filter((element) => element.localName === "receiver");
      for (const receiver of receivers) {
        expect(ALLOWED_RECEIVERS).toContain(androidName(receiver));
        expect(receiver.getAttributeNS(ANDROID_NS, "directBootAware")).not.toBe("true");
      }

      const permissions = elements
        .filter((element) => element.localName.startsWith("uses-permission"))
        .map(androidName);
      for (const permission of permissions) {
        expect(ALLOWED_PERMISSIONS).toContain(permission);
      }
      for (const forbidden of [
        "android.permission.ACCESS_FINE_LOCATION",
        "android.permission.ACCESS_COARSE_LOCATION",
        "android.permission.ACCESS_BACKGROUND_LOCATION",
        "android.permission.BODY_SENSORS",
        "android.permission.CAMERA",
        "android.permission.RECORD_AUDIO",
      ]) {
        expect(permissions).not.toContain(forbidden);
      }
    });
  });
});
