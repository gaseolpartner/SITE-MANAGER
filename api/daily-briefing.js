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
      generationConfig: { temperature: 0.7, maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 0 } }
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

    // 7일 전 날짜 계산 (자동 삭제 기준)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const cutoffDate = sevenDaysAgo.toISOString().split('T')[0];

    const prompt = `당신은 건설/골조(철콘) 수주 브리핑 전문 분석가입니다.
오늘 날짜: ${headerDate} (KST)

# 작업
오늘자 국내 건설/수주 뉴스를 Google Search로 폭넓게 조사하여, 아래 EXACT 형식으로 일일 브리핑을 작성하세요.
**상세하게**, **풍부하게**, **여러 항목**을 포함해야 합니다. 짧은 답변은 거부됩니다.

# 작성 규칙
1. **[수주 현황]**: 최근 7일 누적. 오늘 신규 수주는 [NEW], 동향/변동 있는 기존 수주는 [UPDATE]. 각 항목은 반드시 줄바꿈으로 구분. 최소 8건 이상 포함.
2. **[골조 타깃 분석]**: 주요 신규 수주 건마다 시평 순위가 높은 철콘/골조 협력사를 매칭하여 추천. 각 사이트별 핵심 시공 포인트 명시.
3. **[데이터 관리]**: 원청사별 골조 파트너 목록 변동 사항. 없으면 "특이사항 없음" 명시.

# 형식 (반드시 이 구조 그대로)
\`\`\`
🏗️ 일일 브리핑 (${headerDate})

[수주 현황]
[NEW] <지역> <현장명> (<원청사>) - <날짜> [확정]
상태: <한 줄 요약>
규모: 약 <금액>억 원.

[NEW] <지역> <현장명> (<원청사>) - <날짜> [확정]
상태: <한 줄 요약>
규모: 약 <금액>억 원.

[UPDATE] <지역> <현장명> (<원청사>) - <날짜> [확정/동향]
상태: <변동 사항 요약>

(...최소 8건 이상)

(※ ${cutoffDate} 이전 데이터는 7일 경과 규칙에 따라 자동 삭제됩니다.)

[골조 타깃 분석]
<현장명> (<원청사>): <시공 특성 분석>. <추천 협력사>이(가) 유력합니다. <핵심 공법/장비 제안>.

<현장명> (<원청사>): <분석>. <추천>. <제안>.

(...주요 신규 건마다)

[데이터 관리]
<특이사항 또는 "특이사항 없음">

💾 [DB 업로드용]
UPDATE sales_plan SET memo = '[UPDATE] M/D <변동내용>' WHERE site_name = '<기존 현장명>';
INSERT INTO sales_plan (category, region, site_name, section, construction_company, scale, contract_date, memo) VALUES ('<건축/플랜트/토목>', '<지역>', '<현장명>', '<섹션>', '<원청사>', '<규모>', '${today}', '[수주] M/D 확정 [Hint: <제안내용>]') ON CONFLICT (site_name) DO UPDATE SET memo = EXCLUDED.memo;
(...신규 항목마다)
DELETE FROM sales_plan WHERE contract_date < '${cutoffDate}';
\`\`\`

# DB 컬럼 (sales_plan)
- category (건축/플랜트/토목/기타)
- region (서울/경기/인천/부산/...)
- site_name (반드시 UNIQUE)
- section (재건축/재개발/공공주택/일반건축/정비사업/에너지 등)
- construction_company (원청사)
- scale (예: '9,709억')
- contract_date (YYYY-MM-DD)
- memo

# 현재 DB에 등록된 sales_plan (최대 40건 미리보기)
${JSON.stringify(contextRows, null, 2)}

위 데이터를 참고하되, 오늘자 최신 뉴스(Google Search)에서 발굴한 신규 수주 건을 반드시 포함하세요.
이메일/리포트로 받는 수준의 **전문적인 분석 리포트**를 작성하세요.`;

    const fullText = await callGemini(prompt, GEMINI_API_KEY);

    const sqlIdx = fullText.search(/💾\s*\[DB\s*업로드용\]/);
    let briefingText = sqlIdx > 0 ? fullText.substring(0, sqlIdx).trim() : fullText;
    briefingText = briefingText
      .replace(/INSERT\s+INTO\s+[\s\S]*?;\s*/gi, '')
      .replace(/UPDATE\s+\w+\s+SET\s+[\s\S]*?;\s*/gi, '')
      .replace(/DELETE\s+FROM\s+[\s\S]*?;\s*/gi, '')
      .replace(/ON\s+CONFLICT[\s\S]*?;\s*/gi, '')
      .replace(/COMMIT\s*;?/gi, '')
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

    // DELETE 처리 (7일 경과 데이터 자동 정리)
    // 안전: contract_date < 'YYYY-MM-DD' 패턴만 허용 (DROP/TRUNCATE 등은 무시)
    result.deleted = 0;
    result.delete_fails = [];
    const deleteRegex = /DELETE\s+FROM\s+(\w+)\s+WHERE\s+(\w+)\s*<\s*'(\d{4}-\d{2}-\d{2})'\s*;/gi;
    let del;
    while ((del = deleteRegex.exec(fullText)) !== null) {
      const table = del[1], col = del[2], dateVal = del[3];
      // 안전 가드: sales_plan + 날짜 컬럼만 허용
      if (table !== 'sales_plan' || !/date/i.test(col)) {
        result.delete_fails.push(`skip ${table}.${col} (safety guard)`);
        continue;
      }
      try {
        const { data, error } = await supabase.from(table).delete().lt(col, dateVal).select('id');
        if (error) throw error;
        result.deleted += (data ? data.length : 0);
      } catch (e) {
        result.delete_fails.push(`${table}.${col}<${dateVal}: ` + (e.message || e));
      }
    }

    return res.status(200).json({ ok: true, ...result, gemini_length: fullText.length });
  } catch (e) {
    return res.status(500).json({ error: e.message, stack: e.stack });
  }
};
