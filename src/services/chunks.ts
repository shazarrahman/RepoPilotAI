export function splitIntoChunks(text: string, size = 900, overlap = 150): string[] {
  const clean = text.trim(); const chunks: string[] = [];
  for (let start = 0; start < clean.length; start += size - overlap) {
    chunks.push(clean.slice(start, start + size)); if (start + size >= clean.length) break;
  }
  return chunks.filter(Boolean);
}
