const { downloadMediaMessage } = require('@whiskeysockets/baileys');

const MEDIA_TYPES = [
  'imageMessage', 'videoMessage', 'audioMessage',
  'stickerMessage', 'documentMessage', 'ptvMessage',
];

const _pendingDeletes = new Map();
const BATCH_WINDOW_MS = 2500;

function _phone(jid = '') {
  const num = jid.split('@')[0].split(':')[0];
  return num ? `+${num}` : '?';
}

// ─────────────────────────────────────────────────────────────────────────────
//  Notification templates
// ─────────────────────────────────────────────────────────────────────────────

function _singleTemplate({ senderNum, deleterNum, timeStr, isGroup, from }) {
  const groupLine = isGroup ? `👥 *Group ID:* ${from.split('@')[0]}\n` : '';
  return (
    `│ 🚫 *ANTI-DELETE SYSTEM*\n\n` +
    `📱 *Sender:* ${senderNum}\n` +
    groupLine +
    `⏰ *Deleted Time:* ${timeStr}`
  );
}

function _multiTemplate({ deleterNum, timeStr, isGroup, from, count }) {
  const groupLine = isGroup ? `👥 *Group ID:* ${from.split('@')[0]}\n` : '';
  return (
    `│ 🚫 *ANTI-DELETE SYSTEM*\n\n` +
    `🗑️ *Deleted By:* ${deleterNum}\n` +
    groupLine +
    `⏰ *Deleted Time:* ${timeStr}\n` +
    `🔢 *Count:* ${count} messages deleted`
  );
}

function _editTemplate({ senderNum, editorNum, timeStr, isGroup, from, original, edited }) {
  const groupLine = isGroup ? `👥 *Group ID:* ${from.split('@')[0]}\n` : '';
  return (
    `│ ✏️ *ANTI-EDIT SYSTEM*\n\n` +
    `📱 *Sender:* ${senderNum}\n` +
    `✏️ *Edited By:* ${editorNum}\n` +
    groupLine +
    `⏰ *Edited Time:* ${timeStr}\n\n` +
    `╭─〔 📝 Original 〕─╮\n` +
    `> ${original}\n` +
    `╰───────────────╯\n\n` +
    `╭─〔 ✏️ Edited To 〕─╮\n` +
    `> ${edited}\n` +
    `╰───────────────╯`
  );
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = async function handleProtocolMessage(
  sock, msg, settings, security, mediaCache, ownerJid
) {
  const proto = msg.message?.protocolMessage;
  if (!proto) return false;

  const from      = msg.key.remoteJid;
  const senderJid = msg.key.participant || from;
  const isGroup   = from.endsWith('@g.us');
  const _tz       = settings.get('timezone') || 'Africa/Nairobi';
  const now       = () => new Date();

  function _timeStr(d = now()) {
    return d.toLocaleTimeString('en-US',
      { timeZone: _tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
  }
  function _dateStr(d = now()) {
    return d.toLocaleDateString('en-GB',
      { timeZone: _tz, day: '2-digit', month: 'short', year: 'numeric' });
  }

  // ── ANTIDELETE ─────────────────────────────────────────────────────────────
  if (proto.type === 0 && proto.key?.id) {
    const mode = settings.get('antiDeleteMode') || 'off';
    if (mode === 'off') return true;

    const deletedId  = proto.key.id;
    // In private chats, msg.key.participant can be a LID (internal non-phone ID)
    // instead of the real phone-based JID, so always use `from` for private chats.
    const deleterJid = isGroup ? (msg.key.participant || from) : from;
    const cached     = security.getCachedMessage(deletedId);
    const original   = cached?.msg;

    if (!original) return true;
    if (msg.key.fromMe) return true;

    const deletedAt = now();

    const batchKey = from + '::' + mode;
    if (!_pendingDeletes.has(batchKey)) {
      _pendingDeletes.set(batchKey, { timer: null, items: [], from, isGroup, mode });
    }
    const batch = _pendingDeletes.get(batchKey);
    batch.items.push({ original, deletedId, deleterJid, deletedAt });

    if (batch.timer) clearTimeout(batch.timer);
    batch.timer = setTimeout(async () => {
      _pendingDeletes.delete(batchKey);
      await _flushBatch(batch, sock, settings, mediaCache, ownerJid, _timeStr, _dateStr);
    }, BATCH_WINDOW_MS);

    return true;
  }

  // ── ANTIEDIT ───────────────────────────────────────────────────────────────
  const editedText =
    proto.editedMessage?.conversation ||
    proto.editedMessage?.extendedTextMessage?.text;

  if (editedText) {
    const mode = settings.get('antiEditMode') || 'off';
    if (mode === 'off') return true;

    const cached   = security.getCachedMessage(proto.key?.id);
    const original = cached?.msg;
    if (!original) return true;

    const senderNum    = _phone(original.key?.participant || original.key?.remoteJid);
    const editorNum    = _phone(senderJid);
    const originalText = original.message?.conversation ||
                         original.message?.extendedTextMessage?.text || '_(non-text)_';
    const editedAt = now();

    const report = _editTemplate({
      senderNum,
      editorNum,
      timeStr:  _timeStr(editedAt),
      isGroup,
      from,
      original: originalText,
      edited:   editedText,
    });

    const mentions = [
      original.key?.participant || original.key?.remoteJid,
      senderJid,
    ].filter(Boolean);

    const sendToChat  = ['chat', 'group', 'both', 'all'].includes(mode);
    const sendToOwner = ['private', 'both', 'all', 'on'].includes(mode);

    if (sendToChat)
      await sock.sendMessage(from, { text: report, mentions }).catch(() => {});
    if (sendToOwner && ownerJid && ownerJid !== from)
      await sock.sendMessage(ownerJid, { text: report, mentions }).catch(() => {});

    return true;
  }

  return true;
};

// ─────────────────────────────────────────────────────────────────────────────
//  Flush batched deletions
// ─────────────────────────────────────────────────────────────────────────────
async function _flushBatch(batch, sock, settings, mediaCache, ownerJid, _timeStr, _dateStr) {
  const { items, from, isGroup, mode } = batch;
  if (!items.length) return;

  const count       = items.length;
  const sendToChat  = ['chat', 'group', 'both', 'all'].includes(mode) &&
                      (isGroup || mode === 'chat' || mode === 'both' || mode === 'all');
  const sendToOwner = ['private', 'both', 'all', 'on'].includes(mode);

  // ── Single deletion ────────────────────────────────────────────────────────
  if (count === 1) {
    const { original, deletedId, deleterJid, deletedAt } = items[0];
    // In private chats, participant can be a LID; use remoteJid directly for accuracy
    const senderNum  = _phone(isGroup
      ? (original.key?.participant || original.key?.remoteJid)
      : original.key?.remoteJid);
    const deleterNum = _phone(deleterJid);

    const header = _singleTemplate({
      senderNum,
      deleterNum,
      timeStr:  _timeStr(deletedAt),
      isGroup,
      from,
    });

    const mentions = [
      original.key?.participant || original.key?.remoteJid,
      deleterJid,
    ].filter(Boolean);

    const sendFn = (dest) => _sendRecovered(
      sock, dest, original, deletedId, mediaCache, header, mentions
    );

    if (sendToChat)  await sendFn(from);
    if (sendToOwner && ownerJid && ownerJid !== from) await sendFn(ownerJid);
    return;
  }

  // ── Multiple deletions ─────────────────────────────────────────────────────
  const deleterNum  = _phone(items[0].deleterJid);
  const allMentions = [];
  const lines       = [];

  for (let i = 0; i < items.length; i++) {
    const { original, deleterJid, deletedAt } = items[i];
    const senderNum = _phone(isGroup
      ? (original.key?.participant || original.key?.remoteJid)
      : original.key?.remoteJid);
    const origMsg   = original.message || {};
    const origType  = Object.keys(origMsg)[0];
    const text      = origMsg.conversation || origMsg.extendedTextMessage?.text;
    const typeLabel = (origType || 'unknown').replace('Message', '');
    const content   = text
      ? `_"${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"_`
      : `_[${typeLabel}]_`;

    lines.push(
      `*#${i + 1}* — 📱 ${senderNum} · ⏰ ${_timeStr(deletedAt)}\n` +
      `╭─〔 📄 Message 〕─╮\n` +
      `> ${content}\n` +
      `╰───────────────╯`
    );

    const sJid = original.key?.participant || original.key?.remoteJid;
    if (sJid && !allMentions.includes(sJid)) allMentions.push(sJid);
    if (!allMentions.includes(deleterJid))   allMentions.push(deleterJid);
  }

  const combined =
    _multiTemplate({
      deleterNum,
      timeStr: _timeStr(items[0].deletedAt),
      isGroup,
      from,
      count,
    }) +
    `\n\n` +
    lines.join('\n\n');

  if (sendToChat)
    await sock.sendMessage(from, { text: combined, mentions: allMentions }).catch(() => {});
  if (sendToOwner && ownerJid && ownerJid !== from)
    await sock.sendMessage(ownerJid, { text: combined, mentions: allMentions }).catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
//  Send a recovered message (text or media)
// ─────────────────────────────────────────────────────────────────────────────
async function _sendRecovered(sock, destJid, original, deletedId, mediaCache, header, mentions) {
  try {
    const origMsg  = original.message || {};
    const origType = Object.keys(origMsg)[0];
    const text     = origMsg.conversation || origMsg.extendedTextMessage?.text;

    if (text) {
      await sock.sendMessage(destJid, {
        text: `${header}\n\n╭─〔 📄 Message 〕─╮\n> ${text}\n╰───────────────╯`,
        mentions,
      }).catch(() => {});
      return;
    }

    if (!MEDIA_TYPES.includes(origType)) {
      await sock.sendMessage(destJid, {
        text: `${header}\n\n🗑️ _[${(origType || 'unknown').replace('Message', '')} — could not retrieve]_`,
      }).catch(() => {});
      return;
    }

    const eager   = mediaCache.get(deletedId);
    let mediaBuf  = eager?.buffer || null;
    let msgData   = origMsg[origType] || {};

    if (eager) {
      msgData = {
        mimetype:    eager.mimetype    || msgData.mimetype,
        ptt:         eager.ptt         ?? msgData.ptt,
        caption:     eager.caption     || msgData.caption,
        fileName:    eager.fileName    || msgData.fileName,
        gifPlayback: eager.gifPlayback ?? msgData.gifPlayback,
      };
    }

    if (!mediaBuf) {
      mediaBuf = await downloadMediaMessage(original, 'buffer', {}).catch(() => null);
    }

    if (!mediaBuf) {
      await sock.sendMessage(destJid, {
        text: `${header}\n\n🗑️ _[Media could not be retrieved — may have expired]_`,
      }).catch(() => {});
      return;
    }

    const capExtra = msgData.caption ? `\n\n🗑️ _${msgData.caption}_` : '';
    const caption  = `${header}${capExtra}`;

    if (origType === 'stickerMessage') {
      await sock.sendMessage(destJid, { sticker: mediaBuf }).catch(() => {});
      await sock.sendMessage(destJid, { text: `${header}\n\n🗑️ _(sticker deleted)_` }).catch(() => {});
    } else if (origType === 'audioMessage') {
      await sock.sendMessage(destJid, {
        audio:    mediaBuf,
        mimetype: msgData.mimetype || (msgData.ptt ? 'audio/ogg; codecs=opus' : 'audio/mpeg'),
        ptt:      msgData.ptt || false,
      }).catch(() => {});
      await sock.sendMessage(destJid, {
        text: `${header}\n\n🗑️ _(${msgData.ptt ? 'voice note' : 'audio'} deleted)_`,
      }).catch(() => {});
    } else if (origType === 'videoMessage' || origType === 'ptvMessage') {
      await sock.sendMessage(destJid, {
        video:       mediaBuf,
        caption,
        mimetype:    msgData.mimetype || 'video/mp4',
        gifPlayback: msgData.gifPlayback || false,
      }).catch(() => {});
    } else if (origType === 'imageMessage') {
      await sock.sendMessage(destJid, {
        image:   mediaBuf,
        caption,
      }).catch(() => {});
    } else if (origType === 'documentMessage') {
      await sock.sendMessage(destJid, {
        document: mediaBuf,
        mimetype: msgData.mimetype || 'application/octet-stream',
        fileName: msgData.fileName || 'file',
        caption:  header,
      }).catch(() => {});
    }
  } catch (err) {
    console.error('[antidelete] sendRecovered error:', err.message);
  }
}
