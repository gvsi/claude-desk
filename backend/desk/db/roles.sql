-- The three process roles, created without login and only if missing, so a rerun changes
-- nothing (it never resets a password or login that `make db-roles` set). Migration 0001_core
-- runs this as desk_admin before granting anything. Roles are cluster-wide, so a downgrade
-- keeps them.
--   desk_kernel   the kernel process: reads and writes kernel.*
--   desk_api      the API process: reads and writes app.* and procrastinate.*, may only SELECT kernel_ro.*
--   desk_mockpay  the mock payments server: reads and writes mockpay.*
DO $$
DECLARE
    role_name text;
BEGIN
    FOREACH role_name IN ARRAY ARRAY['desk_kernel', 'desk_api', 'desk_mockpay'] LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
            BEGIN
                EXECUTE format('CREATE ROLE %I NOLOGIN', role_name);
            EXCEPTION WHEN duplicate_object THEN
                NULL;   -- created concurrently by another migration run
            END;
        END IF;
    END LOOP;
END
$$;
