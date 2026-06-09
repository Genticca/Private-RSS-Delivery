-- 0013_merge_incident_presets.sql — '장애 발생'/'장애 해결' 빌트인 프리셋을 단일 incident-active 로 통합.
-- incident-active.hbs 가 stageColor 로 진행중(빨강)·해결(초록)을 모두 칠하므로 incident-resolved 는 중복.
-- 기존 설치: incident-resolved 를 쓰던 소스를 incident-active 로 repoint 한 뒤 빌트인 행 삭제(idempotent).
-- 신규 설치: 이 시점엔 프리셋이 아직 seed 되기 전이라 매칭 행이 없어 no-op.

UPDATE sources
   SET template_id = (SELECT id FROM templates WHERE name = 'incident-active')
 WHERE template_id = (SELECT id FROM templates WHERE name = 'incident-resolved');

DELETE FROM templates WHERE name = 'incident-resolved';
