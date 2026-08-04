export function buildPreview(content: string, maxLength: number): string {
  const normalized = content.replace(/\s+/gu, ' ').trim();
  const characters = Array.from(normalized);
  if (characters.length === 0) {
    return '';
  }

  const visibleLength = Math.min(characters.length - 1, maxLength);
  return characters.slice(0, visibleLength).join('');
}
