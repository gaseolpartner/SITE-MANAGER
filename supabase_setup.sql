-- ============================================
-- 현장관리 시스템 - Supabase 테이블 설정
-- ============================================

-- 1. 사용자 테이블
CREATE TABLE users (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id VARCHAR(50) UNIQUE NOT NULL,
    password VARCHAR(100) NOT NULL,
    name VARCHAR(50) NOT NULL,
    role VARCHAR(20) DEFAULT 'user',
    department VARCHAR(50) DEFAULT '미지정',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 기본 관리자 계정 추가
INSERT INTO users (user_id, password, name, role, department)
VALUES ('baekop99', 'tjdgns87a', '관리자', 'admin', '시스템관리');

-- 2. 브리핑 테이블 (핵심!)
CREATE TABLE briefings (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    date DATE UNIQUE NOT NULL,
    raw_content TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. 현장 테이블
CREATE TABLE sites (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    company_type VARCHAR(20) NOT NULL, -- 'concrete' or 'stone'
    company_name VARCHAR(100) NOT NULL,
    site_name VARCHAR(200) NOT NULL,
    address VARCHAR(300),
    manager VARCHAR(50),
    phone VARCHAR(50),
    amount VARCHAR(50),
    progress INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'active', -- active, pending, completed
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. 업체 상태 테이블 (거래중 여부)
CREATE TABLE company_status (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    company_type VARCHAR(20) NOT NULL, -- 'concrete' or 'stone'
    company_name VARCHAR(100) NOT NULL,
    status VARCHAR(20) DEFAULT '-',
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(company_type, company_name)
);

-- ============================================
-- RLS (Row Level Security) 정책
-- ============================================

-- RLS 활성화
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE briefings ENABLE ROW LEVEL SECURITY;
ALTER TABLE sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_status ENABLE ROW LEVEL SECURITY;

-- 모든 인증된 사용자가 읽기/쓰기 가능 (간단한 정책)
-- 실제 운영시에는 더 세밀한 정책 필요

CREATE POLICY "Allow all for users" ON users
    FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow all for briefings" ON briefings
    FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow all for sites" ON sites
    FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow all for company_status" ON company_status
    FOR ALL USING (true) WITH CHECK (true);

-- ============================================
-- 인덱스 (성능 최적화)
-- ============================================

CREATE INDEX idx_briefings_date ON briefings(date DESC);
CREATE INDEX idx_sites_company ON sites(company_type, company_name);
CREATE INDEX idx_sites_status ON sites(status);

-- ============================================
-- Make.com Webhook용 함수 (브리핑 자동 저장)
-- ============================================

-- 브리핑 upsert 함수 (있으면 업데이트, 없으면 생성)
CREATE OR REPLACE FUNCTION upsert_briefing(
    p_date DATE,
    p_content TEXT
)
RETURNS JSON AS $$
DECLARE
    result JSON;
BEGIN
    INSERT INTO briefings (date, raw_content, updated_at)
    VALUES (p_date, p_content, NOW())
    ON CONFLICT (date) 
    DO UPDATE SET 
        raw_content = p_content,
        updated_at = NOW()
    RETURNING json_build_object(
        'id', id,
        'date', date,
        'created_at', created_at,
        'updated_at', updated_at
    ) INTO result;
    
    RETURN result;
END;
$$ LANGUAGE plpgsql;
