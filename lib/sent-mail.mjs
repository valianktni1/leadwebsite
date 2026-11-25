import { ImapFlow } from 'imapflow';

export function usesHostingerMailbox(host) {
  return host.toLowerCase() === 'smtp.hostinger.com';
}

export async function saveHostingerSentCopy(auth, raw) {
  const client = new ImapFlow({
    host: 'imap.hostinger.com', port: 993, secure: true, auth,
    logger: false, disableAutoIdle: true,
    connectionTimeout: 7000, greetingTimeout: 7000, socketTimeout: 10000
  });
  client.on('error', () => client.close());
  const deadline = setTimeout(() => client.close(), 15000);
  try {
    await client.connect();
    const folders = await client.list();
    const sent = folders.find(folder => folder.specialUse === '\\Sent' && !folder.flags.has('\\Noselect'));
    if (!sent || !await client.append(sent.path, raw, ['\\Seen'])) {
      throw new Error('Could not confirm the Sent copy.');
    }
  } finally {
    clearTimeout(deadline);
    client.close();
  }
}
