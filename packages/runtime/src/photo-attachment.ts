/** The explicit existing-file form never schedules the camera or a planner. */
export function matchExistingAttachment(input: string): { path: string } | null {
  const text = input.trim().replace(/^[“"](?=(?:please\s+)?(?:attach|upload)\b)/i, '').replace(/[”"]$/, '');
  const prefix = /^(?:please\s+)?(?:attach|upload)(?: only)?(?: this| the)?(?: Photo Booth)? (?:image|photo|picture|file) to (?:the |my )?(?:existing |open )?Qwen chat(?: in Google Chrome)?\s*:\s*/i.exec(text);
  if (!prefix) return null;
  const rest = text.slice(prefix[0].length);
  const file = /^["“']?((?:~\/|\/)[^\r\n\u0000]*?\.(?:jpe?g|png|gif|webp|heic))["”']?(?=$|\s*[.!])/i.exec(rest);
  if (!file) return null;
  const suffix = rest.slice(file[0].length).replace(/^[.\s]+/, '');
  const noSend = /^(?:do not|don't|never) (?:submit|send)(?:\s*(?:\/|or|and)\s*(?:submit|send))?(?: (?:it|anything|the (?:chat|message)))?[.!]?$/i;
  const noOtherAction = /^(?:do not|don't|never) take (?:another|a new) photo,\s*type a chat message,\s*or (?:submit\/send|send\/submit|submit or send|send or submit) anything[.!]?$/i;
  return !suffix || noSend.test(suffix) || noOtherAction.test(suffix) ? { path: file[1]! } : null;
}

/** A bounded, attach-only workflow. More complex requests stay with the planner. */
export function matchPhotoAttachment(input: string): boolean {
  const text = input.toLowerCase().replace(/[’‘]/g, "'").replace(/\b(?:uplaod|uplod|uploaad)\b/g, 'upload');
  if (!/\bqwen\b/.test(text) || !/\b(?:attach|upload)\w*\b/.test(text)) return false;
  if (!/\b(?:take|snap|capture)\b.{0,45}\b(?:photo|pic|picture|selfie)\b/.test(text)) return false;
  if (/\b(?:safari|firefox|edge|brave|arc)\b/.test(text)) return false;
  if (/\b(?:don'?t|do not|never)\s+(?:take|snap|capture|attach|upload)\b/.test(text)) return false;
  const hold = /\b(?:don'?t|do not|never)\s+(?:(?:send|submit)(?:\s+it)?(?:\s+(?:or|and)\s+)?)+|\bwithout\s+(?:sending|submitting)\b|\b(?:leave|keep)\b.{0,20}\bunsent\b|\bdraft[- ]only\b/gi;
  // Upload/attach means stage the attachment. Sending requires a separate explicit request.
  const rest = text.replace(hold, '');
  // Do not silently omit an additional action, message, destination, or file constraint.
  return !/\b(?:send|submit|publish|post|email|delete|remove|crop|edit|filter|save|move|rename|write|type|caption|tell|ask|say|analy[sz]e|summari[sz]e|instead|except|unless|other|another|new chat|tomorrow|later|after|before|when|wait|seconds?|minutes?|hours?|only if)\b|https?:\/\/|~\/|\/Users\//i.test(rest);
}
