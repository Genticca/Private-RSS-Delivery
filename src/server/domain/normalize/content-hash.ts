import { createHash } from 'node:crypto';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function computeGenericContentHash(input: {
  title: string;
  link: string
}): string {
  // 일반 뉴스는 제목과 링크를 기준으로 한다. 요약만 바뀌면 재발송하지 않는다.
  return sha256Hex(`${input.title}\n${input.link}`);
}

export function computeIncidentContentHash(input: {
  stage: string;
  summary: string
}): string {
  // 장애 공지는 같은 링크에서 상태가 갱신되므로 단계와 최신 본문을 비교한다.
  return sha256Hex(`${input.stage}\n${input.summary}`);
}
