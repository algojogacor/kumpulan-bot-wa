#!/usr/bin/env node
/**
 * WirtzBot — WhatsApp Personality Chatbot
 * Session: Turso (persistent across deploys)
 * Keys: env vars (COHERE_API_KEY, DEEPSEEK_API_KEY)
 */

// ⚠️ Background mode TTY fix — MUST be before any require
const { Readable } = require('stream');
const fakeStdin = new Readable({ read() {} });
fakeStdin.isTTY = true;
fakeStdin.setRawMode = () => {};
Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });

const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const { createClient } = require('@libsql/client');
const fs = require('fs');
const path = require('path');
const http = require('http');

// ─── Config ───
const COHERE_KEY = process.env.COHERE_API_KEY || '';
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';
const TURSO_URL = process.env.TURSO_URL || 'libsql://session-wa-algojogacorbgt.aws-ap-northeast-1.turso.io';
const TURSO_TOKEN = process.env.TURSO_TOKEN || '';
const PORT = process.env.PORT || 9000;
const SESSION_ID = 'default';
const DIM = 768;
let latestQR = '';

// ─── Turso ───
const turso = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });
const AUTH_DIR = path.join(__dirname, 'auth_info');

// Sync auth files from Turso → local (on startup)
async function syncAuthFromTurso() {
    try {
        await turso.execute(`CREATE TABLE IF NOT EXISTS baileys_auth_state (
            session_id TEXT, key TEXT, value TEXT, updated_at TEXT DEFAULT (datetime('now')),
            PRIMARY KEY (session_id, key)
        )`);
        const rows = (await turso.execute({
            sql: 'SELECT key, value FROM baileys_auth_state WHERE session_id = ?',
            args: [SESSION_ID],
        })).rows;
        
        if (rows.length === 0) return; // No session saved yet
        
        fs.mkdirSync(AUTH_DIR, { recursive: true });
        for (const { key, value } of rows) {
            fs.writeFileSync(path.join(AUTH_DIR, key), value);
        }
        console.log(`🔄 Loaded ${rows.length} auth files from Turso`);
    } catch (e) {
        console.log('   Turso sync skipped:', e.message);
    }
}

// Save auth file to Turso
async function saveToTurso(key, value) {
    try {
        await turso.execute({
            sql: `INSERT OR REPLACE INTO baileys_auth_state (session_id, key, value, updated_at) 
                  VALUES (?, ?, ?, datetime('now'))`,
            args: [SESSION_ID, key, value],
        });
    } catch (e) { /* silent */ }
}

// Sync ALL local auth files → Turso
async function syncAuthToTurso() {
    if (!fs.existsSync(AUTH_DIR)) return;
    const files = fs.readdirSync(AUTH_DIR).filter(f => f.endsWith('.json'));
    for (const f of files) {
        await saveToTurso(f, fs.readFileSync(path.join(AUTH_DIR, f), 'utf8'));
    }
    console.log(`💾 Synced ${files.length} auth files to Turso`);
}

// ─── Style ───
const SLANG = {
    'tidak':'gk','gak':'gk','nggak':'gk','kamu':'km','anda':'km','aku':'ak','saya':'ak',
    'saja':'aj','aja':'aj','sama':'sm','tapi':'tp','juga':'jg','yang':'yg','dengan':'sm',
    'kalau':'lek','hanya':'cik','sudah':'wes','udah':'udh','banget':'bgt','emang':'emg',
    'gitu':'gt','iya':'y','orang':'wong','kenapa':'kok',
};
const ENDINGS = ['cik','seh','jir','ta','yak','loh',''];

const PROMPT = `Kamu adalah Rafi (Muhammad Rafi Raditya). Ngobrol santai sama temen deketmu.

GAYA BICARA (WAJIB):
- Javanese slang SURABAYA, 100% lowercase, pesan PENDEK
- Kata khas: cik, soiya, jir, bangke, seh, gt, emg, yak, wes, tak, lek
- Singkatan: gk, yg, sm, tp, jg, aj, km, ak
- Kalau ditanya AI: "ak bot cik, disuruh aryo wkwk"

CONTOH ASLI RAFI:
{context}

Balas seperti Rafi. Pendek, slang, plek sama:`;

// ─── Load vectors ───
console.log('📂 Loading vectors...');
const meta = JSON.parse(fs.readFileSync(path.join(__dirname, 'meta.json'), 'utf8'));
const N = meta.count;
const bin = fs.readFileSync(path.join(__dirname, 'vectors_norm.bin'));
const V = new Float32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4);
const texts = JSON.parse(fs.readFileSync(path.join(__dirname, 'texts.json'), 'utf8'));
console.log(`   ${N} vectors (${(bin.byteLength/1024/1024).toFixed(1)}MB)`);

// ─── Cosine search ───
function search(qv, k=15) {
    const r = [];
    for (let i=0; i<N; i++) {
        let d=0; const o=i*DIM;
        for (let j=0; j<DIM; j++) d+=qv[j]*V[o+j];
        r.push({i, s:d, t:texts[i]});
    }
    return r.sort((a,b)=>b.s-a.s).slice(0,k);
}

// ─── APIs ───
async function embed(text) {
    const r = await fetch('https://api.cohere.ai/v2/embed', {
        method:'POST',
        headers:{'Authorization':'Bearer '+COHERE_KEY,'Content-Type':'application/json'},
        body:JSON.stringify({model:'embed-multilingual-v3.0',texts:[text],input_type:'search_query'})
    });
    return (await r.json()).embeddings[0];
}

async function llm(prompt, msg) {
    const r = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method:'POST',
        headers:{'Authorization':'Bearer '+DEEPSEEK_KEY,'Content-Type':'application/json'},
        body:JSON.stringify({model:'deepseek-chat',messages:[
            {role:'system',content:prompt},{role:'user',content:msg}
        ],max_tokens:80,temperature:0.5,top_p:0.85})
    });
    return (await r.json()).choices[0].message.content;
}

function style(t) {
    t = t.toLowerCase().trim().replace(/[.!]$/,'');
    t = t.split(/\s+/).map(w=>SLANG[w]||w).join(' ');
    if (t.length>80) { const c=t.lastIndexOf(' ',75); t=t.substring(0,c>0?c:75); }
    if (Math.random()<0.3) t+=' '+ENDINGS[Math.floor(Math.random()*6)];
    return t.trim();
}

// ─── Pipeline ───
async function reply(msg) {
    const qv = await embed(msg);
    const hits = search(qv, 15);
    if (hits[0].s >= 0.82) return hits[0].t.split('\n')[0];
    const ctx = hits.slice(0,12).map(h=>'- '+h.t.split('\n')[0]).join('\n');
    try { return style(await llm(PROMPT.replace('{context}',ctx), msg)); }
    catch { return hits[0].t.split('\n')[0]; }
}

// ─── WhatsApp ───
async function go() {
    // Load session from Turso first
    await syncAuthFromTurso();
    
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const sock = makeWASocket({
        auth:state, 
        browser:['WirtzBot','Chrome','1.0'], 
        markOnlineOnConnect:true,
        mobile: false, // use web pairing
    });

    // Pairing code on first run
    if (!state.creds.registered) {
        // Wait for connection to stabilize
        setTimeout(() => {
            if (sock.ws?.readyState === 1) { // WebSocket OPEN
                sock.requestPairingCode('6289505630895')
                    .then(code => console.log('📱 PAIRING CODE:', code, '\n   Enter in WA → Linked Devices → Link with phone'))
                    .catch(() => console.log('⚠️ Pairing failed — scan QR at /qr'));
            }
        }, 5000);
    }
    
    // Save credentials: local + Turso
    sock.ev.on('creds.update', async (creds) => {
        await saveCreds(); // local file
        await saveToTurso('creds.json', JSON.stringify(creds));
    });
    
    // On connection open: sync all pre-keys to Turso
    sock.ev.on('connection.update', async ({connection, lastDisconnect, qr}) => {
        console.log('📡 Connection:', connection, qr ? '(QR available)' : '');
        
        if (qr) {
            latestQR = qr;
            fs.writeFileSync(path.join(__dirname, 'qr.txt'), qr);
            console.log('📱 QR ready! Open http://localhost:'+PORT+'/qr to scan');
        }
        if (connection==='close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            console.log('Connection closed. Code:', code);
            const ok = code !== DisconnectReason.loggedOut;
            if (ok) setTimeout(go, 5000);
            else console.log('❌ LOGGED OUT — delete session from Turso');
        } else if (connection==='open') {
            console.log('✅ WhatsApp connected as', sock.user?.name);
            setTimeout(syncAuthToTurso, 5000);
        }
    });
    
    // Message handler
    sock.ev.on('messages.upsert', async ({messages}) => {
        for (const m of messages) {
            if (!m.message || m.key.fromMe) continue;
            const txt = m.message.conversation || m.message.extendedTextMessage?.text || m.message.imageMessage?.caption || '';
            if (!txt.trim()) continue;
            
            const grp = m.key.remoteJid.endsWith('@g.us');
            const bot = sock.user?.id?.split(':')[0]+'@s.whatsapp.net';
            if (grp && !(m.message.extendedTextMessage?.contextInfo?.mentionedJid||[]).includes(bot)) continue;
            
            console.log('📩',txt.substring(0,60));
            await sock.sendPresenceUpdate('composing', m.key.remoteJid);
            try {
                const r = await reply(txt);
                await sock.sendMessage(m.key.remoteJid, {text:r}, {quoted:m});
                console.log('  →',r);
            } catch(e) {
                await sock.sendMessage(m.key.remoteJid, {text:'gk tau ak'}, {quoted:m});
            }
        }
    });
}

// ─── Health + QR Server ───
http.createServer((req,res)=>{
    if (req.url === '/qr' && latestQR) {
        res.writeHead(200, {'Content-Type': 'text/html'});
        const html = `<!DOCTYPE html><html><head><title>WirtzBot QR</title>
<style>body{display:flex;justify-content:center;align-items:center;min-height:100vh;background:#111;margin:0}
pre{background:#fff;padding:16px;border-radius:8px;font-size:10px;line-height:1;letter-spacing:1px}</style>
</head><body><pre>${latestQR.replace(/</g,'&lt;')}</pre></body></html>`;
        res.end(html);
    } else {
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({status:'healthy',messages:N,hasQR:!!latestQR}));
    }
}).listen(PORT, () => console.log(`🌐 Server :${PORT}`));

console.log('🤖 WirtzBot starting...');
go().catch(e=>{console.error('Fatal:',e);process.exit(1);});
