$ErrorActionPreference = "Stop"

$psql = Get-Command psql -ErrorAction SilentlyContinue
if (-not $psql) {
  $defaultPsql = "C:\Program Files\PostgreSQL\17\bin\psql.exe"
  $defaultCreatedb = "C:\Program Files\PostgreSQL\17\bin\createdb.exe"
} else {
  $defaultPsql = $psql.Source
  $defaultCreatedb = "createdb"
}

if (-not $env:PGPASSWORD) {
  $env:PGPASSWORD = "postgres"
}

& $defaultPsql -h localhost -U postgres -d postgres -v ON_ERROR_STOP=1 -c "DO `$`$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'inventar') THEN CREATE ROLE inventar LOGIN PASSWORD 'inventar'; ELSE ALTER ROLE inventar WITH LOGIN PASSWORD 'inventar'; END IF; END `$`$;"

$exists = & $defaultPsql -h localhost -U postgres -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'inventar'"
if (-not $exists) {
  & $defaultCreatedb -h localhost -U postgres -O inventar inventar
}

Write-Host "PostgreSQL role/database ready: inventar"
