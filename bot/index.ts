import 'dotenv/config';
import { Telegraf, Context } from 'telegraf';
import axios from 'axios';

const TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SYNC_KEY = process.env.CC_SYNC_KEY?.trim().toLowerCase().replace(/\s+/g, "-");

if (!TOKEN || !GEMINI_API_KEY || !SUPABASE_URL || !SUPABASE_KEY || !SYNC_KEY) {
  console.error('[Config] Missing env vars:', { TOKEN: !!TOKEN, GEMINI_API_KEY: !!GEMINI_API_KEY, SUPABASE_URL: !!SUPABASE_URL, SUPABASE_KEY: !!SUPABASE_KEY, SYNC_KEY: !!SYNC_KEY });
  throw new Error('Missing environment variables in .env');
}

const bot = new Telegraf(TOKEN);

// ── Gemini Intent Routing ───────────────────────────────────────────────────
interface AIIntent {
  transcription: string;
  type: 'priority' | 'dump' | 'schedule';
  priorityIndex?: number; // 1, 2, or 3
  schedule?: {
    start: string; // HH:MM
    end: string;   // HH:MM
    label: string;
  };
}

async function processAudioIntent(audioBuffer: Buffer, mimeType: string): Promise<AIIntent> {
  console.log(`[AI] Processing intent for ${audioBuffer.length} bytes...`);
  try {
    const base64Audio = audioBuffer.toString('base64');
    const prompt = `
      Transcribe this audio and determine the user's intent for their Command Center app.
      
      Categories:
      1. "priority": For core tasks (The Big 3). Look for "priority 1", "top priority", or "first thing".
      2. "schedule": For time-blocked events. Look for times like "at 2pm" or "from 5 to 6".
      3. "dump": Default for general thoughts, notes, or tasks without a specific time or priority rank.

      Return ONLY a raw JSON object (no markdown, no code blocks):
      {
        "transcription": "exact transcription",
        "type": "priority" | "schedule" | "dump",
        "priorityIndex": 1, 2, or 3 (only if type is priority),
        "schedule": { "start": "HH:MM", "end": "HH:MM", "label": "short label" } (only if type is schedule)
      }
    `;

    const body = {
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mimeType, data: base64Audio } }
        ]
      }]
    };

    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`Gemini Error: ${res.status}`);

    const data = await res.json() as any;
    let text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    
    // Clean up potential markdown formatting if the model ignored "no markdown" instruction
    text = text.replace(/```json/g, '').replace(/```/g, '').trim();
    
    const parsed = JSON.parse(text) as AIIntent;
    console.log('[AI] Intent Parsed:', parsed.type, '-', parsed.transcription);
    return parsed;
  } catch (err) {
    console.error('[AI] Error:', err);
    // Fallback to simple dump
    return { transcription: '[Error processing intent]', type: 'dump' };
  }
}

// ── Supabase Sync ─────────────────────────────────────────────────────────────
async function updateCommandCenter(intent: AIIntent) {
  console.log(`[Supabase] Routing ${intent.type} for key: ${SYNC_KEY}...`);
  try {
    const fetchUrl = `${SUPABASE_URL}rest/v1/command_center?sync_key=eq.${SYNC_KEY}&order=updated_at.desc`;
    const res = await fetch(fetchUrl, {
      headers: { 'apikey': SUPABASE_KEY!, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });

    if (!res.ok) throw new Error(`Fetch failed: ${res.statusText}`);
    const rows = await res.json() as any[];
    console.log(`[Supabase] Found ${rows.length} rows.`);
    
    // Take the newest row, or create default
    let currentData = rows.length > 0 ? rows[0].data : {
      priorities: [{id:1,text:"",done:false},{id:2,text:"",done:false},{id:3,text:"",done:false}],
      dump: [],
      blocks: [],
      lastDate: new Date().toISOString().slice(0, 10)
    };

    const today = new Date().toISOString().slice(0, 10);
    
    // Ensure priorities array exists and has 3 slots
    if (!currentData.priorities || !Array.isArray(currentData.priorities)) {
      currentData.priorities = [{id:1,text:"",done:false},{id:2,text:"",done:false},{id:3,text:"",done:false}];
    }
    while (currentData.priorities.length < 3) {
      currentData.priorities.push({id: currentData.priorities.length + 1, text: "", done: false});
    }

    // Reset priorities if it's a new day
    if (currentData.lastDate !== today) {
      console.log('[Supabase] New day detected, resetting priorities.');
      currentData.priorities = currentData.priorities.map((p: any, i: number) => ({ id: i + 1, text: "", done: false }));
      currentData.lastDate = today;
    }

    if (intent.type === 'priority') {
      const idx = Math.min(3, Math.max(1, intent.priorityIndex || 1)) - 1;
      console.log(`[Supabase] Updating Priority ${idx + 1} with: ${intent.transcription}`);
      currentData.priorities[idx] = { id: idx + 1, text: intent.transcription, done: false };
    } 
    else if (intent.type === 'schedule' && intent.schedule) {
      const newBlock = {
        id: Date.now(),
        label: intent.schedule.label,
        start: intent.schedule.start,
        end: intent.schedule.end,
        color: '#a07ec8'
      };
      currentData.blocks = [...(currentData.blocks || []), newBlock];
    }
    else {
      const newItem = { id: Date.now(), text: intent.transcription, done: false };
      currentData.dump = [newItem, ...(currentData.dump || [])];
    }

    // Always use the newest row's ID if it exists to overwrite it, otherwise it creates a new one
    const payload: any = { sync_key: SYNC_KEY, data: currentData, updated_at: new Date().toISOString() };
    
    const upsertRes = await fetch(`${SUPABASE_URL}rest/v1/command_center`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY!,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify(payload)
    });

    if (!upsertRes.ok) throw new Error(`Upsert failed: ${upsertRes.statusText}`);
    console.log('[Supabase] SUCCESS: Data synced and routed.');
  } catch (err) {
    console.error('[Supabase] CRITICAL ERROR:', err);
    throw err;
  }
}

// ── Bot Handlers ──────────────────────────────────────────────────────────────
bot.start((ctx) => ctx.reply(`Command Center Brain is Online.\nKey: ${SYNC_KEY}\n\nTry saying:\n- "Priority 1: Finish the design"\n- "Schedule deep work from 2 to 4"\n- "Remember to buy eggs"`));

bot.on(['voice', 'audio'], async (ctx) => {
  try {
    const voice = (ctx.message as any).voice || (ctx.message as any).audio;
    if (!voice) return;

    await ctx.reply('🧠 Thinking...');
    const fileLink = await ctx.telegram.getFileLink(voice.file_id);
    
    const response = await axios.get(fileLink.toString(), { responseType: 'arraybuffer' });
    const audioBuffer = Buffer.from(response.data);
    
    const intent = await processAudioIntent(audioBuffer, voice.mime_type || 'audio/ogg');
    
    if (intent.transcription.startsWith('[')) {
      await ctx.reply('❌ Could not understand the audio.');
      return;
    }

    await updateCommandCenter(intent);

    let feedback = `✅ Routed to ${intent.type.toUpperCase()}:\n\n"${intent.transcription}"`;
    if (intent.type === 'schedule' && intent.schedule) {
      feedback += `\n⏰ ${intent.schedule.start} - ${intent.schedule.end}`;
    }
    await ctx.reply(feedback);
  } catch (err) {
    console.error('[Bot] Error:', err);
    await ctx.reply('❌ System error occurred.');
  }
});

bot.launch().then(() => console.log('Bot is running...'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
