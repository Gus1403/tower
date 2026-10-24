// Unsent composer text per session. Lives for the page session so switching sessions never mixes drafts.
const drafts = new Map<string, string>();

export function getDraft(id: string): string {
  return drafts.get(id) ?? '';
}

export function setDraft(id: string, text: string): void {
  if (text) drafts.set(id, text);
  else drafts.delete(id);
}

/** Put text back after a failed send, unless the owner already typed something new there. */
export function restoreDraft(id: string, text: string): void {
  if (!getDraft(id).trim()) setDraft(id, text);
}
