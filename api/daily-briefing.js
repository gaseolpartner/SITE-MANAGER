const { createClient } = require('@supabase/supabase-js');

function getKSTDateStr() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().split('T')[0];
}

function parseSqlValues(valStr) {
  const values = [];
  let current = '', inQuote = false, qChar = '';
  for (let i = 0; i < valStr.length; i++) {
    const ch = valStr[i];
    if (inQuote) {
      if (ch === qChar) {
        if (i + 1 < valStr.length && valStr[i + 1] === qChar) {
          current += qChar; i++;
        } else {
          values.push(current); current = ''; inQuote = false;
          while (i + 1 < valStr.length && (valStr[i + 1] === ',' || valStr[i + 1] === ' ')) i++;
        }
      } else current += ch;
    } else {
      if (ch === "'" || ch === '"') { inQuote = true; qChar = ch; }
      else if (ch === ',') { if (current.trim()) values.push(current.trim()); current = ''; }
      else current += ch;
    }
  }
  if (current.trim()) values.push(current.trim());
  return values;
}

async function callGemini(prompt, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 4096 }
    })
  });
  const json = await res.json();
  if (!res.ok) throw new Error('Gemini API: ' + JSON.stringify(json));
  const text = json.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('\n') || '';
  if (!text) throw new Error('Empty Gemini response: ' + JSON.stringify(json));
  return text;
}

module.exports = async (req, res) => {
  const isTest = req.query && req.query.test === '1';
  const cronSecret = process.env.CRON_SECRET;
  if (!isTest && cronSecret && req.headers['authorization'] !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_KEY, GEMINI_API_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !GEMINI_API_KEY) {
    return res.status(500).json({ error: 'Missing env vars', need: ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'GEMINI_API_KEY'] });
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const { data: salesPlan, error: spError } = await supabase.from('sales_plan').select('*');
    if (spError) throw spError;

    const today = getKSTDateStr();
    const [y, m, d] = today.split('-');
    const headerDate = `${y}.${m}.${d}`;

    const contextRows = (salesPlan || []).slice(0, 40).map(s => ({
      site: s.site_name,
      company: s.construction_company,
      region: s.region,
      scale: s.scale,
      memo: (s.memo || '').substring(0, 120)
    }));

    const prompt = `오늘 날짜: ${headerDate}

건설 및 골조(철콘) 수주 브리핑 생성.
[수주 현황] 최근 7일 누적 데이터 반영 (오늘 수주는 [NEW], 변동은 [UPDATE])
[골조 타깃 분석] 시평 순위 및 파트너 노트 참고 매칭
[데이터 관리] 파트너 변동 사항 체크

[필수 형식]
- 반드시 첫 줄에 "🏗️ 일일 브리핑 (${headerDate})"
- 각 섹션/항목 사이에 반드시 줄바꿈(\\n) 삽입 (한 덩어리 금지)
- 섹션: 1. [수주 현황], 2. [골조 타깃 분석], 3. [데이터 관리]
- 브리핑 본문 뒤에 반드시 "💾 [DB 업로드용]" 마커 넣고 SQL 작성
- SQL 스키마 (sales_plan): category, region, site_name, section, construction_company, scale, memo
- 신규 현장은 INSERT, 기존 현장 변동은 UPDATE
- INSERT 블록 마지막에 "ON CONFLICT (site_name) DO UPDATE SET memo = EXCLUDED.memo;" 포함

현재 DB에 등록된 sales_plan 항목 (총 ${(salesPlan || []).length}건 중 최대 40건):
${JSON.stringify(contextRows, null, 2)}

위 데이터와 최신 국내 건설/수주 뉴스(Google Search)를 참고하여 브리핑을 작성하세요.`;

    const fullText = await callGemini(prompt, GEMINI_API_KEY);

    const sqlIdx = fullText.search(/💾\s*\[DB\s*업로드용\]/);
    let briefingText = sqlIdx > 0 ? fullText.substring(0, sqlIdx).trim() : fullText;
    briefingText = briefingText
      .replace(/INSERT\s+INTO\s+[\s\S]*?;\s*/gi, '')
      .replace(/UPDATE\s+\w+\s+SET\s+[\s\S]*?;\s*/gi, '')
      .replace(/ON\s+CONFLICT[\s\S]*?;\s*/gi, '')
      .replace(/```sql[\s\S]*?```/gi, '')
      .replace(/```[\s\S]*?```/gi, '')
      .trim();

    const result = { date: today, briefing_saved: false, updates: 0, update_fails: [], inserts: 0, upserts: 0, insert_fails: [] };

    if (briefingText.length > 50) {
      const { error: brErr } = await supabase.from('briefings').upsert({
        date: today,
        raw_content: briefingText,
        updated_at: new Date().toISOString()
      }, { onConflict: 'date' });
      if (brErr) throw brErr;
      result.briefing_saved = true;
    }

    const updateRegex = /UPDATE\s+(\w+)\s+SET\s+(\w+)\s*=\s*'((?:[^']|'')*)'\s*WHERE\s+(\w+)\s*=\s*'((?:[^']|'')*)'\s*;/gi;
    let m;
    while ((m = updateRegex.exec(fullText)) !== null) {
      const table = m[1], setCol = m[2], setVal = m[3].replace(/''/g, "'"), whereCol = m[4], whereVal = m[5].replace(/''/g, "'");
      try {
        const { data, error } = await supabase.from(table).update({ [setCol]: setVal }).eq(whereCol, whereVal).select();
        if (error) throw error;
        if (data && data.length > 0) result.updates++;
        else result.update_fails.push(whereVal);
      } catch (e) {
        result.update_fails.push(whereVal + ': ' + (e.message || e));
      }
    }

    const conflictMatch = fullText.match(/ON\s+CONFLICT\s*\((\w+)\)/i);
    const onConflictCol = conflictMatch ? conflictMatch[1] : 'site_name';
    const cleaned = fullText.replace(/\)\s*ON\s+CONFLICT\s*\([^)]*\)\s*DO\s+UPDATE\s+SET\s+[^;]*/gi, ')');

    const insertRegex = /INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s+([\s\S]+?)\s*;/gi;
    let ins;
    while ((ins = insertRegex.exec(cleaned)) !== null) {
      const table = ins[1];
      const columns = ins[2].split(',').map(c => c.trim().replace(/["`]/g, ''));
      const allValuesStr = ins[3].trim().replace(/;$/, '').trim();

      const valueRows = [];
      let depth = 0, current = '', inQuote = false, qChar = '';
      for (let i = 0; i < allValuesStr.length; i++) {
        const ch = allValuesStr[i];
        if (inQuote) {
          current += ch;
          if (ch === qChar) {
            if (i + 1 < allValuesStr.length && allValuesStr[i + 1] === qChar) current += allValuesStr[++i];
            else inQuote = false;
          }
        } else if (ch === "'" || ch === '"') { inQuote = true; qChar = ch; current += ch; }
        else if (ch === '(') { if (depth === 0) current = ''; else current += ch; depth++; }
        else if (ch === ')') { depth--; if (depth === 0) valueRows.push(current); else current += ch; }
        else if (depth > 0) current += ch;
      }

      for (const valStr of valueRows) {
        const values = parseSqlValues(valStr);
        if (columns.length !== values.length) continue;
        const row = {};
        columns.forEach((col, idx) => {
          let v = values[idx];
          if (v && v.toUpperCase && v.toUpperCase() === 'NULL') v = null;
          row[col] = v;
        });
        delete row.id; delete row.created_at; delete row.updated_at; delete row.assigned_user; delete row.assigned_at;

        try {
          if (onConflictCol && row[onConflictCol]) {
            const { data: existing } = await supabase.from(table).select('id').eq(onConflictCol, row[onConflictCol]).maybeSingle();
            if (existing) {
              const upd = { ...row }; delete upd[onConflictCol];
              const { error } = await supabase.from(table).update(upd).eq(onConflictCol, row[onConflictCol]);
              if (error) throw error;
              result.upserts++;
            } else {
              const { error } = await supabase.from(table).insert([row]);
              if (error) throw error;
              result.inserts++;
            }
          } else {
            const { error } = await supabase.from(table).insert([row]);
            if (error) throw error;
            result.inserts++;
          }
        } catch (e) {
          result.insert_fails.push((row.site_name || 'unknown') + ': ' + (e.message || e));
        }
      }
    }

    return res.status(200).json({ ok: true, ...result, gemini_length: fullText.length });
  } catch (e) {
    return res.status(500).json({ error: e.message, stack: e.stack });
  }
};
