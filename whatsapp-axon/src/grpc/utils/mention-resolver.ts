/**
 * WhatsApp mention utilities
 *
 * WhatsApp uses JID-based mentions (no U+FFFC placeholders like Signal).
 * Mentions are specified as an array of JIDs in the message metadata.
 */

/**
 * Cache of name → JID mappings for mention resolution
 */
const nameToJidCache = new Map<string, string>();

/**
 * Get the name → JID cache (for external population)
 */
export function getNameToJidCache(): Map<string, string> {
  return nameToJidCache;
}

/**
 * Replace @phone or @name in incoming message content with readable @name format
 *
 * @param content - Raw message content
 * @param mentionedJids - Array of mentioned JIDs from WhatsApp
 * @param jidToName - Map of JID → display name
 */
export function resolveMentionsToNames(
  content: string,
  mentionedJids: string[] | undefined,
  jidToName: Map<string, string>
): string {
  if (!mentionedJids || mentionedJids.length === 0) return content;

  let result = content;

  for (const jid of mentionedJids) {
    const name = jidToName.get(jid);
    if (!name) continue;

    // WhatsApp embeds mentions as @phone in the text
    // Replace @phone with @name for readability
    const phone = jid.replace(/@s\.whatsapp\.net$/, '');
    result = result.replace(new RegExp(`@${phone}\\b`, 'g'), `@${name}`);
  }

  return result;
}

/**
 * Detect @name patterns in speech content and convert to WhatsApp mention format
 *
 * @param content - Speech content with @name patterns
 * @param nameToJid - Map of name → JID
 * @returns Object with processed content and mentions array (JIDs)
 */
export function detectAndConvertMentions(
  content: string,
  nameToJid: Map<string, string>
): { content: string; mentions: string[] } {
  const mentions: string[] = [];

  // Sort names by length (longest first) to avoid partial matches
  const sortedNames = Array.from(nameToJid.keys()).sort((a, b) => b.length - a.length);

  let modifiedText = content;

  for (const name of sortedNames) {
    const jid = nameToJid.get(name);
    if (!jid) continue;

    let searchPos = 0;
    while (true) {
      // Look for @name patterns (case-insensitive)
      const lowerText = modifiedText.toLowerCase();
      const pos = lowerText.indexOf(`@${name.toLowerCase()}`, searchPos);
      if (pos === -1) break;

      const matchLength = name.length + 1; // +1 for @ symbol

      // Check word boundaries (character after the name)
      const charAfter = pos + matchLength < modifiedText.length ? modifiedText[pos + matchLength] : ' ';
      const afterOk = ' \n\t,.:;!?)\'"'.includes(charAfter);

      if (afterOk) {
        // Replace @name with @phone (WhatsApp format)
        const phone = jid.replace(/@s\.whatsapp\.net$/, '');
        modifiedText = modifiedText.substring(0, pos) + `@${phone}` + modifiedText.substring(pos + matchLength);

        if (!mentions.includes(jid)) {
          mentions.push(jid);
        }

        searchPos = pos + phone.length + 1;
      } else {
        searchPos = pos + 1;
      }
    }
  }

  return { content: modifiedText, mentions };
}
