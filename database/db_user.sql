--
-- PostgreSQL database dump
--

-- Dumped from database version 12.22 (Ubuntu 12.22-0ubuntu0.20.04.4)
-- Dumped by pg_dump version 12.22 (Ubuntu 12.22-0ubuntu0.20.04.4)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: db_user; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.db_user (
    db_user_id integer DEFAULT nextval('public.master_seq'::regclass) NOT NULL,
    username character varying NOT NULL,
    password character varying,
    first_name character varying,
    last_name character varying,
    email character varying NOT NULL,
    disabled character(1) DEFAULT 'N'::bpchar NOT NULL,
    disabled_reason character varying,
    last_ip character varying,
    last_login timestamp without time zone,
    created timestamp without time zone,
    modified timestamp without time zone,
    temp_pass character(1),
    security_code character varying
);


ALTER TABLE public.db_user OWNER TO postgres;

--
-- Name: db_user db_user_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.db_user
    ADD CONSTRAINT db_user_pkey PRIMARY KEY (db_user_id);


--
-- PostgreSQL database dump complete
--

