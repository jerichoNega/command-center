import 'dotenv/config';
import { Telegraf, Context } from 'telegraf';
import axios from 'axios';

const TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SYNC_KEY = process.env.CC_SYNC_KEY;

if (!TOKEN || !GEMINI_API_KEY || !SUPABASE_URL || !SUPABASE_KEY || !SYNC_KEY) {
  throw new Error('Missing environment variables in .env');
}

const bot = new Telegraf(TOKEN);

// ── Gemini Transcription ─────────────────────────────────────────────────────
async function transcribeAudio(audioBuffer: Buffer, mimeType: string): Promise<string> {
  try {
    const base64Audio = audioBuffer.toString('base64');
    const body = {
      contents: [{
        parts: [
          { text: "Please transcribe this audio. Only output the transcription text, nothing else." },
          {
            inline_data: {
              mime_type: mimeType,
              data: base64Audio
            }
          }
        ]
      }]
    };

    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini API error: ${res.status} ${errText}`);
    }

    const data = await res.json() as any;
    const transcription = data.candidates?.[0]?.content?.parts?.[0]?.text;
    return transcription?.trim() || '[No transcription found]';
  } catch (err) {
    console.error('[AI] Gemini transcription error:', err);
    return '[Transcription failed]';
  }
}

// ── Supabase Sync ─────────────────────────────────────────────────────────────
async function updateCommandCenter(text: string) {
  try {
    const fetchUrl = `${SUPABASE_URL}rest/v1/command_center?sync_key=eq.${SYNC_KEY}&select=data`;
    const res = await fetch(fetchUrl, {
      headers: { 'apikey': SUPABASE_KEY!, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });

    if (!res.ok) throw new Error(`Fetch failed: ${res.statusText}`);
    const rows = await res.json() as any[];
    
    let currentData = rows.length > 0 ? rows[0].data : { dump: [] };
    if (!currentData.dump) currentData.dump = [];

    const newItem = { id: Date.now(), text: text, done: false };
    currentData.dump = [newItem, ...currentData.dump];
    currentData.lastDate = new Date().toISOString().slice(0, 10);

    const upsertRes = await fetch(`${SUPABASE_URL}rest/v1/command_center`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY!,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({ sync_key: SYNC_KEY, data: currentData, updated_at: new Date().toISOString() })
    });

    if (!upsertRes.ok) throw new Error(`Upsert failed: ${upsertRes.statusText}`);
    console.log('[Supabase] Command Center updated');
  } catch (err) {
    console.error('[Supabase] Error:', err);
  }
}

// ── Bot Handlers ──────────────────────────────────────────────────────────────
bot.start((ctx) => ctx.reply('Command Center Brain Dump Bot is online. Send me a voice message!'));

bot.on(['voice', 'audio'], async (ctx) => {
  try {
    const voice = (ctx.message as any).voice || (ctx.message as any).audio;
    if (!voice) return;

    await ctx.reply('Processing audio...');
    const fileLink = await ctx.telegram.getFileLink(voice.file_id);
    
    const response = await axios.get(fileLink.toString(), { responseType: 'arraybuffer' });
    const audioBuffer = Buffer.from(response.data);
    
    const transcription = await transcribeAudio(audioBuffer, voice.mime_type || 'audio/ogg');
    
    if (!transcription || transcription.includes('[Transcription failed]')) {
      await ctx.reply('Could not transcribe audio.');
      return;
    }

    await updateCommandCenter(transcription);
    await ctx.reply(`Synced to Command Center:\n\n"${transcription}"`);
  } catch (err) {
    console.error('[Bot] Error:', err);
    await ctx.reply('Failed to process audio.');
  }
});

bot.launch().then(() => console.log('Bot is running...'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
