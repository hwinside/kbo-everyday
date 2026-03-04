import { spawn } from 'child_process';
import WebSocket from 'ws';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9335;

const TEAMS = [
  'LG 트윈스', '두산 베어스', 'KT 위즈', 'SSG 랜더스', 'NC 다이노스',
  'KIA 타이거즈', '롯데 자이언츠', '삼성 라이온즈', '한화 이글스', '키움 히어로즈'
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

const proc = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=/tmp/chrome-cheer5',
  'about:blank'
], { stdio: 'ignore' });

await sleep(3000);

const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
const tabs = await res.json();
const ws = new WebSocket(tabs[0].webSocketDebuggerUrl);

let msgId = 1;
const pending = new Map();
ws.on('message', d => {
  const msg = JSON.parse(d);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = msgId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout')); }, 15000);
    pending.set(id, msg => { clearTimeout(timer); resolve(msg); });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await new Promise(r => ws.on('open', r));
await send('Page.enable');

const allSongs = {};

for (const team of TEAMS) {
  const url = `https://namu.wiki/w/${encodeURIComponent(team + '/응원가')}`;
  console.error(`\n=== ${team} ===`);
  
  try {
    await send('Page.navigate', { url });
    await sleep(6000);
    
    const resp = await send('Runtime.evaluate', {
      expression: `
        (() => {
          try {
            const text = document.body.innerText || '';
            const lines = text.split('\\n').map(l => l.trim()).filter(l => l);
            let inSection = false;
            let songs = [];
            let currentName = '';
            let currentLyrics = [];
            
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i];
              
              if ((line.includes('선수 응원가') || line.includes('선수별 응원가')) && !line.includes('이전')) {
                inSection = true;
                continue;
              }
              
              if (inSection && (line === '응원 문화' || line === '여담' || line === '관련 문서')) {
                if (currentName && currentLyrics.length > 0) {
                  songs.push({ name: currentName, lyrics: currentLyrics.join('\\n') });
                }
                inSection = false;
                continue;
              }
              
              if (!inSection) continue;
              
              const cleaned = line.replace(/\\[편집\\]/g, '').trim();
              if (!cleaned) continue;
              
              // 선수명 패턴
              const nameMatch = cleaned.match(/^(?:\\d+\\.\\d+\\.?\\s*)?([가-힣]{2,4})$/);
              const nameMatch2 = cleaned.match(/^([가-힣]{2,6})\\s*\\(/);
              
              if (nameMatch || nameMatch2) {
                if (currentName && currentLyrics.length > 0) {
                  songs.push({ name: currentName, lyrics: currentLyrics.join('\\n').substring(0, 2000) });
                }
                currentName = (nameMatch ? nameMatch[1] : nameMatch2[1]).trim();
                currentLyrics = [];
              } else if (currentName) {
                if (cleaned.startsWith('파일:') || cleaned.startsWith('http') || 
                    cleaned === '[편집]' || cleaned.length <= 1) continue;
                currentLyrics.push(cleaned);
              }
            }
            
            if (currentName && currentLyrics.length > 0) {
              songs.push({ name: currentName, lyrics: currentLyrics.join('\\n').substring(0, 2000) });
            }
            
            return JSON.stringify({ songs, totalLines: lines.length });
          } catch(e) {
            return JSON.stringify({ error: e.message, songs: [] });
          }
        })()
      `,
      returnByValue: true
    });
    
    const data = JSON.parse(resp.result.result.value);
    allSongs[team] = data.songs || [];
    console.error(`  Found: ${data.songs?.length || 0} songs`);
    for (const s of (data.songs || []).slice(0, 3)) {
      console.error(`  - ${s.name}: ${s.lyrics.substring(0, 60)}...`);
    }
  } catch (e) {
    console.error(`  Error: ${e.message}`);
    allSongs[team] = [];
  }
}

console.log(JSON.stringify(allSongs, null, 2));
proc.kill();
process.exit(0);
