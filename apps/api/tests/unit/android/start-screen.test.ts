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

function withManifestXml<T>(xml: string, check: (document: XmlDocument) => T): T {
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

function withManifest<T>(check: (document: XmlDocument) => T): T {
  return withManifestXml(readFileSync(MANIFEST_PATH, "utf8"), check);
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
    // CX-163 App-Updates: Installation der eigenen, signaturgeprueften Updates.
    "android.permission.REQUEST_INSTALL_PACKAGES",
  ];
  const KIOSK_RECEIVER = "gtads.device.kiosk.KioskAdminReceiver";
  // CX-163 App-Updates: Installationsergebnis und MY_PACKAGE_REPLACED - nur intern (exported=false).
  const INTERNAL_RECEIVERS = [
    "gtads.device.update.AppUpdateInstallReceiver",
    "gtads.device.update.AppUpdatedReceiver",
  ];
  const ALLOWED_RECEIVERS = ["gtads.device.boot.BootReceiver", KIOSK_RECEIVER, ...INTERNAL_RECEIVERS];
  // CX-150: Receiver, die nur mit genau dieser android:permission am selben Element erlaubt sind.
  const REQUIRED_RECEIVER_PERMISSION: Record<string, string> = {
    [KIOSK_RECEIVER]: "android.permission.BIND_DEVICE_ADMIN",
  };

  // Gemeinsame Receiver-Pruefung fuer das Originalmanifest und die synthetischen Negativfaelle.
  // Liefert die Befunde je Receiver; leer bedeutet zulaessig.
  function receiverProblems(document: XmlDocument): string[] {
    const elements = Array.from(document.documentElement.getElementsByTagNameNS("*", "*"));
    const problems: string[] = [];
    for (const receiver of elements.filter((element) => element.localName === "receiver")) {
      const name = androidName(receiver);
      if (name === null || !ALLOWED_RECEIVERS.includes(name)) {
        problems.push(`nicht erlaubter Receiver: ${name}`);
        continue;
      }
      if (receiver.getAttributeNS(ANDROID_NS, "directBootAware") === "true") {
        problems.push(`${name}: directBootAware`);
      }
      if (INTERNAL_RECEIVERS.includes(name) && receiver.getAttributeNS(ANDROID_NS, "exported") !== "false") {
        problems.push(`${name}: muss android:exported="false" sein`);
      }
      const required = REQUIRED_RECEIVER_PERMISSION[name];
      if (required !== undefined) {
        const actual = receiver.getAttributeNS(ANDROID_NS, "permission");
        if (actual !== required) problems.push(`${name}: android:permission ${actual} statt ${required}`);
      }
    }
    return problems;
  }

  it("verbietet Klartext, nicht freigegebene Berechtigungen und weitere Komponenten", () => {
    withManifest((document) => {
      const applications = Array.from(document.getElementsByTagNameNS("*", "application"));
      expect(applications).toHaveLength(1);
      expect(applications[0].getAttributeNS(ANDROID_NS, "usesCleartextTraffic")).toBe("false");

      const elements = Array.from(document.documentElement.getElementsByTagNameNS("*", "*"));
      for (const component of ["activity-alias", "service", "provider"]) {
        expect(elements.filter((element) => element.localName === component)).toEqual([]);
      }
      expect(receiverProblems(document)).toEqual([]);

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

  // CX-150: synthetische Manifeste im Speicher; das echte Android-Manifest bleibt unveraendert.
  const synthetic = (applicationBody: string): string => `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="${ANDROID_NS}" package="gtads.device">
    <application android:usesCleartextTraffic="false">
${applicationBody}
    </application>
</manifest>`;
  const bootReceiver = `        <receiver android:name="gtads.device.boot.BootReceiver" android:exported="true" />`;
  const kioskReceiver = (attributes: string) =>
    `        <receiver android:name="${KIOSK_RECEIVER}" android:exported="true" ${attributes}>
            <meta-data android:name="android.app.device_admin" android:resource="@xml/gtads_device_admin" />
        </receiver>`;
  const problemsOf = (xml: string) => withManifestXml(xml, receiverProblems);

  it("CX-150: erlaubt den Kiosk-Receiver mit BIND_DEVICE_ADMIN und bleibt ohne ihn gueltig", () => {
    expect(problemsOf(synthetic(bootReceiver))).toEqual([]);
    expect(
      problemsOf(synthetic(`${bootReceiver}\n${kioskReceiver('android:permission="android.permission.BIND_DEVICE_ADMIN"')}`)),
    ).toEqual([]);
  });

  it("CX-150: lehnt den Kiosk-Receiver ohne oder mit falscher Berechtigung ab", () => {
    expect(problemsOf(synthetic(kioskReceiver("")))).toEqual([
      `${KIOSK_RECEIVER}: android:permission null statt android.permission.BIND_DEVICE_ADMIN`,
    ]);
    expect(problemsOf(synthetic(kioskReceiver('android:permission="android.permission.BIND_JOB_SERVICE"')))).toEqual([
      `${KIOSK_RECEIVER}: android:permission android.permission.BIND_JOB_SERVICE statt android.permission.BIND_DEVICE_ADMIN`,
    ]);
  });

  it("CX-150: die Berechtigung zaehlt nur am selben Receiver-Element, nicht als Textfund im Manifest", () => {
    const elsewhere = synthetic(
      `        <receiver android:name="gtads.device.boot.BootReceiver" android:exported="true" android:permission="android.permission.BIND_DEVICE_ADMIN" />
${kioskReceiver("")}
        <meta-data android:name="android.permission.BIND_DEVICE_ADMIN" android:value="android.permission.BIND_DEVICE_ADMIN" />`,
    );
    expect(elsewhere).toContain("android.permission.BIND_DEVICE_ADMIN");
    expect(problemsOf(elsewhere)).toEqual([
      `${KIOSK_RECEIVER}: android:permission null statt android.permission.BIND_DEVICE_ADMIN`,
    ]);
  });

  it("CX-150: andere Receiver bleiben verboten, auch mit BIND_DEVICE_ADMIN", () => {
    const foreign = synthetic(
      `        <receiver android:name="gtads.device.kiosk.OtherAdminReceiver" android:permission="android.permission.BIND_DEVICE_ADMIN" />`,
    );
    expect(problemsOf(foreign)).toEqual(["nicht erlaubter Receiver: gtads.device.kiosk.OtherAdminReceiver"]);
    expect(
      problemsOf(synthetic(`        <receiver android:name="${KIOSK_RECEIVER}" android:permission="android.permission.BIND_DEVICE_ADMIN" android:directBootAware="true" />`)),
    ).toEqual([`${KIOSK_RECEIVER}: directBootAware`]);
  });
});
