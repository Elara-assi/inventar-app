import { existsSync, readFileSync } from "node:fs";

const required = [
  "docker-compose.yml",
  "db/migrations/001_init.sql",
  "db/seeds/001_seed.sql",
  "scripts/db-reset.py",
  "scripts/db-bootstrap.ps1",
  "AGENTS.md",
  "docs/ROOM_TEST_V01.md",
  "apps/api/app/main.py",
  "apps/web/app/page.tsx",
  "storage/uploads/originals/.gitkeep",
  "storage/uploads/stamped/.gitkeep",
  "storage/uploads/audio/.gitkeep",
  "storage/uploads/exports/.gitkeep",
  "storage/uploads/temp/.gitkeep"
];

for (const path of required) {
  if (!existsSync(path)) {
    console.error(`Missing ${path}`);
    process.exit(1);
  }
}

const migration = readFileSync("db/migrations/001_init.sql", "utf8");
for (const table of ["inventory_items", "item_photos", "ai_results", "audit_log", "accounting_tasks"]) {
  if (!migration.includes(`CREATE TABLE ${table}`)) {
    console.error(`Migration missing ${table}`);
    process.exit(1);
  }
}

console.log("Smoke check passed: structure, migrations, seeds and upload folders are present.");
