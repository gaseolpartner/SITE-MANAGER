const { createClient } = require('@supabase/supabase-js');

// 현장관리 가입 신청 알림 메일 (Resend 무료 요금제)
// 필요한 Vercel 환경변수: RESEND_API_KEY (필수), NOTIFY_EMAIL (선택, 기본 fc112@naver.com)
// 방금(30분 안) 가입한 '승인 대기' 회원이 실제로 있을 때만 보낸다 — 아무나 메일 보내기 방지
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return res.status(200).json({ ok: false, skipped: 'RESEND_API_KEY 없음' });
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res.status(200).json({ ok: false, skipped: '서버 키 없음' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const loginId = String(body.loginId || '').trim();
  if (!loginId) return res.status(400).json({ error: 'loginId 필요' });

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: u } = await db.from('site_users').select('user_id, name, department, approved, created_at').eq('user_id', loginId).maybeSingle();
  if (!u) return res.status(404).json({ error: '회원 없음' });
  if (u.approved || !u.created_at || Date.now() - new Date(u.created_at).getTime() > 30 * 60 * 1000) {
    return res.status(200).json({ ok: false, skipped: '대상 아님' });
  }

  const esc = (s) => String(s ?? '-').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const when = new Date(u.created_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  const rows = [['아이디', u.user_id], ['이름', u.name], ['소속', u.department], ['가입 시각', when]]
    .map(([k, v]) => `<tr><td style="padding:6px 12px;color:#666">${k}</td><td style="padding:6px 12px;font-weight:700">${esc(v)}</td></tr>`).join('');
  const html = `<div style="font-family:Pretendard,'Malgun Gothic',sans-serif;max-width:520px">
    <div style="background:#1B1B1B;color:#fff;padding:14px 18px;border-bottom:4px solid #F2B705;font-weight:800">가설파트너 · 현장관리</div>
    <h2 style="margin:18px 0 8px;font-size:18px">새 가입 신청이 들어왔어요</h2>
    <table style="border-collapse:collapse;font-size:14px">${rows}</table>
    <p style="margin:16px 0 0;font-size:14px">관리자로 로그인 → <b>회원관리</b>에서 승인(보기 전용/쓰기 허용)해 주세요.</p>
    <p style="margin:18px 0 0"><a href="https://site-manager-kappa.vercel.app/" style="display:inline-block;background:#F2B705;color:#1B1B1B;font-weight:800;padding:10px 16px;border-radius:8px;text-decoration:none">현장관리 열기</a></p></div>`;

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.NOTIFY_FROM || '가설파트너 알림 <onboarding@resend.dev>',
      to: [process.env.NOTIFY_EMAIL || 'fc112@naver.com'],
      subject: `[현장관리] 가입 신청 - ${u.name || ''} (${u.user_id})`,
      html,
    }),
  });
  if (!r.ok) return res.status(502).json({ ok: false, error: 'Resend ' + r.status, detail: (await r.text()).slice(0, 300) });
  return res.status(200).json({ ok: true });
};
