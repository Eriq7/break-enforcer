// Photo files live in the private `photos` bucket:
//   <user id>/refs/<uuid>.jpg                    reference photos of the 7th floor scene
//   <user id>/attempts/<session id>/<uuid>.jpg   check-in photos
import { randomUUID } from 'node:crypto';
import { HttpError } from './http.js';
import { db, must } from './db.js';

const BUCKET = 'photos';
const MAX_BYTES = 4 * 1024 * 1024;

// The app sends photos as base64 JPEG, already shrunk on the phone.
export function decodeJpeg(base64) {
  if (typeof base64 !== 'string' || base64.length === 0) {
    throw new HttpError(400, 'bad_photo', 'No photo received');
  }
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > MAX_BYTES) throw new HttpError(413, 'photo_too_big', 'Photo is too large');
  if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    throw new HttpError(400, 'bad_photo', 'Photo must be a JPEG');
  }
  return bytes;
}

export function referencePath(userId) {
  return `${userId}/refs/${randomUUID()}.jpg`;
}

export function attemptPath(userId, sessionId) {
  return `${userId}/attempts/${sessionId}/${randomUUID()}.jpg`;
}

export async function upload(path, bytes) {
  must(await db().storage.from(BUCKET).upload(path, bytes, { contentType: 'image/jpeg' }), 'upload');
}

export async function download(path) {
  const blob = must(await db().storage.from(BUCKET).download(path), 'download');
  return Buffer.from(await blob.arrayBuffer());
}

export async function remove(path) {
  must(await db().storage.from(BUCKET).remove([path]), 'remove');
}

// Short-lived links so the app can show photos from the private bucket.
export async function signedUrls(paths, seconds = 3600) {
  if (paths.length === 0) return {};
  const rows = must(await db().storage.from(BUCKET).createSignedUrls(paths, seconds), 'sign');
  return Object.fromEntries(rows.filter((r) => r.signedUrl).map((r) => [r.path, r.signedUrl]));
}
