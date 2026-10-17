export function blankToNull(value: string | null | undefined): string | null {
  return value !== undefined && value !== null && value.trim() !== '' ? value : null;
}
