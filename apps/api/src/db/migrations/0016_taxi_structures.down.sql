-- CX-131 / R-001: Rueckweg zu 0016_taxi_structures.
-- Umgekehrte Reihenfolge wegen der Fremdschluesselabhaengigkeit.

drop table if exists device_taxi_assignments;
drop table if exists taxis;
