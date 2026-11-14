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

  it("verbietet Klartext, Berechtigungen und weitere Komponenten", () => {
    withManifest((document) => {
      const applications = Array.from(document.getElementsByTagNameNS("*", "application"));
      expect(applications).toHaveLength(1);
      expect(applications[0].getAttributeNS(ANDROID_NS, "usesCleartextTraffic")).toBe("false");

      const elements = Array.from(document.documentElement.getElementsByTagNameNS("*", "*"));
      const forbiddenComponents = ["activity-alias", "service", "receiver", "provider"];
      for (const component of forbiddenComponents) {
        expect(elements.filter((element) => element.localName === component)).toEqual([]);
      }
      expect(elements.filter((element) => element.localName.startsWith("uses-permission"))).toEqual(
        [],
      );
    });
  });
});
