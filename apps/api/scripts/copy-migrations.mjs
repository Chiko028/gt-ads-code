import { cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const apiDirectory = join(scriptDirectory, "..");

cpSync(
  join(apiDirectory, "src", "db", "migrations"),
  join(apiDirectory, "dist", "db", "migrations"),
  { recursive: true },
);
