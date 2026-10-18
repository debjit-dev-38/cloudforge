// Cognito OAuth helpers shared by the static dashboard and local tests.
// API Gateway's configured JWT audience matches the Cognito ID-token `aud` claim.
export function selectApiToken(tokens) {
  return tokens?.id_token || tokens?.access_token || null;
}

export function tokenIsExpired(token, now = Date.now()) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.exp * 1000 <= now;
  } catch {
    return true;
  }
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function createPkcePair() {
  const random = new Uint8Array(32);
  crypto.getRandomValues(random);
  const verifier = base64Url(random);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}
