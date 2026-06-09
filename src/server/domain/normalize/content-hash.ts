import { createHash } from 'node:crypto';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function computeGenericContentHash(input: { title: string; link: string }): string {
  return sha256Hex(`${input.title}\n${input.link}`);
}

export function computeIncidentContentHash(input: { stage: string; summary: string }): string {
  return sha256Hex(`${input.stage}\n${input.summary}`);
}
