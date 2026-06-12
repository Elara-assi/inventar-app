// Testet den TypeScript-Parser gegen die gemeinsamen Faelle (vorher mit tsc
// nach /tmp transpiliert; siehe npm-Script test:dictation).
import { readFileSync } from "node:fs";
import { parseDictation } from "/tmp/dictation-build/dictation.js";

const BRANDS = ["Nussbaum", "MAHA", "Hofmann", "Dell", "HP", "Lenovo", "Samsung",
  "Michelin", "Continental", "Hazet", "Gedore", "Brother"];
const cases = JSON.parse(readFileSync(new URL("../apps/api/tests/dictation_cases.json", import.meta.url), "utf8"));
const failures = [];
for (const c of cases) {
  const got = parseDictation(c.text, BRANDS);
  for (const [key, expected] of Object.entries(c.expect)) {
    if (key === "note_contains") {
      if (!String(got.note ?? "").toLowerCase().includes(String(expected).toLowerCase())) {
        failures.push(`${c.text}: note=${got.note} fehlt ${expected}`);
      }
    } else if (got[key] !== expected) {
      failures.push(`${c.text}: ${key}=${JSON.stringify(got[key])}, erwartet ${JSON.stringify(expected)}`);
    }
  }
}
if (failures.length) { console.error(failures.join("\n")); process.exit(1); }
console.log(`Alle ${cases.length} Diktat-Testfaelle bestanden (TypeScript).`);
