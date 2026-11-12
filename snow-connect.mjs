#!/usr/bin/env node
// Standalone Node 22+ client, also published with the static website.
import { readFile, writeFile, mkdir, rename, lstat, open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export function safeUrl(value) {
  const url = new URL(value);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTPS API URL without credentials, query or fragment.');
  return url.href.replace(/\/$/, '');
}
export async function readConnection(filename) {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('The connection file must be a private regular file (chmod 600).');
  const data = JSON.parse(await readFile(filename, 'utf8'));
  if (data.format !== 'snowmates-connection-v1') throw new Error('Invalid connection file.');
  safeUrl(data.apiUrl);
  return data;
}
async function saveConnection(filename, data, fresh = false) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  if (fresh) {
    const handle = await open(filename, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(data)); } finally { await handle.close(); }
  } else {
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
    await rename(temporary, filename);
  }
}
async function post(apiUrl, route, body, token, fetcher = fetch) {
  const response = await fetcher(`${safeUrl(apiUrl)}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Snow-Source': 'cli', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(20000),
  });
  const result = await response.json();
  if (!response.ok || result?.ok !== true) throw new Error(result?.error?.code || `Request failed (${response.status}).`);
  return result.data;
}
export async function startConnection({ apiUrl, invite, clientName = 'Personal AI', filename, profileDraft }, fetcher = fetch) {
  const url = new URL(invite);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Invalid invitation URL.');
  const inviteCode = (new URLSearchParams(url.hash.slice(1)).get('invite') || url.searchParams.get('invite') || '').replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-F0-9]{20}$/.test(inviteCode)) throw new Error('The original invitation URL must include its full invite code.');
  const sessionFile = path.resolve(filename || path.join(homedir(), '.config', 'snowmates', 'connections', `${randomUUID()}.json`));
  // Create the private destination first, so an existing connection is never replaced.
  const data = { format: 'snowmates-connection-v1', apiUrl: safeUrl(apiUrl), status: 'starting' };
  await saveConnection(sessionFile, data, true);
  const result = await post(apiUrl, '/agent/connect/start', { inviteCode, clientName, ...(profileDraft ? { profileDraft } : {}) }, undefined, fetcher);
  if (!/^[a-f0-9]{64}$/.test(result.deviceCode || '') || typeof result.verificationUri !== 'string') throw new Error('Invalid authorization response.');
  const approval = new URL(result.verificationUri);
  if (approval.origin !== url.origin || !['https:', 'http:'].includes(approval.protocol)) throw new Error('Authorization page does not match the invitation website.');
  await saveConnection(sessionFile, { ...data, status: 'pending', deviceCode: result.deviceCode, expiresAt: new Date(Date.now() + result.expiresIn * 1000).toISOString() });
  return { status: 'pending', connectionFile: sessionFile, verificationUri: result.verificationUri, userCode: result.userCode, interval: result.interval, expiresIn: result.expiresIn };
}
export async function pollConnection(filename, fetcher = fetch) {
  const data = await readConnection(filename);
  if (data.status === 'approved') {
    if ((!Number.isFinite(Date.parse(data.expiresAt)) || Date.parse(data.expiresAt) <= Date.now())) throw new Error('Connection expired. Start a new authorization.');
    return { status: 'approved', tripId: data.tripId, memberId: data.memberId, expiresAt: data.expiresAt, connectionFile: path.resolve(filename) };
  }
  if (data.status !== 'pending' || !/^[a-f0-9]{64}$/.test(data.deviceCode || '')) throw new Error('Start a new connection request.');
  const result = await post(data.apiUrl, '/agent/connect/poll', { deviceCode: data.deviceCode }, undefined, fetcher);
  if (result.status === 'approved') {
    if (!/^snow_ai_[a-f0-9]{64}$/.test(result.token || '') || !result.tripId || !result.memberId || !Number.isFinite(Date.parse(result.expiresAt))) throw new Error('Invalid authorization response.');
    await saveConnection(filename, { format: data.format, apiUrl: data.apiUrl, status: 'approved', token: result.token, tripId: result.tripId, memberId: result.memberId, expiresAt: result.expiresAt });
    return { status: 'approved', tripId: result.tripId, memberId: result.memberId, expiresAt: result.expiresAt, connectionFile: path.resolve(filename) };
  }
  if (!['pending', 'denied', 'expired'].includes(result.status)) throw new Error('Invalid authorization status.');
  return { status: result.status };
}
export async function connectionCall(filename, request, fetcher = fetch) {
  const data = await readConnection(filename);
  if (data.status !== 'approved' || !/^snow_ai_[a-f0-9]{64}$/.test(data.token || '') || (!Number.isFinite(Date.parse(data.expiresAt)) || Date.parse(data.expiresAt) <= Date.now())) throw new Error('Authorize this connection first.');
  if (request.tripId && request.tripId !== data.tripId) throw new Error('This connection belongs to a different trip.');
  if (!['trip.list', 'trip.get_context', 'trip.export', 'changes.list'].includes(request.operation) && (!Number.isInteger(request.expectedVersion) || request.expectedVersion < 1 || !request.requestId)) throw new Error('Writes require expectedVersion and a stable requestId. Read trip.get_context first.');
  return post(data.apiUrl, '/api/operations', { ...request, ...(request.operation === 'trip.list' ? {} : { tripId: data.tripId }) }, data.token, fetcher);
}
export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    api: { type: 'string' }, invite: { type: 'string' }, session: { type: 'string' }, name: { type: 'string' }, profile: { type: 'string' }, input: { type: 'string' }, file: { type: 'string' },
  } });
  const [command] = positionals;
  let result;
  if (command === 'start') result = await startConnection({ apiUrl: values.api, invite: values.invite, filename: values.session, clientName: values.name, profileDraft: values.profile ? JSON.parse(await readFile(values.profile, 'utf8')) : undefined });
  else if (command === 'poll') result = await pollConnection(values.session);
  else if (command === 'call') {
    if ((!values.file && !values.input) || (values.file && values.input)) throw new Error('Use --input JSON or --file request.json.');
    const request = JSON.parse(values.file ? await readFile(values.file, 'utf8') : values.input);
    result = await connectionCall(values.session, request);
  } else {
    process.stdout.write('Snowmates (Node 22+)\nstart --api API_URL --invite FULL_INVITE_URL [--name "My AI"] [--profile profile.json] [--session private.json]\npoll --session private.json\ncall --session private.json --input \'{"operation":"trip.get_context"}\'\nKeep the connection file private. Show the approval URL and code to the person; never perform their Google login or consent for them. Poll no more than once every 5 seconds.\n');
    return;
  }
  process.stdout.write(`${JSON.stringify({ ok: true, data: result }, null, 2)}\n`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  // Do not echo arbitrary request bodies, file contents or credentials.
  const message = error instanceof Error && !/snow_ai_|eyJ|deviceCode/.test(error.message) ? error.message : 'Connection failed.';
  process.stderr.write(`${JSON.stringify({ ok: false, error: { code: 'CONNECTION_ERROR', message } })}\n`); process.exitCode = 1;
});
