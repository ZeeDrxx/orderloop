-- Read-only login for Power BI: the o2c_* views and the mirrored tables, nothing else, no writes.
-- psql "$DATABASE_URL" -v pw="'a-strong-password'" -f powerbi/readonly_role.sql
CREATE ROLE powerbi LOGIN PASSWORD :pw;
GRANT CONNECT ON DATABASE orderloop TO powerbi;
GRANT USAGE ON SCHEMA public TO powerbi;
GRANT SELECT ON o2c_orders, o2c_open_receivables, o2c_dso, customers, sync_runs TO powerbi;
