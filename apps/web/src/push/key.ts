/**
 * The public key of the server comes as base64url text (04 section 5) and the browser wants its bytes. The array has a
 * plain `ArrayBuffer` behind it, which is what `PushManager.subscribe` asks for.
 */
export function urlBase64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
