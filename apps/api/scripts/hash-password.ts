#!/usr/bin/env node
import { hashPassword } from "../src/crypto/password.js";

/**
 * Erzeugt GT_ADS_ADMIN_PASSWORD_HASH fuer die lokale Umgebung.
 * Das Passwort wird nie als Argument uebergeben (Prozessliste/History) und
 * nie ausgegeben; ausgegeben wird nur der Hash.
 */

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8"));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function readHiddenLine(prompt: string): Promise<string> {
  const stdin = process.stdin;
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return new Promise((resolve, reject) => {
    let value = "";
    let done = false;

    const finish = (result: string, error?: Error): void => {
      if (done) {
        return;
      }
      done = true;
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      if (error === undefined) {
        resolve(result);
      } else {
        reject(error);
      }
    };

    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const character of text) {
        if (character === "\r" || character === "\n") {
          finish(value);
          return;
        }
        if (character === "\u0003") {
          finish("", new Error("Abgebrochen"));
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    };

    stdin.on("data", onData);
  });
}

async function main(): Promise<void> {
  const interactive = process.stdin.isTTY === true;
  const password = interactive
    ? await readHiddenLine("Admin-Passwort: ")
    : (await readAllStdin()).replace(/\r?\n$/, "");

  if (password.trim() === "") {
    process.stderr.write(
      "Kein Passwort uebergeben. Aufruf: npm run -s hash-password (interaktiv) " +
        "oder Passwort ueber stdin pipen.\n",
    );
    process.exitCode = 1;
    return;
  }

  const hash = await hashPassword(password);
  process.stdout.write(hash + "\n");
  process.stderr.write(
    "Diesen Wert als GT_ADS_ADMIN_PASSWORD_HASH in die lokale .env eintragen " +
      "(niemals committen).\n",
  );
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write("Fehler: " + message + "\n");
  process.exitCode = 1;
});
