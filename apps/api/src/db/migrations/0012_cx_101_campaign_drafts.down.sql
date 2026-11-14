-- CX-101: Rueckweg fuer dev/test. Nur die additive Kampagnentabelle
-- wird entfernt; Kunden, Medien, Betreiber- und Auditdaten bleiben bestehen.
drop table if exists campaigns cascade;
