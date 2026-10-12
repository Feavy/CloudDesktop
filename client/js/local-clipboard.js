// ============================================================================
//  Reading the local (browser) clipboard
//  --------------------------------------
//  The text side of a paste is `navigator.clipboard.readText()`, which every
//  browser has. An image is only reachable through `navigator.clipboard.read()`
//  -- the one call that lists what the clipboard holds -- so a paste has to ask
//  that question first and fall back to the text-only API when the listing is
//  unavailable or refused.
//
//  Both are read from that one call on purpose: each read is a permission the
//  user may be prompted for, and a clipboard that carries an image usually
//  carries text beside it (a copy from a web page brings the alt text along).
//
//  Kept out of desktop.js so which branch it takes can be exercised against a
//  stubbed clipboard without a live desktop.
// ============================================================================

// Image types the local clipboard may hand over, best first. PNG is the one
// format every paste target on the desktop reads, so anything else is
// re-encoded before it is sent (see toPng).
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'];

// Re-encode a clipboard image as PNG through a canvas. An image reaches the
// clipboard in whatever format the application that copied it chose, and the
// remote side wants one type it can advertise without guessing what the
// application pasting it understands.
async function toPng(blob) {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    return await new Promise((resolve, reject) => {
      canvas.toBlob((png) => (png ? resolve(png) : reject(new Error('PNG encode failed'))), 'image/png');
    });
  } finally {
    bitmap.close();
  }
}

// Everything the local clipboard offers: `{ image, text }`, where `image` is a
// PNG Blob or null and `text` is a string or null. Returns null when the
// browser cannot list the clipboard's contents at all -- no `read()` API, or a
// read that was refused or denied -- which is the caller's cue to use the
// text-only API by itself.
//
// An item that cannot be read (or an image that cannot be re-encoded) is not
// an error: the text read from the same call is still worth pasting.
export async function readLocalClipboard() {
  if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') return null;

  let items;
  try {
    items = await navigator.clipboard.read();
  } catch {
    return null;
  }

  let image = null, text = null;
  for (const item of items) {
    if (!image) {
      const type = IMAGE_TYPES.find((t) => item.types.includes(t));
      if (type) {
        try {
          const blob = await item.getType(type);
          image = type === 'image/png' ? blob : await toPng(blob);
        } catch { /* unreadable or not encodable: the text below still goes */ }
      }
    }
    if (text === null && item.types.includes('text/plain')) {
      try { text = await (await item.getType('text/plain')).text(); } catch { /* skip it */ }
    }
  }
  return { image, text };
}
