\set ON_ERROR_STOP on
\getenv requests_password REQUESTS_PASSWORD
\getenv assets_password ASSETS_PASSWORD

CREATE ROLE requests_user LOGIN PASSWORD :'requests_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE assets_user LOGIN PASSWORD :'assets_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;

CREATE DATABASE requests_db OWNER lab_admin;
CREATE DATABASE assets_db OWNER lab_admin;
REVOKE ALL ON DATABASE requests_db FROM PUBLIC;
REVOKE ALL ON DATABASE assets_db FROM PUBLIC;
-- CAP's PostgreSQL adapter uses temporary parameter buffers for INSERTs.
GRANT CONNECT, TEMPORARY ON DATABASE requests_db TO requests_user;
GRANT CONNECT, TEMPORARY ON DATABASE assets_db TO assets_user;

\connect requests_db
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA requests AUTHORIZATION requests_user;
ALTER ROLE requests_user IN DATABASE requests_db SET search_path TO requests;

\connect assets_db
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA assets AUTHORIZATION assets_user;
ALTER ROLE assets_user IN DATABASE assets_db SET search_path TO assets;
