-- CX-030 / R-201: lokaler Medienspeicher mit geprueften Metadaten.
-- Additiv: keine Deduplizierung, kein Loeschweg, keine HTTP-Route.
-- Der Dateischluessel ist eine serverseitige UUID; der Anzeigename ist nur
-- eine begrenzte Bezeichnung und wird nie als Pfad verwendet.
-- Staging-Zeilen sind unsichtbar. Metadaten werden erst nach dem Lesen der
-- Bytes und der CX-003-Pruefung ergaenzt; Status ready ist nur mit
-- vollstaendigen Metadaten und ready_at zulaessig.

create table media_objects (
  id uuid primary key,
  display_name text not null check (
    char_length(display_name) >= 1 and char_length(display_name) <= 255
  ),
  size_bytes bigint null check (
    size_bytes is null or (size_bytes >= 1 and size_bytes <= 20000000)
  ),
  sha256 text null check (
    sha256 is null or sha256 ~ '^[0-9a-f]{64}$'
  ),
  container text null check (container is null or container <> ''),
  video_codec text null check (video_codec is null or video_codec <> ''),
  width integer null check (width is null or width > 0),
  height integer null check (height is null or height > 0),
  frame_rate_numerator integer null check (
    frame_rate_numerator is null or frame_rate_numerator > 0
  ),
  frame_rate_denominator integer null check (
    frame_rate_denominator is null or frame_rate_denominator > 0
  ),
  audio_stream_count integer null check (
    audio_stream_count is null or audio_stream_count >= 0
  ),
  duration_seconds double precision null check (
    duration_seconds is null or duration_seconds > 0
  ),
  created_at timestamptz not null,
  status text not null check (status in ('staging', 'ready')),
  ready_at timestamptz null,
  constraint media_objects_ready_consistent check (
    (status = 'staging' and ready_at is null) or
    (status = 'ready' and ready_at is not null)
  ),
  constraint media_objects_ready_metadata check (
    status = 'staging' or (
      size_bytes is not null and
      sha256 is not null and
      container is not null and
      video_codec is not null and
      width is not null and
      height is not null and
      frame_rate_numerator is not null and
      frame_rate_denominator is not null and
      audio_stream_count is not null and
      duration_seconds is not null
    )
  )
);

-- Stabile Keyset-Paginierung nach Erstellzeit und ID fuer die begrenzte Liste.
create index media_objects_ready_list_idx
  on media_objects (created_at asc, id asc)
  where status = 'ready';

-- Der Wiederanlauf findet ausschliesslich eigene staging-Zeilen.
create index media_objects_staging_idx
  on media_objects (created_at asc, id asc)
  where status = 'staging';
