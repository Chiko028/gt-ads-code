-- CX-028: Rueckweg fuer dev/test (Reihenfolge wegen Fremdschluesseln).
drop table if exists technical_alarm_outbox;
drop table if exists technical_alarm_episodes;
drop table if exists technical_alarm_resource_state;
