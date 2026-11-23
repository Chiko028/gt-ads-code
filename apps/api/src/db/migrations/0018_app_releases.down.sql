-- CX-168: Rueckweg zu 0018_app_releases.

drop table if exists app_release_device_reports;
alter table devices drop constraint if exists devices_update_channel_enum;
alter table devices drop column if exists update_channel;
drop table if exists app_releases;
