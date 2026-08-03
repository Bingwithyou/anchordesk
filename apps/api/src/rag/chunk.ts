export const DEFAULT_CHUNK_MAX_LENGTH = 900;

function characterLength(value: string): number {
  return Array.from(value).length;
}

export function chunkDocument(
  content: string,
  maxLength = DEFAULT_CHUNK_MAX_LENGTH,
): string[] {
  if (!Number.isInteger(maxLength) || maxLength <= 0) {
    throw new Error('chunk 最大长度必须是正整数');
  }

  const paragraphs = content
    .replace(/\r\n?/gu, '\n')
    .split(/\n[\t ]*\n+/gu)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
  const chunks: string[] = [];
  let current = '';

  for (const paragraph of paragraphs) {
    const characters = Array.from(paragraph);
    if (characters.length > maxLength) {
      if (current !== '') {
        chunks.push(current);
        current = '';
      }
      for (let offset = 0; offset < characters.length; offset += maxLength) {
        chunks.push(characters.slice(offset, offset + maxLength).join(''));
      }
      continue;
    }

    const combined = current === '' ? paragraph : `${current}\n\n${paragraph}`;
    if (current !== '' && characterLength(combined) > maxLength) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = combined;
    }
  }

  if (current !== '') {
    chunks.push(current);
  }

  return chunks;
}
