/**
 * VTT Pre-Processing Utility
 *
 * Strips all WebVTT technical metadata from transcript content,
 * returning only clean speaker-attributed dialogue text.
 *
 * Removes:
 *  - "WEBVTT" header line
 *  - Cue timing lines (e.g., "00:00:00.000 --> 00:00:05.000")
 *  - Cue identifiers (numeric or UUID)
 *  - NOTE blocks
 *  - Blank/whitespace-only lines
 *  - HTML tags (<v>, <c>, etc.)
 */

/**
 * Clean raw VTT transcript content into plain speaker dialogue.
 */
export function cleanVttTranscript(rawVtt: string): string {
  const lines = rawVtt.split(/\r?\n/);
  const cleanedLines: string[] = [];
  let skipNote = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines
    if (trimmed === '') {
      skipNote = false; // NOTE blocks end at a blank line
      continue;
    }

    // Skip WEBVTT header
    if (/^WEBVTT/i.test(trimmed)) {
      continue;
    }

    // Skip NOTE blocks (multi-line comments)
    if (/^NOTE\b/i.test(trimmed)) {
      skipNote = true;
      continue;
    }
    if (skipNote) {
      continue;
    }

    // Skip timing lines: "00:00:00.000 --> 00:00:05.000"
    if (/^\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}/.test(trimmed)) {
      continue;
    }

    // Skip pure numeric cue identifiers
    if (/^\d+$/.test(trimmed)) {
      continue;
    }

    // Skip UUID-style cue identifiers
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
      continue;
    }

    // Strip HTML voice tags: <v Speaker Name>text</v>  →  Speaker Name: text
    let cleaned = trimmed;

    // Handle <v SpeakerName>dialogue</v> pattern (common in Teams VTT)
    cleaned = cleaned.replace(/<v\s+([^>]+)>/gi, '$1: ');
    cleaned = cleaned.replace(/<\/v>/gi, '');

    // Strip any remaining HTML tags
    cleaned = cleaned.replace(/<[^>]+>/g, '');

    // Collapse multiple spaces
    cleaned = cleaned.replace(/\s{2,}/g, ' ').trim();

    if (cleaned.length > 0) {
      cleanedLines.push(cleaned);
    }
  }

  // Merge consecutive lines from the same speaker
  return mergeSpeakerLines(cleanedLines);
}

/**
 * Merge consecutive lines from the same speaker into single paragraphs.
 * Input:  ["Alice: Hello", "Alice: How are you", "Bob: Fine thanks"]
 * Output: "Alice: Hello How are you\nBob: Fine thanks"
 */
function mergeSpeakerLines(lines: string[]): string {
  if (lines.length === 0) return '';

  const merged: string[] = [];
  let currentSpeaker = '';
  let currentText = '';

  for (const line of lines) {
    const speakerMatch = line.match(/^([^:]+):\s*(.*)/);
    if (speakerMatch) {
      const speaker = speakerMatch[1].trim();
      const text = speakerMatch[2].trim();

      if (speaker === currentSpeaker) {
        // Same speaker → append
        currentText += ' ' + text;
      } else {
        // New speaker → flush previous
        if (currentSpeaker) {
          merged.push(`${currentSpeaker}: ${currentText}`);
        }
        currentSpeaker = speaker;
        currentText = text;
      }
    } else {
      // No speaker prefix → append to current or add standalone
      if (currentSpeaker) {
        currentText += ' ' + line;
      } else {
        merged.push(line);
      }
    }
  }

  // Flush last speaker
  if (currentSpeaker) {
    merged.push(`${currentSpeaker}: ${currentText}`);
  }

  return merged.join('\n');
}
