// plugins/broadcast_list.js

const isOwnerOrSudo = async (number) => {
  const config = require('../../config');
  return config.ownerNumber.some(owner => owner.includes(number));
};
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

const NUMBERS = [
  "94707040302",
  "94762808184",
  "94741288404",
  "94771730169",
  "94772096982",
  "94710996050",
  "94772894413",
  "94728705444",
  "94772079981",
];

async function isGroupAdmin(sock, chatId, senderJid){
  if(!chatId.endsWith("@g.us")) return false;
  try{
    const meta = await sock.groupMetadata(chatId);
    return meta.participants
      .filter(p=>p.admin)
      .map(p=>p.id)
      .includes(senderJid);
  }catch{ return false; }
}

module.exports = {
  command: "broadcast",
  aliases: ["brodcast","bc"],

  async handler(sock, message, args, context={}){

    const chatId = context.chatId || message.key.remoteJid;
    const senderJid = message.key.participant || message.key.remoteJid;

    const ownerOk = await isOwnerOrSudo(senderJid.split("@")[0]);
    const adminOk = await isGroupAdmin(sock, chatId, senderJid);

    if(!ownerOk && !adminOk){
      return sock.sendMessage(chatId,{text:"❌ Admin only"}, {quoted:message});
    }

    const text = args.join(" ").trim();
    if(!text){
      return sock.sendMessage(chatId,{text:"Usage: .broadcast message"}, {quoted:message});
    }

    await sock.sendMessage(chatId,{text:"📡 Checking numbers on WhatsApp..."},{quoted:message});

    // ✔ Verify which numbers exist on WhatsApp
    let validJids = [];
    let invalid = [];

    for(const num of NUMBERS){
      try{
        const res = await sock.onWhatsApp(num);
        if(res?.[0]?.exists){
          validJids.push(res[0].jid);
        }else{
          invalid.push(num);
        }
      }catch{
        invalid.push(num);
      }
    }

    if(!validJids.length){
      return sock.sendMessage(chatId,{
        text:`❌ No valid WhatsApp numbers found.\n\nChecked: ${NUMBERS.length}`
      },{quoted:message});
    }

    await sock.sendMessage(chatId,{
      text:`📣 Broadcasting to ${validJids.length} users...\nSkipped: ${invalid.length}`
    },{quoted:message});

    let sent=0, failed=0;

    for(const jid of validJids){
      try{
        await sock.sendMessage(jid,{text});
        sent++;
      }catch(e){
        failed++;
      }
      await sleep(1300);
    }

    return sock.sendMessage(chatId,{
      text:
`✅ Broadcast complete!

📤 Sent: ${sent}
❌ Failed: ${failed}
⚠️ Skipped: ${invalid.length}`
    },{quoted:message});
  }
};
