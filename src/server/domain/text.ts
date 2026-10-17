/** 공백뿐이거나 값이 없으면 null을 반환하고, 내용이 있는 문자열은 원문을 유지한다. */
export function blankToNull(value: string | null | undefined): string | null {
  return value !== undefined && value !== null && value.trim() !== '' ? value : null;
}
