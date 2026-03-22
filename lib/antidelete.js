const { downloadMediaMessage } = require('@whiskeysockets/baileys');

const MEDIA_TYPES = [
  'imageMessage', 'videoMessage', 'audioMessage',
  'stickerMessage', 'documentMessage', 'ptvMessage',
];

/**
 * Handle antidelete and antiedit via protocolMessage interception.
 *
 * @param {object} sock       - Baileys socket
 * @param {object} msg        - Full incoming Baileys message
 * @param {object} settings   - Bot settings store (has .get / .set)
 * @param {object} security   - Security module (has .getCachedMessage)
 * @param {Map}    mediaCache - _mediaBufferCache from index.js
 * @param {string} ownerJid   - Bot owner JID (e.g. "1234@s.whatsapp.net")
 * @returns {boolean}         - true if message was handled (caller should return early)
 */
module.exports = async function handleProtocolMessage(
  sock, msg, settings, security, mediaCache, ownerJid
) {
  const proto = msg.message?.protocolMessage;
  if (!proto) return false;

  const from      = msg.key.remoteJid;
  const senderJid = msg.key.participant || from;
  const isGroup   = from.endsWith('@g.us');
  const chatType  = isGroup ? '(Group Chat)' : '(Private Chat)';
  const _tz       = settings.get('timezone') || 'Africa/Nairobi';

  function _dateStr() {
    return new Date().toLocaleDateString('en-GB',
      { timeZone: _tz, day: '2-digit', month: 'short', year: 'numeric' });
  }
  function _timeStr() {
    return new Date().toLocaleTimeString('en-US',
      { timeZone: _tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
  }

  // ── ANTIDELETE ────────────────────────────────────────────────────────────
  if (proto.type === 0 && proto.key?.id) {
    const mode = settings.get('antiDeleteMode') || 'off';
    if (mode === 'off') return true;

    const deletedId  = proto.key.id;
    const deleterJid = senderJid;
    const cached     = security.getCachedMessage(deletedId);
    const original   = cached?.msg;

    if (!original) return true;

    // Skip if the bot itself deleted the message
    if (msg.key.fromMe) return true;

    const senderPhone  = (original.key?.participant || original.key?.remoteJid || '?')
      .split('@')[0].split(':')[0];
    const deleterPhone = deleterJid.split('@')[0].split(':')[0];

    const header =
      `👨‍💻 *『 𝗗𝗘𝗟𝗘𝗧𝗘𝗗 𝗠𝗔𝗦𝗦𝗔𝗚𝗘 𝗗𝗘𝗧𝗘𝗖𝗧𝗘𝗗 』!* 🤓\n\n` +
      `𝙲𝙷𝙰𝚃: ${chatType}\n` +
      `𝚂𝙴𝙽𝚃 𝙱𝚈: @${senderPhone}\n` +
      `𝚃𝙸𝙼𝙴 𝚂𝙴𝙽𝚃: ${_timeStr()}\n` +
      `𝙳𝙰𝚃𝙴 𝚂𝙴𝙽𝚃: ${_dateStr()}\n` +
      `𝙳𝙴𝙻𝙴𝚃𝙴𝙳 𝙱𝚈: @${deleterPhone}`;

    const mentions = [
      original.key?.participant || original.key?.remoteJid,
      deleterJid,
    ].filter(Boolean);

    const sendRecovered = async (destJid) => {
      try {
        const origMsg  = original.message || {};
        const origType = Object.keys(origMsg)[0];
        const text     = origMsg.conversation || origMsg.extendedTextMessage?.text;

        if (text) {
          await sock.sendMessage(destJid, {
            text: `${header}\n\n𝙼𝙴𝚂𝚂𝙰𝙶𝙴: ${text}`,
            mentions,
          }).catch(() => {});
          return;
        }

        if (!MEDIA_TYPES.includes(origType)) {
          await sock.sendMessage(destJid, {
            text: `${header}\n\n_[${(origType || 'unknown').replace('Message', '')} — could not retrieve]_`,
          }).catch(() => {});
          return;
        }

        const eager    = mediaCache.get(deletedId);
        let mediaBuf   = eager?.buffer || null;
        let msgData    = origMsg[origType] || {};

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
            text: `${header}\n\n_[Media could not be retrieved — it may have expired]_`,
          }).catch(() => {});
          return;
        }

        const caption = msgData.caption ? `\n_${msgData.caption}_` : '';

        if (origType === 'stickerMessage') {
          await sock.sendMessage(destJid, { sticker: mediaBuf }).catch(() => {});
          await sock.sendMessage(destJid, { text: `${header} _(sticker)_` }).catch(() => {});
        } else if (origType === 'audioMessage') {
          await sock.sendMessage(destJid, {
            audio:    mediaBuf,
            mimetype: msgData.mimetype || (msgData.ptt ? 'audio/ogg; codecs=opus' : 'audio/mpeg'),
            ptt:      msgData.ptt || false,
          }).catch(() => {});
          await sock.sendMessage(destJid, {
            text: `${header} _(${msgData.ptt ? 'voice note' : 'audio'})_`,
          }).catch(() => {});
        } else if (origType === 'videoMessage' || origType === 'ptvMessage') {
          await sock.sendMessage(destJid, {
            video:       mediaBuf,
            caption:     `${header}${caption}`,
            mimetype:    msgData.mimetype || 'video/mp4',
            gifPlayback: msgData.gifPlayback || false,
          }).catch(() => {});
        } else if (origType === 'imageMessage') {
          await sock.sendMessage(destJid, {
            image:   mediaBuf,
            caption: `${header}${caption}`,
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
    };

    // Decide where to send based on mode
    // "private" → only to bot owner DM
    // "chat"    → to the same chat only
    // "group"   → same chat (groups only)
    // "both" / "all" / "on" → same chat + owner DM
    const sendToChat  = ['chat', 'group', 'both', 'all'].includes(mode) &&
                        (isGroup || mode === 'chat' || mode === 'both' || mode === 'all');
    const sendToOwner = ['private', 'both', 'all', 'on'].includes(mode) ||
                        mode === 'private';

    if (sendToChat)                              await sendRecovered(from);
    if (sendToOwner && ownerJid && ownerJid !== from) await sendRecovered(ownerJid);

    return true;
  }

  // ── ANTIEDIT ──────────────────────────────────────────────────────────────
  const editedText =
    proto.editedMessage?.conversation ||
    proto.editedMessage?.extendedTextMessage?.text;

  if (editedText) {
    const mode = settings.get('antiEditMode') || 'off';
    if (mode === 'off') return true;

    const editedId  = proto.key?.id;
    const editorJid = senderJid;
    const cached    = security.getCachedMessage(editedId);
    const original  = cached?.msg;

    if (!original) return true;

    const senderPhone = (original.key?.participant || original.key?.remoteJid || '?')
      .split('@')[0].split(':')[0];
    const editorPhone = editorJid.split('@')[0].split(':')[0];
    const originalText = original.message?.conversation ||
                         original.message?.extendedTextMessage?.text || '_[non-text]_';

    const report =
      `👨‍💻 *『 𝗘𝗗𝗜𝗧𝗘𝗗 𝗠𝗘𝗦𝗦𝗔𝗚𝗘 𝗗𝗘𝗧𝗘𝗖𝗧𝗘𝗗 』!* 🤓\n\n` +
      `𝙲𝙷𝙰𝚃: ${chatType}\n` +
      `𝚂𝙴𝙽𝚃 𝙱𝚈: @${senderPhone}\n` +
      `𝚂𝙴𝙽𝚃 𝙾𝙽: ${_timeStr()}\n` +
      `𝙳𝙰𝚃𝙴 𝚂𝙴𝙽𝚃: ${_dateStr()}\n` +
      `𝙴𝙳𝙸𝚃𝙴𝙳 𝙱𝚈: @${editorPhone}\n\n` +
      `𝙾𝚁𝙸𝙶𝙸𝙽𝙰𝙻 𝙼𝚂𝙶: ${originalText}\n\n` +
      `𝙴𝙳𝙸𝚃𝙴𝙳 𝚃𝙾: ${editedText}`;

    const mentions = [
      original.key?.participant || original.key?.remoteJid,
      editorJid,
    ].filter(Boolean);

    const sendToChat  = ['chat', 'group', 'both', 'all'].includes(mode);
    const sendToOwner = ['private', 'both', 'all', 'on'].includes(mode);

    if (sendToChat)                              await sock.sendMessage(from,     { text: report, mentions }).catch(() => {});
    if (sendToOwner && ownerJid && ownerJid !== from) await sock.sendMessage(ownerJid, { text: report, mentions }).catch(() => {});

    return true;
  }

  return true; // all protocolMessages are handled — always skip further processing
};
