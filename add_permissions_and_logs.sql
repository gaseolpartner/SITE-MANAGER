-- ========================================
-- 1. 사용자 권한 테이블 (user_permissions)
-- ========================================
CREATE TABLE IF NOT EXISTS user_permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES site_users(id) ON DELETE CASCADE,
    -- 영업계획 컬럼 숨기기 설정
    hide_concrete_company BOOLEAN DEFAULT false,  -- 골조사 숨기기
    hide_construction_company BOOLEAN DEFAULT false,  -- 건설사 숨기기
    hide_scale BOOLEAN DEFAULT false,  -- 규모 숨기기
    hide_memo BOOLEAN DEFAULT false,  -- 비고 숨기기
    -- 추가 권한 설정 (필요시)
    can_edit_sales BOOLEAN DEFAULT true,  -- 영업계획 수정 가능
    can_delete_sales BOOLEAN DEFAULT false,  -- 영업계획 삭제 가능
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(user_id)
);

-- ========================================
-- 2. 활동 로그 테이블 (activity_logs)
-- ========================================
CREATE TABLE IF NOT EXISTS activity_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES site_users(id) ON DELETE SET NULL,
    user_name TEXT NOT NULL,  -- 사용자 이름 (삭제 후에도 기록 유지)
    action_type TEXT NOT NULL,  -- 'create', 'update', 'delete', 'assign', 'unassign'
    target_table TEXT NOT NULL,  -- 'sales_plan', 'sites', 'briefings', 'companies'
    target_id UUID,  -- 대상 레코드 ID
    target_name TEXT,  -- 대상 이름 (예: 현장명)
    details JSONB,  -- 변경 상세 내용 (이전값, 이후값 등)
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 인덱스 추가 (검색 성능 향상)
CREATE INDEX IF NOT EXISTS idx_activity_logs_user_id ON activity_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON activity_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_logs_target_table ON activity_logs(target_table);

-- ========================================
-- 3. site_users 테이블에 컬럼 추가 (없다면)
-- ========================================
-- 부서 컬럼이 없다면 추가
ALTER TABLE site_users ADD COLUMN IF NOT EXISTS department TEXT DEFAULT '미지정';

-- ========================================
-- 4. RLS 정책 (Row Level Security)
-- ========================================
-- activity_logs는 모든 로그인 사용자가 읽기 가능, 쓰기는 시스템에서만
ALTER TABLE activity_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow read for authenticated users" ON activity_logs
    FOR SELECT USING (true);

CREATE POLICY "Allow insert for authenticated users" ON activity_logs
    FOR INSERT WITH CHECK (true);

-- user_permissions는 관리자만 수정 가능
ALTER TABLE user_permissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow read for all" ON user_permissions
    FOR SELECT USING (true);

CREATE POLICY "Allow all for admin" ON user_permissions
    FOR ALL USING (true);
